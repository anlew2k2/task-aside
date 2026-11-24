import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startApp } from "#src/index.js";
import { createInMemoryTaskRepository } from "#src/repositories/task.repository.js";
import { ConfigError } from "#src/utilities/errors.js";
import { generateUuidV7, isUuidV7 } from "#src/utilities/uuid.js";

function createMemoryLogger() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log(...args) {
      logs.push(args);
    },
    error(...args) {
      errors.push(args);
    },
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function makeTestSettings(dir, overrides = {}) {
  return {
    server: { host: "127.0.0.1", port: 0 },
    transports: { http: true, mcp: true, worker: false },
    supabase: { url: "", publishable_key: "", schema: "public", table: "tasks" },
    logging: { dir: join(dir, "logs") },
    worker: {
      worker_id: "e2e-worker",
      poll_interval_ms: 15,
      lease_seconds: 60,
      heartbeat_interval_ms: 5000,
      runs_dir: join(dir, "runs"),
      allowed_agents: ["agy", "claude", "codex"],
      default_permission_mode: "workspace",
      max_permission_mode: "workspace",
      default_cwd: dir,
      allowed_cwd_roots: [],
      default_timeout_ms: 5_000,
      ...overrides.worker,
    },
    ...overrides,
  };
}

function assertTaskEnvelope(task, expected) {
  assert.deepEqual(Object.keys(task).sort(), ["data", "metadata", "schema"]);
  assert.deepEqual(task.schema, { version: "v1" });

  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  assert.match(task.metadata.created_at, isoRegex);
  assert.equal(task.metadata.created_at, task.metadata.updated_at);
  assert.match(task.metadata.trace_id, /^[0-9a-f]{32}$/);
  assert.match(task.metadata.span_id, /^[0-9a-f]{16}$/);

  assert.equal(isUuidV7(task.data.id), true);
  assert.equal(task.data.title, expected.title);
  assert.equal(task.data.description, expected.description);
  assert.equal(task.data.parent_id, expected.parent_id);
  assert.equal(task.data.priority, expected.priority);
  assert.equal(task.data.execution.agent, expected.agent);
}

test("HTTP and MCP expose create_task, get_task, and list_tasks with v1 envelopes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-e2e-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const taskRepository = createInMemoryTaskRepository();
  const app = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: makeTestSettings(dir),
    logger: createMemoryLogger(),
  });
  t.after(() => app.stop());

  // Health endpoint
  const healthRes = await fetch(`${app.url}/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.worker.provider, "in-memory");

  // HTTP POST /tasks
  const httpRes1 = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Implement worker",
      description: "## Details\n- Use headless CLI",
      parent_id: null,
      priority: "P0",
      execution: { agent: "codex", effort: "medium" },
    }),
  });
  assert.equal(httpRes1.status, 201);
  const httpTask1 = await httpRes1.json();
  assertTaskEnvelope(httpTask1, {
    title: "Implement worker",
    description: "## Details\n- Use headless CLI",
    parent_id: null,
    priority: "P0",
    agent: "codex",
  });

  // HTTP POST /tasks with parent_id
  const httpRes2 = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Subtask",
      description: "Child task",
      parent_id: httpTask1.data.id.toUpperCase(),
      priority: "P2",
      execution: { agent: "claude" },
    }),
  });
  assert.equal(httpRes2.status, 201);
  const httpTask2 = await httpRes2.json();
  assert.equal(httpTask2.data.parent_id, httpTask1.data.id);

  // Validation errors
  const badRes = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Missing execution",
      description: "x",
      priority: "P1",
    }),
  });
  assert.equal(badRes.status, 400);

  // HTTP GET /tasks/:id and 404
  const getRes = await fetch(`${app.url}/tasks/${httpTask1.data.id}`);
  assert.equal(getRes.status, 200);
  const fetched = await getRes.json();
  assert.equal(fetched.id, httpTask1.data.id);
  assert.equal(fetched.status, "queued");

  const notFoundRes = await fetch(`${app.url}/tasks/${generateUuidV7()}`);
  assert.equal(notFoundRes.status, 404);

  // HTTP GET /tasks?agent=claude
  const listHttpRes = await fetch(`${app.url}/tasks?agent=claude`);
  assert.equal(listHttpRes.status, 200);
  const listHttp = await listHttpRes.json();
  assert.equal(listHttp.count, 1);
  assert.equal(listHttp.tasks[0].id, httpTask2.data.id);

  // MCP tools/list
  const listToolsRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const listToolsJson = await listToolsRes.json();
  assert.deepEqual(
    listToolsJson.result.tools.map((tool) => tool.name),
    ["create_task", "get_task", "list_tasks", "cancel_task", "retry_task"],
  );

  // MCP create_task, get_task, list_tasks
  const mcpCreateRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "create_task",
        arguments: {
          title: "MCP agy task",
          description: "- Bullet",
          parent_id: httpTask1.data.id,
          priority: "P3",
          execution: { agent: "agy" },
        },
      },
    }),
  });
  const mcpTask = JSON.parse((await mcpCreateRes.json()).result.content[0].text);
  assertTaskEnvelope(mcpTask, {
    title: "MCP agy task",
    description: "- Bullet",
    parent_id: httpTask1.data.id,
    priority: "P3",
    agent: "agy",
  });

  const mcpGetRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_task", arguments: { id: mcpTask.data.id } },
    }),
  });
  const mcpGot = JSON.parse((await mcpGetRes.json()).result.content[0].text);
  assert.equal(mcpGot.id, mcpTask.data.id);

  const mcpListRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_tasks", arguments: { parent_id: httpTask1.data.id } },
    }),
  });
  const mcpListed = JSON.parse((await mcpListRes.json()).result.content[0].text);
  assert.equal(mcpListed.count, 2);
});

test("Worker claims allowed agents sequentially by priority and persists result_envelope", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-e2e-worker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fakeClaude = join(dir, "fake-claude.mjs");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: "result",
      is_error: false,
      result: "Executed successfully",
      session_id: "sess-abc",
      usage: { input_tokens: 5, output_tokens: 7 }
    }));
  }, 30);
});
`,
    "utf8",
  );
  chmodSync(fakeClaude, 0o755);

  const taskRepository = createInMemoryTaskRepository();
  const app = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: makeTestSettings(dir, {
      transports: { http: true, mcp: false, worker: true },
      worker: {
        allowed_agents: ["claude"],
        agents: {
          agy: { executable: "agy", default_model: null, default_effort: null },
          claude: { executable: fakeClaude, default_model: null, default_effort: null },
          codex: { executable: "codex", default_model: null, default_effort: null, skip_git_repo_check: false },
        },
      },
    }),
    logger: createMemoryLogger(),
  });
  t.after(() => app.stop());

  // Enqueue: P2 claude, P0 agy (not in allowed_agents), P0 claude
  const create = async (body) =>
    (
      await fetch(`${app.url}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();

  const p2Claude = await create({
    title: "Second priority",
    description: "P2",
    priority: "P2",
    execution: { agent: "claude" },
  });
  const p0Agy = await create({
    title: "Other agent",
    description: "agy",
    priority: "P0",
    execution: { agent: "agy" },
  });
  const p0Claude = await create({
    title: "First priority",
    description: "P0",
    priority: "P0",
    execution: { agent: "claude" },
  });

  await waitFor(async () => {
    const completed = await taskRepository.findAll({ status: "completed" });
    return completed.length === 2;
  });

  const gotP0 = await taskRepository.findById(p0Claude.data.id);
  const gotP2 = await taskRepository.findById(p2Claude.data.id);
  const gotAgy = await taskRepository.findById(p0Agy.data.id);

  assert.equal(gotP0.status, "completed");
  assert.equal(gotP2.status, "completed");
  assert.equal(gotAgy.status, "queued");
  assert.ok(Date.parse(gotP0.finished_at) <= Date.parse(gotP2.started_at));
  assert.equal(gotP0.result.schema.type, "task_result");
  assert.equal(gotP0.result.data.output.text, "Executed successfully");
  assert.equal(gotP0.result.data.execution.session_id, "sess-abc");
});

test("Worker persists interrupted status promptly on graceful shutdown", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-e2e-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const slowCodex = join(dir, "slow-codex.mjs");
  writeFileSync(
    slowCodex,
    `#!/usr/bin/env node
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  chmodSync(slowCodex, 0o755);

  const taskRepository = createInMemoryTaskRepository();
  const app = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: makeTestSettings(dir, {
      transports: { http: true, mcp: false, worker: true },
      worker: {
        allowed_agents: ["codex"],
        agents: {
          agy: { executable: "agy", default_model: null, default_effort: null },
          claude: { executable: "claude", default_model: null, default_effort: null },
          codex: { executable: slowCodex, default_model: null, default_effort: null, skip_git_repo_check: false },
        },
      },
    }),
    logger: createMemoryLogger(),
  });

  const created = await (
    await fetch(`${app.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Long task",
        description: "Interrupted on stop",
        priority: "P0",
        execution: { agent: "codex" },
      }),
    })
  ).json();

  await waitFor(async () => (await taskRepository.findById(created.data.id))?.status === "running");

  const stopStart = Date.now();
  await app.stop();
  const elapsed = Date.now() - stopStart;

  assert.ok(elapsed < 2_000, `Expected stop() < 2000ms, took ${elapsed}ms`);
  const after = await taskRepository.findById(created.data.id);
  assert.equal(after.status, "interrupted");
  assert.equal(after.result.data.status, "interrupted");
});

test("All transports disabled throws ConfigError", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-e2e-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      startApp({
        installSignalHandlers: false,
        taskRepository: createInMemoryTaskRepository(),
        settings: makeTestSettings(dir, {
          transports: { http: false, mcp: false, worker: false, telegram: false },
        }),
        logger: createMemoryLogger(),
      }),
    (err) => err instanceof ConfigError,
  );
});

test("HTTP and MCP expose cancel and retry with 409 conflict handling", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-e2e-cancel-retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const taskRepository = createInMemoryTaskRepository();
  const app = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: makeTestSettings(dir),
    logger: createMemoryLogger(),
  });
  t.after(() => app.stop());

  const createRes = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Cancelable task",
      description: "Body",
      priority: "P1",
      execution: { agent: "codex", effort: "low" },
    }),
  });
  const created = await createRes.json();

  // Retry while queued -> 409 Conflict
  const activeRetryRes = await fetch(`${app.url}/tasks/${created.data.id}/retry`, {
    method: "POST",
  });
  assert.equal(activeRetryRes.status, 409);

  // Cancel queued -> 200 cancelled
  const cancelRes = await fetch(`${app.url}/tasks/${created.data.id}/cancel`, {
    method: "POST",
  });
  assert.equal(cancelRes.status, 200);
  const cancelled = await cancelRes.json();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.result.data.error.code, "CANCELLED");

  // Second cancel -> 409 Conflict
  const secondCancelRes = await fetch(`${app.url}/tasks/${created.data.id}/cancel`, {
    method: "POST",
  });
  assert.equal(secondCancelRes.status, 409);

  // HTTP retry cancelled -> 201 new queued task linked via parent_id
  const retryRes = await fetch(`${app.url}/tasks/${created.data.id}/retry`, {
    method: "POST",
  });
  assert.equal(retryRes.status, 201);
  const retried = await retryRes.json();
  assert.equal(retried.data.parent_id, created.data.id);
  assert.equal(retried.data.title, "Cancelable task");

  // MCP cancel_task and retry_task
  const mcpCancelRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "cancel_task", arguments: { id: retried.data.id } },
    }),
  });
  const mcpCancelPayload = JSON.parse((await mcpCancelRes.json()).result.content[0].text);
  assert.equal(mcpCancelPayload.status, "cancelled");

  const mcpConflictRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "cancel_task", arguments: { id: retried.data.id } },
    }),
  });
  const mcpConflictRpc = await mcpConflictRes.json();
  assert.equal(mcpConflictRpc.result.isError, true);

  const mcpRetryRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "retry_task", arguments: { id: retried.data.id } },
    }),
  });
  const mcpRetried = JSON.parse((await mcpRetryRes.json()).result.content[0].text);
  assert.equal(mcpRetried.data.parent_id, retried.data.id);
});

test("Cancelling a running task aborts worker process and preserves cancelled status", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-e2e-cancel-running-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const slowCodex = join(dir, "slow-codex.mjs");
  writeFileSync(
    slowCodex,
    `#!/usr/bin/env node
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  chmodSync(slowCodex, 0o755);

  const taskRepository = createInMemoryTaskRepository();
  const app = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: makeTestSettings(dir, {
      transports: { http: true, mcp: false, worker: true },
      worker: {
        allowed_agents: ["codex"],
        agents: {
          agy: { executable: "agy", default_model: null, default_effort: null },
          claude: { executable: "claude", default_model: null, default_effort: null },
          codex: { executable: slowCodex, default_model: null, default_effort: null, skip_git_repo_check: false },
        },
      },
    }),
    logger: createMemoryLogger(),
  });
  t.after(() => app.stop());

  const created = await (
    await fetch(`${app.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Running task to cancel",
        description: "Cancel mid-flight",
        priority: "P0",
        execution: { agent: "codex" },
      }),
    })
  ).json();

  await waitFor(async () => (await taskRepository.findById(created.data.id))?.status === "running");

  const cancelRes = await fetch(`${app.url}/tasks/${created.data.id}/cancel`, {
    method: "POST",
  });
  assert.equal(cancelRes.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const finalRecord = await taskRepository.findById(created.data.id);
  assert.equal(finalRecord.status, "cancelled");
  assert.equal(finalRecord.result.data.error.code, "CANCELLED");
});
