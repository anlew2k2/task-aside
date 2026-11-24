/**
 * Background worker transport polling through the task handler.
 */
export function createWorkerTransport({ taskHandler, intervalMs = 100 }) {
  let running = false;
  let busy = false;
  let timer = null;
  let drainPromise = null;
  let activeController = null;

  function drain() {
    if (!running || busy) {
      return drainPromise ?? Promise.resolve();
    }

    busy = true;
    drainPromise = (async () => {
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
          } finally {
            activeController = null;
          }
        }
      } finally {
        busy = false;
        drainPromise = null;
      }
    })();

    return drainPromise;
  }

  function start() {
    if (running) {
      return;
    }

    running = true;
    timer = setInterval(() => {
      void drain();
    }, intervalMs);

    void drain();
  }

  async function stop() {
    running = false;

    if (timer) {
      clearInterval(timer);
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
    };
  }

  return {
    start,
    stop,
    status,
  };
}
