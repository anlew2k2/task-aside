import { createHealthHandler } from "./handlers/health.handler.js";
import { createTaskHandler } from "./handlers/task.handler.js";
import { createTaskRepository } from "./repositories/task.repository.js";
import { createQueueService } from "./services/queue.service.js";
import { createHttpTransport } from "./transports/http.js";
import { createMcpTransport } from "./transports/mcp.js";
import { createWorkerTransport } from "./transports/worker.js";
import { createTaskUsecase } from "./usecases/task.usecase.js";
import { getPackageInfo } from "./utilities/package-info.js";

/**
 * Composition root: wires repositories -> services -> usecases -> handlers -> transports.
 */
export async function startApp({
  host = "127.0.0.1",
  port = 3100,
  installSignalHandlers = true,
} = {}) {
  const appInfo = getPackageInfo();

  const taskRepository = createTaskRepository();
  const queueService = createQueueService();
  const taskUsecase = createTaskUsecase({ taskRepository, queueService });

  const taskHandler = createTaskHandler({ taskUsecase });
  const healthHandler = createHealthHandler({ taskUsecase, appInfo });

  const workerTransport = createWorkerTransport({ taskHandler });
  const getWorkerStatus = () => workerTransport.status();

  const mcpTransport = createMcpTransport({
    taskHandler,
    version: appInfo.version,
    getWorkerStatus,
  });

  const httpTransport = createHttpTransport({
    healthHandler,
    mcpTransport,
    getWorkerStatus,
  });

  workerTransport.start();

  let binding;
  try {
    binding = await httpTransport.listen({ host, port });
  } catch (error) {
    await workerTransport.stop();
    throw error;
  }

  console.log(`${appInfo.name} v${appInfo.version} ready`);
  console.log(`MCP:    ${binding.url}/mcp`);
  console.log(`Health: ${binding.url}/health`);
  console.log("Worker: running");

  let stopping = false;
  let stopPromise = null;

  async function stop() {
    if (stopping) {
      return stopPromise;
    }
    stopping = true;
    stopPromise = (async () => {
      await httpTransport.close();
      await workerTransport.stop();
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
    workerTransport,
    httpTransport,
    stop,
  };
}
