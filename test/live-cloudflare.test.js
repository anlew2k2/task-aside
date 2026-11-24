import assert from "node:assert/strict";
import test from "node:test";
import { startApp } from "../src/index.js";
import { loadEnvFile } from "../src/utilities/env.js";
import { isUuidV7 } from "../src/utilities/uuid.js";

const skipLiveReason =
  process.env.RUN_LIVE_TESTS === "1"
    ? false
    : "Set RUN_LIVE_TESTS=1 to run live Cloudflare Queue tests";

function assertTaskEnvelope(task, expected) {
  assert.deepEqual(Object.keys(task).sort(), ["data", "metadata", "schema"]);
  assert.deepEqual(task.schema, { version: "v1" });
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  assert.equal(typeof task.metadata.created_at, "string");
  assert.equal(typeof task.metadata.updated_at, "string");
  assert.match(task.metadata.created_at, isoRegex);
  assert.equal(task.metadata.created_at, task.metadata.updated_at);
  assert.equal(isUuidV7(task.data.id), true);
  assert.equal(task.data.title, expected.title);
  assert.equal(task.data.description, expected.description);
  assert.equal(task.data.parent_id, expected.parent_id);
  assert.equal(task.data.priority, expected.priority);
}

async function waitFor(predicate, timeoutMs = 60_000, onTick = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    onTick?.();
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for live worker`);
}

test(
  "Live Cloudflare Queue: HTTP + MCP create_task and sequential 5s worker drain",
  { skip: skipLiveReason, timeout: 90_000 },
  async (t) => {
    loadEnvFile();

    const logs = [];
    const errors = [];
    const logger = {
      log(...args) {
        logs.push({ ts: Date.now(), args });
      },
      error(...args) {
        errors.push({ ts: Date.now(), args });
      },
    };

    const app = await startApp({
      host: "127.0.0.1",
      port: 0,
      installSignalHandlers: false,
      enableHttp: true,
      enableMcp: true,
      enableWorker: true,
      workerIntervalMs: 500,
      mockDelayMs: 5_000,
      logger,
    });
    t.after(() => app.stop());

    assert.deepEqual(app.transports, { http: true, mcp: true, worker: true });

    const testStartMs = Date.now();

    // 1. Create parent task via HTTP POST /tasks
    const httpRes = await fetch(`${app.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: `live-http-task-${testStartMs}`,
        description: "## Live HTTP test\nCreated against Cloudflare Queue.",
        parent_id: null,
        priority: "P1",
      }),
    });
    assert.equal(httpRes.status, 201);
    const httpTask = await httpRes.json();
    assertTaskEnvelope(httpTask, {
      title: `live-http-task-${testStartMs}`,
      description: "## Live HTTP test\nCreated against Cloudflare Queue.",
      parent_id: null,
      priority: "P1",
    });

    // 2. Create child task via MCP tools/call create_task
    const mcpRes = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_task",
          arguments: {
            title: `live-mcp-task-${testStartMs}`,
            description: "- Live MCP child task",
            parent_id: httpTask.data.id,
            priority: "P2",
          },
        },
      }),
    });
    assert.equal(mcpRes.status, 200);
    const mcpJson = await mcpRes.json();
    assert.equal(mcpJson.result.isError ?? false, false);
    const mcpTask = JSON.parse(mcpJson.result.content[0].text);
    assertTaskEnvelope(mcpTask, {
      title: `live-mcp-task-${testStartMs}`,
      description: "- Live MCP child task",
      parent_id: httpTask.data.id,
      priority: "P2",
    });

    const findProcessedLog = (taskId) =>
      logs.find(
        (entry) =>
          typeof entry.args[0] === "string" &&
          entry.args[0].includes("[worker] Processed task") &&
          entry.args[0].includes(taskId),
      );

    await waitFor(
      () =>
        Boolean(findProcessedLog(httpTask.data.id)) &&
        Boolean(findProcessedLog(mcpTask.data.id)),
      60_000,
      () => {
        if (errors.length > 0) {
          throw new Error(`Worker error: ${JSON.stringify(errors)}`);
        }
      },
    );

    const log1 = findProcessedLog(httpTask.data.id);
    const log2 = findProcessedLog(mcpTask.data.id);
    const gapMs = Math.abs(log2.ts - log1.ts);
    const totalMs = Math.max(log1.ts, log2.ts) - testStartMs;

    assert.equal(errors.length, 0, `Unexpected worker errors: ${JSON.stringify(errors)}`);
    assert.ok(
      gapMs >= 4_500,
      `Expected >= 4500ms sequential gap between 5s tasks, got ${gapMs}ms`,
    );
    assert.ok(
      totalMs >= 9_000,
      `Expected >= 9000ms total sequential processing time, got ${totalMs}ms`,
    );
  },
);
