import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runDoctor, startApp, startStdioMcp } from "#src/index.js";
import { createInMemoryTaskRepository } from "#src/repositories/task.repository.js";
import { createTaskUsecase } from "#src/usecases/task.usecase.js";

function createMemoryLogger() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log(...args) {
      logs.push(args.join(" "));
    },
    error(...args) {
      errors.push(args.join(" "));
    },
  };
}

function makeTestSettings(dir, overrides = {}) {
  return {
    server: { host: "127.0.0.1", port: 0 },
    transports: { http: true, mcp: true, worker: false, telegram: false },
    allowed_workspaces: [dir],
    supabase: { url: "", publishable_key: "", schema: "public", table: "tasks" },
    logging: { dir: join(dir, "logs") },
    worker: {
      worker_id: "upgrade-worker",
      poll_interval_ms: 20,
      poll_max_interval_ms: 200,
      lease_seconds: 60,
      heartbeat_interval_ms: 5000,
      runs_dir: join(dir, "runs"),
      allowed_agents: ["agy", "claude", "codex"],
      default_permission_mode: "workspace",
      max_permission_mode: "workspace",
      default_timeout_ms: 5_000,
      max_subtask_depth: 2,
      max_subtasks_per_root: 3,
      ...overrides.worker,
    },
    ...overrides,
  };
}

test("Idempotency key deduplicates HTTP and MCP create_task and conflicts on payload mismatch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-idem-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const taskRepository = createInMemoryTaskRepository();
  const app = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: makeTestSettings(dir),
    logger: createMemoryLogger(),
  });
  t.after(() => app.stop());

  const payload = {
    title: "Idempotent job",
    description: "Run once",
    priority: "P1",
    execution: { agent: "codex" },
  };

  // HTTP header key: first 201, replay 200 + header
  const firstRes = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "http-key-1" },
    body: JSON.stringify(payload),
  });
  assert.equal(firstRes.status, 201);
  const firstTask = await firstRes.json();

  const replayRes = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "http-key-1" },
    body: JSON.stringify(payload),
  });
  assert.equal(replayRes.status, 200);
  assert.equal(replayRes.headers.get("x-idempotent-replay"), "true");
  const replayTask = await replayRes.json();
  assert.equal(replayTask.data.id, firstTask.data.id);

  // Header vs body mismatch -> 400
  const headerMismatchRes = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "header-a" },
    body: JSON.stringify({ ...payload, idempotency_key: "body-b" }),
  });
  assert.equal(headerMismatchRes.status, 400);

  // Same key + different payload -> 409 Conflict
  const conflictRes = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, title: "Changed", idempotency_key: "http-key-1" }),
  });
  assert.equal(conflictRes.status, 409);

  // MCP idempotency_key replay
  const mcpCreate = (key, title = "MCP job") =>
    fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_task",
          arguments: {
            title,
            description: "Run once",
            priority: "P2",
            idempotency_key: key,
            execution: { agent: "claude" },
          },
        },
      }),
    });

  const mcp1 = JSON.parse((await (await mcpCreate("mcp-key-1")).json()).result.content[0].text);
  const mcp2 = JSON.parse((await (await mcpCreate("mcp-key-1")).json()).result.content[0].text);
  assert.equal(mcp1.data.id, mcp2.data.id);
  assert.equal(mcp2.idempotent_replay, true);

  const mcpConflict = await (await mcpCreate("mcp-key-1", "Different")).json();
  assert.equal(mcpConflict.result.isError, true);
});

test("Attempts fencing rejects stale worker extendLease and finishTask", async () => {
  const repo = createInMemoryTaskRepository();
  const usecase = createTaskUsecase({
    taskRepository: repo,
    workerConfig: {
      worker_id: "w-1",
      lease_seconds: 60,
      heartbeat_interval_ms: 5000,
      allowed_agents: ["codex"],
      default_permission_mode: "workspace",
      max_permission_mode: "workspace",
    },
    logger: createMemoryLogger(),
  });

  const task = await usecase.createTask({
    title: "Fence me",
    description: "test",
    priority: "P1",
    execution: { agent: "codex" },
  });

  const claimed = await repo.claimNext({ allowedAgents: ["codex"], workerId: "w-1" });
  assert.equal(claimed.attempts, 1);

  assert.equal(
    await repo.extendLease({ taskId: task.data.id, workerId: "w-1", attempt: 99 }),
    false,
  );
  assert.equal(
    await repo.finishTask({
      taskId: task.data.id,
      workerId: "w-1",
      attempt: 99,
      status: "completed",
      resultEnvelope: {},
      finishedAt: new Date().toISOString(),
    }),
    null,
  );
  assert.equal(
    await repo.extendLease({ taskId: task.data.id, workerId: "w-1", attempt: 1 }),
    true,
  );
});

test("MCP list_tasks is compact, get_task truncates output + warns untrusted, and get_capabilities works", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-mcp-ctx-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const taskRepository = createInMemoryTaskRepository();
  const app = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: makeTestSettings(dir),
    logger: createMemoryLogger(),
  });
  t.after(() => app.stop());

  const created = await (
    await fetch(`${app.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Long output task",
        description: "Big response",
        priority: "P1",
        execution: { agent: "codex" },
      }),
    })
  ).json();

  await taskRepository.claimNext({ allowedAgents: ["codex"], workerId: "upgrade-worker" });
  await taskRepository.finishTask({
    taskId: created.data.id,
    workerId: "upgrade-worker",
    attempt: 1,
    status: "completed",
    finishedAt: new Date().toISOString(),
    resultEnvelope: {
      schema: { version: "v1", type: "task_result" },
      metadata: {},
      data: {
        id: created.data.id,
        task_id: created.data.id,
        status: "completed",
        output: { format: "markdown", text: "A".repeat(7500) },
        artifacts: { result_file: "/tmp/result.json" },
      },
    },
  });

  // Compact list_tasks
  const listRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_tasks", arguments: {} },
    }),
  });
  const listPayload = JSON.parse((await listRes.json()).result.content[0].text);
  assert.equal(listPayload.tasks[0].title, "Long output task");
  assert.equal("result" in listPayload.tasks[0], false);
  assert.equal("task" in listPayload.tasks[0], false);

  // Truncated get_task
  const getShortRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_task", arguments: { id: created.data.id } },
    }),
  });
  const gotShort = JSON.parse((await getShortRes.json()).result.content[0].text);
  assert.equal(gotShort.untrusted_output, true);
  assert.equal(gotShort.poll_after_ms, null);
  assert.equal(gotShort.result.data.output.truncated, true);
  assert.equal(gotShort.result.data.output.text.length, 6000);
  assert.equal(gotShort.result.data.output.output_length, 7500);
  assert.equal(gotShort.result.data.output.result_file, "/tmp/result.json");

  // Full output get_task
  const getFullRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_task", arguments: { id: created.data.id, full_output: true } },
    }),
  });
  const gotFull = JSON.parse((await getFullRes.json()).result.content[0].text);
  assert.equal(gotFull.result.data.output.truncated, false);
  assert.equal(gotFull.result.data.output.text.length, 7500);

  // get_capabilities
  const capRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_capabilities", arguments: {} },
    }),
  });
  const caps = JSON.parse((await capRes.json()).result.content[0].text);
  assert.deepEqual(caps.allowed_agents, ["agy", "claude", "codex"]);
  assert.equal(caps.max_subtask_depth, 2);
  assert.equal(caps.worktree_supported, true);
});

test("Subtask depth and count limits reject runaway recursion while exempting retryTask", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-subtask-limits-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const taskRepository = createInMemoryTaskRepository();
  const app = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: makeTestSettings(dir, {
      worker: { max_subtask_depth: 2, max_subtasks_per_root: 3 },
    }),
    logger: createMemoryLogger(),
  });
  t.after(() => app.stop());

  const postTask = (body) =>
    fetch(`${app.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // Unknown parent_id -> 400
  const missingParent = await postTask({
    title: "Orphan",
    description: "x",
    parent_id: "01935e8b-0000-7000-8000-999999999999",
    priority: "P1",
    execution: { agent: "codex" },
  });
  assert.equal(missingParent.status, 400);

  const root = await (
    await postTask({
      title: "Root",
      description: "0",
      priority: "P1",
      execution: { agent: "codex" },
    })
  ).json();

  const child1 = await (
    await postTask({
      title: "Depth 1",
      description: "1",
      parent_id: root.data.id,
      priority: "P1",
      execution: { agent: "codex" },
    })
  ).json();

  const child2 = await (
    await postTask({
      title: "Depth 2",
      description: "2",
      parent_id: child1.data.id,
      priority: "P1",
      execution: { agent: "codex" },
    })
  ).json();

  // Depth 3 exceeds max_subtask_depth=2 -> 400
  const depth3 = await postTask({
    title: "Depth 3",
    description: "3",
    parent_id: child2.data.id,
    priority: "P1",
    execution: { agent: "codex" },
  });
  assert.equal(depth3.status, 400);

  // Add 3rd descendant under root (within depth=1, total descendants becomes 3)
  const child1b = await postTask({
    title: "Depth 1b",
    description: "1b",
    parent_id: root.data.id,
    priority: "P1",
    execution: { agent: "codex" },
  });
  assert.equal(child1b.status, 201);

  // 4th descendant exceeds max_subtasks_per_root=3 -> 400
  const child1c = await postTask({
    title: "Depth 1c",
    description: "1c",
    parent_id: root.data.id,
    priority: "P1",
    execution: { agent: "codex" },
  });
  assert.equal(child1c.status, 400);

  // Cancel child2 and retry it: retryTask is exempt from depth/count limits -> 201
  await fetch(`${app.url}/tasks/${child2.data.id}/cancel`, { method: "POST" });
  const retried = await fetch(`${app.url}/tasks/${child2.data.id}/retry`, { method: "POST" });
  assert.equal(retried.status, 201);
});

test("startStdioMcp handles JSON-RPC over stdin/stdout without stdout log pollution", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-stdio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks = [];
  stdout.on("data", (chunk) => chunks.push(chunk.toString("utf8")));

  const app = await startStdioMcp({
    installSignalHandlers: false,
    taskRepository: createInMemoryTaskRepository(),
    settings: makeTestSettings(dir),
    stdin,
    stdout,
  });

  stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_capabilities", arguments: {} } })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_task", arguments: { title: "STDIO task", description: "hi", priority: "P1", execution: { agent: "agy" } } } })}\n`,
  );
  stdin.end();
  await app.done;
  await app.stop();

  const lines = chunks.join("").trim().split("\n");
  assert.equal(lines.length, 3);
  const res1 = JSON.parse(lines[0]);
  const res2 = JSON.parse(lines[1]);
  const res3 = JSON.parse(lines[2]);
  assert.equal(res1.result.serverInfo.name, "task-aside");
  assert.deepEqual(JSON.parse(res2.result.content[0].text).allowed_agents, ["agy", "claude", "codex"]);
  assert.equal(JSON.parse(res3.result.content[0].text).data.title, "STDIO task");
});

test("runDoctor checks settings, directories, Supabase RPCs, and agent binaries", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fakeAgent = join(dir, "fake-agent");
  writeFileSync(fakeAgent, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(fakeAgent, 0o755);

  let exposeUpgrades = true;
  const mockSupabase = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/rest/v1/") {
      const paths = {
        "/rpc/claim_next_task": {},
        "/rpc/extend_task_lease": {},
        ...(exposeUpgrades ? { "/rpc/get_task_stats": {} } : {}),
      };
      const props = {
        id: {},
        ...(exposeUpgrades ? { idempotency_key: {} } : {}),
      };
      res.end(JSON.stringify({ paths, definitions: { tasks: { properties: props } } }));
      return;
    }
    res.end(JSON.stringify([]));
  });
  await new Promise((resolve) => mockSupabase.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => mockSupabase.close(resolve)));
  const addr = mockSupabase.address();

  const settings = makeTestSettings(dir, {
    supabase: {
      url: `http://127.0.0.1:${addr.port}`,
      publishable_key: "sb_publishable_doctor_secret",
      schema: "public",
      table: "tasks",
    },
    worker: {
      allowed_agents: ["codex"],
      agents: {
        agy: { executable: fakeAgent, default_model: null, default_effort: null },
        claude: { executable: fakeAgent, default_model: null, default_effort: null },
        codex: { executable: fakeAgent, default_model: null, default_effort: null, skip_git_repo_check: false },
      },
    },
  });

  const healthyLogger = createMemoryLogger();
  const healthy = await runDoctor({
    settings,
    checkExecutable: () => ({ ok: true, path: fakeAgent }),
    logger: healthyLogger,
  });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.checks.every((c) => c.status === "ok"), true);

  exposeUpgrades = false;
  const warnReport = await runDoctor({
    settings,
    checkExecutable: () => ({ ok: true, path: fakeAgent }),
    logger: createMemoryLogger(),
  });
  assert.equal(warnReport.ok, true);
  assert.equal(warnReport.checks.find((c) => c.name === "supabase").status, "warn");

  const failReport = await runDoctor({
    settings,
    checkExecutable: () => ({ ok: false, path: null }),
    logger: createMemoryLogger(),
  });
  assert.equal(failReport.ok, false);
  assert.equal(failReport.checks.find((c) => c.name === "agents").status, "fail");
});
