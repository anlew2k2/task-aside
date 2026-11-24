import { generateUuidV7 } from "../utilities/uuid.js";
import { TASK_SCHEMA_VERSION } from "../utilities/validation.js";

function createAbortError() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockTaskExecutor({ delayMs = 5_000, logger = console } = {}) {
  return async function mockExecuteTask(taskMessage, { signal } = {}) {
    await sleep(delayMs, signal);
    const id = taskMessage?.data?.id ?? null;
    const title = taskMessage?.data?.title ?? "";
    const priority = taskMessage?.data?.priority ?? "";
    logger.log(
      `[worker] Processed task id=${id} priority=${priority} title=${JSON.stringify(title)}`,
      taskMessage,
    );
    return {
      status: "completed",
      taskId: id,
    };
  };
}

/**
 * Task business logic usecase.
 * Orchestrates task envelope creation, Cloudflare Queue dispatch, and sequential processing.
 */
export function createTaskUsecase({
  taskRepository = null,
  queueService,
  executeTask,
  mockDelayMs = 5_000,
  now = () => Date.now(),
  generateId = generateUuidV7,
  logger = console,
}) {
  const executor =
    executeTask ?? createMockTaskExecutor({ delayMs: mockDelayMs, logger });

  async function createTask({ title, description, parent_id = null, priority }) {
    const nowMs = now();
    const isoTimestamp = new Date(nowMs).toISOString();

    const taskMessage = {
      schema: {
        version: TASK_SCHEMA_VERSION,
      },
      metadata: {
        created_at: isoTimestamp,
        updated_at: isoTimestamp,
      },
      data: {
        id: generateId(nowMs),
        title,
        description,
        parent_id,
        priority,
      },
    };

    await queueService.enqueue(taskMessage);
    logger.log(
      `[task] Enqueued task id=${taskMessage.data.id} priority=${taskMessage.data.priority} title=${JSON.stringify(taskMessage.data.title)}`,
    );

    if (taskRepository) {
      await taskRepository.create(taskMessage);
    }

    return taskMessage;
  }

  async function getStats() {
    const [totalCount, queueStats] = await Promise.all([
      taskRepository ? taskRepository.count() : Promise.resolve(0),
      queueService.stats(),
    ]);

    return {
      ...queueStats,
      totalCount,
    };
  }

  async function processNextTask({ signal } = {}) {
    const queueMessage = await queueService.dequeue({ signal });
    if (!queueMessage) {
      return { processed: false, task: null };
    }

    const startedAt = Date.now();
    const taskId = queueMessage.body?.data?.id ?? null;
    const title = queueMessage.body?.data?.title ?? "";
    const priority = queueMessage.body?.data?.priority ?? "";
    const attempts = queueMessage.attempts ?? 1;
    const queueMessageId = queueMessage.queueMessageId ?? null;

    logger.log(
      `[worker] Processing task id=${taskId} priority=${priority} title=${JSON.stringify(title)} attempt=${attempts} queueMessageId=${queueMessageId}`,
    );

    try {
      const result = await executor(queueMessage.body, { queueMessage, signal });
      await queueService.ack(queueMessage);
      logger.log(
        `[worker] Acked task id=${taskId} durationMs=${Date.now() - startedAt} result=${JSON.stringify(result)}`,
      );
      return {
        processed: true,
        task: queueMessage.body,
        result,
      };
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) {
        logger.log(
          `[worker] Aborted task id=${taskId} durationMs=${Date.now() - startedAt} (not acked)`,
        );
        return {
          processed: false,
          aborted: true,
          task: queueMessage.body,
        };
      }

      logger.error(
        `[worker] Failed to process task id=${taskId} durationMs=${Date.now() - startedAt}:`,
        error instanceof Error ? error.message : String(error),
      );
      try {
        await queueService.nack(queueMessage, error);
        logger.log(`[worker] Nacked task id=${taskId} for retry`);
      } catch (nackError) {
        logger.error(
          `[worker] Failed to nack task id=${taskId}:`,
          nackError instanceof Error ? nackError.message : String(nackError),
        );
      }

      return {
        processed: true,
        task: queueMessage.body,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    createTask,
    getStats,
    processNextTask,
  };
}
