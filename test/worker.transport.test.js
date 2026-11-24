import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerTransport } from "#src/transports/worker.js";

test("worker transport backs off with jitter when idle, resets on work, and wakes on task.created", async (t) => {
  const listeners = new Set();
  let queueCount = 0;
  let processCalls = 0;

  const taskHandler = {
    async processNextTask() {
      processCalls += 1;
      if (queueCount > 0) {
        queueCount -= 1;
        return { processed: true, task: { data: { id: "t1" } } };
      }
      return { processed: false, task: null };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  // Deterministic random = 0.5 => zero jitter offset (multiplier * intervalMs exact)
  const worker = createWorkerTransport({
    taskHandler,
    intervalMs: 25,
    maxIntervalMs: 200,
    jitterRatio: 0.15,
    random: () => 0.5,
    logger: { log() {}, error() {} },
  });
  t.after(() => worker.stop());

  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(processCalls, 1);
  // After 1st idle poll, backoff advances to step 1 => 25 * 2 = 50ms
  assert.equal(worker.status().current_poll_interval_ms, 50);

  // Wait for 2nd poll (~50ms) => advances to step 2 => 25 * 5 = 125ms
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(processCalls, 2);
  assert.equal(worker.status().current_poll_interval_ms, 125);

  // Enqueue a task and emit task.created -> wakes immediately & resets backoff
  queueCount = 1;
  for (const listener of listeners) {
    listener({ type: "task.created" });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(processCalls >= 4); // processed 1 task + 1 empty check
  assert.equal(worker.status().current_poll_interval_ms, 25); // reset to step 0 (intervalMs)
});

test("worker transport applies +-15% jitter bounds around backoff intervals", async (t) => {
  const worker = createWorkerTransport({
    taskHandler: {
      async processNextTask() {
        return { processed: false, task: null };
      },
      subscribe() {
        return () => {};
      },
    },
    intervalMs: 100,
    maxIntervalMs: 3000,
    jitterRatio: 0.15,
    random: () => 1, // +15% jitter
    logger: { log() {}, error() {} },
  });
  t.after(() => worker.stop());

  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  // Step 1 base = 200ms, +15% => 230ms
  assert.equal(worker.status().current_poll_interval_ms, 230);
});
