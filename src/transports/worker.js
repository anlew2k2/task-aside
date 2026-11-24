const BACKOFF_MULTIPLIERS = [1, 2, 5, 15, 30];

/**
 * Background worker transport polling sequentially through the task handler
 * with adaptive backoff, jitter, and immediate wakeup on local task creation.
 */
export function createWorkerTransport({
  taskHandler,
  intervalMs = 1_000,
  maxIntervalMs = 30_000,
  jitterRatio = 0.15,
  random = Math.random,
  logger = console,
}) {
  const effectiveMaxMs = Math.max(intervalMs, maxIntervalMs);
  let running = false;
  let busy = false;
  let timer = null;
  let drainPromise = null;
  let activeController = null;
  let unsubscribe = null;
  let backoffStep = 0;
  let currentPollIntervalMs = intervalMs;

  function computeNextDelayMs() {
    const multiplier = BACKOFF_MULTIPLIERS[Math.min(backoffStep, BACKOFF_MULTIPLIERS.length - 1)];
    const baseDelay = Math.min(effectiveMaxMs, Math.max(1, intervalMs * multiplier));
    const jitterFactor = 1 + (random() * 2 - 1) * jitterRatio;
    return Math.max(1, Math.round(baseDelay * jitterFactor));
  }

  function scheduleNextPoll() {
    if (!running) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const delayMs = computeNextDelayMs();
    currentPollIntervalMs = delayMs;
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delayMs);
    timer.unref?.();
  }

  function drain() {
    if (!running || busy) {
      return drainPromise ?? Promise.resolve();
    }

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    busy = true;
    drainPromise = (async () => {
      let processedAny = false;
      try {
        while (running) {
          const controller = new AbortController();
          activeController = controller;
          try {
            const outcome = await taskHandler.processNextTask({
              signal: controller.signal,
            });
            if (!outcome.processed) {
              break;
            }
            processedAny = true;
          } catch (error) {
            if (error?.name === "AbortError" || !running) {
              break;
            }
            logger.error(
              "[worker] Polling error:",
              error instanceof Error ? error.message : String(error),
            );
            break;
          } finally {
            activeController = null;
          }
        }
      } finally {
        busy = false;
        drainPromise = null;
        if (running) {
          backoffStep = processedAny
            ? 0
            : Math.min(backoffStep + 1, BACKOFF_MULTIPLIERS.length - 1);
          if (processedAny) {
            currentPollIntervalMs = intervalMs;
          }
          scheduleNextPoll();
        }
      }
    })();

    return drainPromise;
  }

  function wake() {
    if (!running || busy) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    backoffStep = 0;
    currentPollIntervalMs = intervalMs;
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, 0);
    timer.unref?.();
  }

  function start() {
    if (running) {
      return;
    }

    running = true;
    backoffStep = 0;
    currentPollIntervalMs = intervalMs;

    if (typeof taskHandler.subscribe === "function") {
      unsubscribe = taskHandler.subscribe((event) => {
        if (event?.type === "task.created") {
          wake();
        }
      });
    }

    void drain();
  }

  async function stop() {
    running = false;

    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (activeController) {
      activeController.abort();
    }

    if (drainPromise) {
      await drainPromise;
    }
  }

  function status() {
    return {
      running,
      busy,
      current_poll_interval_ms: currentPollIntervalMs,
    };
  }

  return {
    start,
    stop,
    wake,
    status,
  };
}
