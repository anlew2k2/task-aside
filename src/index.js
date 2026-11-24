import { createHealthHandler } from "./handlers/health.handler.js";
import { createTaskHandler } from "./handlers/task.handler.js";
import { createTaskRepository } from "./repositories/task.repository.js";
import { createCloudflareQueueService } from "./services/queue.service.js";
import { createHttpTransport } from "./transports/http.js";
import { createMcpTransport } from "./transports/mcp.js";
import { createWorkerTransport } from "./transports/worker.js";
import { createTaskUsecase } from "./usecases/task.usecase.js";
import {
  readCloudflareQueueConfig,
  readFeatureFlags,
  readLogConfig,
  readServerConfig,
} from "./utilities/env.js";
import { ConfigError } from "./utilities/errors.js";
import { createFileLogger } from "./utilities/logger.js";
import { getPackageInfo } from "./utilities/package-info.js";

/**
 * Composition root: wires repositories -> services -> usecases -> handlers -> transports.
 */
export async function startApp({
  host = undefined,
  port = undefined,
  installSignalHandlers = true,
  env = process.env,
  queueService = null,
  taskRepository = null,
  executeTask = undefined,
  workerIntervalMs = 1_000,
  mockDelayMs = 5_000,
  logger = undefined,
  enableHttp = undefined,
  enableMcp = undefined,
  enableWorker = undefined,
  startWorker = undefined,
} = {}) {
  const appInfo = getPackageInfo();

  const envFlags = readFeatureFlags(env);
  const resolvedEnableHttp = enableHttp ?? envFlags.enableHttp;
  const resolvedEnableMcp = enableMcp ?? envFlags.enableMcp;
  const resolvedEnableWorker = enableWorker ?? startWorker ?? envFlags.enableWorker;

  if (!resolvedEnableHttp && !resolvedEnableMcp && !resolvedEnableWorker) {
    throw new ConfigError(
      "At least one of ENABLE_HTTP, ENABLE_MCP, or ENABLE_WORKER must be enabled",
    );
  }

  let resolvedLogger = logger;
  let ownsLogger = false;
  let logDir = null;
  if (!resolvedLogger) {
    ({ dir: logDir } = readLogConfig(env));
    resolvedLogger = createFileLogger({ dir: logDir });
    ownsLogger = true;
  }

  const transports = {
    http: resolvedEnableHttp,
    mcp: resolvedEnableMcp,
    worker: resolvedEnableWorker,
  };

  const resolvedTaskRepository = taskRepository ?? createTaskRepository();
  const resolvedQueueService =
    queueService ?? createCloudflareQueueService(readCloudflareQueueConfig(env));

  const taskUsecase = createTaskUsecase({
    taskRepository: resolvedTaskRepository,
    queueService: resolvedQueueService,
    executeTask,
    mockDelayMs,
    logger: resolvedLogger,
  });

  const taskHandler = createTaskHandler({ taskUsecase });
  const healthHandler = createHealthHandler({ taskUsecase, appInfo });

  const workerTransport = createWorkerTransport({
    taskHandler,
    intervalMs: workerIntervalMs,
    logger: resolvedLogger,
  });
  const getWorkerStatus = () => workerTransport.status();

  const mcpTransport = resolvedEnableMcp
    ? createMcpTransport({
        taskHandler,
        version: appInfo.version,
        logger: resolvedLogger,
      })
    : null;

  const shouldStartHttpServer = resolvedEnableHttp || resolvedEnableMcp;
  const httpTransport = shouldStartHttpServer
    ? createHttpTransport({
        healthHandler,
        taskHandler,
        mcpTransport,
        enableHttp: resolvedEnableHttp,
        enableMcp: resolvedEnableMcp,
        getWorkerStatus,
        transports,
        logger: resolvedLogger,
      })
    : null;

  if (resolvedEnableWorker) {
    workerTransport.start();
  }

  let binding = { host: null, port: null, url: null };
  if (httpTransport) {
    const serverConfig = readServerConfig(env);
    const resolvedHost = host ?? serverConfig.host;
    const resolvedPort = port ?? serverConfig.port;
    try {
      binding = await httpTransport.listen({ host: resolvedHost, port: resolvedPort });
    } catch (error) {
      await workerTransport.stop();
      if (ownsLogger) {
        await resolvedLogger.close?.();
      }
      throw error;
    }
  }

  resolvedLogger.log(`${appInfo.name} v${appInfo.version} ready`);
  resolvedLogger.log(`HTTP:   ${resolvedEnableHttp ? `${binding.url}/tasks` : "disabled"}`);
  resolvedLogger.log(`MCP:    ${resolvedEnableMcp ? `${binding.url}/mcp` : "disabled"}`);
  if (binding.url) {
    resolvedLogger.log(`Health: ${binding.url}/health`);
  }
  resolvedLogger.log(`Worker: ${resolvedEnableWorker ? "running" : "disabled"}`);
  if (ownsLogger && resolvedLogger.getCurrentLogFile) {
    resolvedLogger.log(`Logs:   ${resolvedLogger.getCurrentLogFile()}`);
  }

  let stopping = false;
  let stopPromise = null;

  async function stop() {
    if (stopping) {
      return stopPromise;
    }
    stopping = true;
    stopPromise = (async () => {
      if (httpTransport) {
        await httpTransport.close();
      }
      await workerTransport.stop();
      if (ownsLogger) {
        await resolvedLogger.close?.();
      }
    })();
    return stopPromise;
  }

  if (installSignalHandlers) {
    const shutdown = () => {
      void stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  return {
    ...binding,
    logDir,
    transports,
    workerTransport,
    httpTransport,
    stop,
  };
}
