import { createHealthHandler } from "./handlers/health.handler.js";
import { createTaskHandler } from "./handlers/task.handler.js";
import { createSupabaseTaskRepository } from "./repositories/task.repository.js";
import { createAgentService } from "./services/agent.service.js";
import { createHttpTransport } from "./transports/http.js";
import { createMcpTransport } from "./transports/mcp.js";
import { createWorkerTransport } from "./transports/worker.js";
import { createTaskUsecase } from "./usecases/task.usecase.js";
import { ConfigError } from "./utilities/errors.js";
import { createFileLogger } from "./utilities/logger.js";
import { getPackageInfo } from "./utilities/package-info.js";
import { loadSettings, validateSettings } from "./utilities/settings.js";

/**
 * Composition root: wires settings -> repositories -> services -> usecases -> handlers -> transports.
 */
export async function startApp({
  configPath = undefined,
  settings = undefined,
  host = undefined,
  port = undefined,
  installSignalHandlers = true,
  taskRepository = null,
  agentService = null,
  executeTask = undefined,
  workerIntervalMs = undefined,
  logger = undefined,
  enableHttp = undefined,
  enableMcp = undefined,
  enableWorker = undefined,
  startWorker = undefined,
} = {}) {
  const appInfo = getPackageInfo();

  let resolvedSettings;
  let settingsPath = null;
  let settingsCreated = false;

  if (settings !== undefined) {
    resolvedSettings = validateSettings(settings, {
      requireSupabase: !taskRepository,
    });
  } else {
    const loaded = loadSettings({
      configPath,
      requireSupabase: !taskRepository,
    });
    resolvedSettings = loaded.settings;
    settingsPath = loaded.path;
    settingsCreated = loaded.created;
  }

  const resolvedEnableHttp = enableHttp ?? resolvedSettings.transports.http;
  const resolvedEnableMcp = enableMcp ?? resolvedSettings.transports.mcp;
  const resolvedEnableWorker =
    enableWorker ?? startWorker ?? resolvedSettings.transports.worker;

  if (!resolvedEnableHttp && !resolvedEnableMcp && !resolvedEnableWorker) {
    throw new ConfigError(
      "At least one of transports.http, transports.mcp, or transports.worker must be enabled",
    );
  }

  let resolvedLogger = logger;
  let ownsLogger = false;
  const logDir = resolvedSettings.logging.dir;
  if (!resolvedLogger) {
    resolvedLogger = createFileLogger({ dir: logDir });
    ownsLogger = true;
  }

  const transports = {
    http: resolvedEnableHttp,
    mcp: resolvedEnableMcp,
    worker: resolvedEnableWorker,
  };

  const resolvedTaskRepository =
    taskRepository ??
    createSupabaseTaskRepository({
      url: resolvedSettings.supabase.url,
      publishableKey: resolvedSettings.supabase.publishable_key,
      schema: resolvedSettings.supabase.schema,
      table: resolvedSettings.supabase.table,
    });

  const resolvedAgentService =
    agentService ??
    createAgentService({
      workerConfig: resolvedSettings.worker,
      logger: resolvedLogger,
    });

  const taskUsecase = createTaskUsecase({
    taskRepository: resolvedTaskRepository,
    agentService: resolvedAgentService,
    executeTask,
    workerConfig: resolvedSettings.worker,
    logger: resolvedLogger,
  });

  const taskHandler = createTaskHandler({ taskUsecase });
  const healthHandler = createHealthHandler({ taskUsecase, appInfo });

  const workerTransport = createWorkerTransport({
    taskHandler,
    intervalMs: workerIntervalMs ?? resolvedSettings.worker.poll_interval_ms,
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
    const resolvedHost = host ?? resolvedSettings.server.host;
    const resolvedPort = port ?? resolvedSettings.server.port;
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
  if (settingsPath) {
    resolvedLogger.log(
      `Settings: ${settingsPath}${settingsCreated ? " (created default)" : ""}`,
    );
  }
  resolvedLogger.log(`HTTP:     ${resolvedEnableHttp ? `${binding.url}/tasks` : "disabled"}`);
  resolvedLogger.log(`MCP:      ${resolvedEnableMcp ? `${binding.url}/mcp` : "disabled"}`);
  if (binding.url) {
    resolvedLogger.log(`Health:   ${binding.url}/health`);
  }
  resolvedLogger.log(
    `Worker:   ${resolvedEnableWorker ? `running (id=${resolvedSettings.worker.worker_id})` : "disabled"}`,
  );
  resolvedLogger.log(`Agents:   ${resolvedSettings.worker.allowed_agents.join(", ")}`);
  resolvedLogger.log(`Runs:     ${resolvedSettings.worker.runs_dir}`);
  if (ownsLogger && resolvedLogger.getCurrentLogFile) {
    resolvedLogger.log(`Logs:     ${resolvedLogger.getCurrentLogFile()}`);
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
    settingsPath,
    logDir,
    runsDir: resolvedSettings.worker.runs_dir,
    transports,
    workerTransport,
    httpTransport,
    stop,
  };
}
