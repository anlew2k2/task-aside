import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createSupabaseTaskRepository } from "#src/repositories/task.repository.js";
import { StorageError } from "#src/utilities/errors.js";

async function startMockSupabaseServer(handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : null;
    await handler(req, res, body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("Supabase task repository executes REST & RPC lifecycle with expected headers", async (t) => {
  const requests = [];
  const sampleEnvelope = {
    schema: { version: "v1" },
    metadata: {
      created_at: "2026-11-24T10:00:00.000Z",
      updated_at: "2026-11-24T10:00:00.000Z",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
    },
    data: {
      id: "01935e8b-0000-7000-8000-000000000001",
      title: "Repo test",
      description: "Body",
      parent_id: null,
      priority: "P1",
      execution: {
        agent: "codex",
        model: null,
        effort: null,
        cwd: null,
        permission_mode: null,
        timeout_ms: null,
        session_id: null,
      },
    },
  };

  const baseRow = {
    id: sampleEnvelope.data.id,
    parent_id: null,
    priority: "P1",
    agent: "codex",
    status: "queued",
    input_envelope: sampleEnvelope,
    result_envelope: null,
    worker_id: null,
    attempts: 0,
    lease_expires_at: null,
    trace_id: sampleEnvelope.metadata.trace_id,
    created_at: sampleEnvelope.metadata.created_at,
    updated_at: sampleEnvelope.metadata.updated_at,
    started_at: null,
    finished_at: null,
  };

  const mock = await startMockSupabaseServer((req, res, body) => {
    requests.push({
      method: req.method,
      url: req.url,
      apikey: req.headers.apikey,
      authorization: req.headers.authorization,
      prefer: req.headers.prefer,
      body,
    });

    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/rest/v1/rpc/claim_next_task") {
      res.end(JSON.stringify([{ ...baseRow, status: "running", worker_id: "w-1", attempts: 1 }]));
      return;
    }
    if (req.url === "/rest/v1/rpc/extend_task_lease") {
      res.end(JSON.stringify(true));
      return;
    }
    if (req.url.startsWith("/rest/v1/tasks?select=status")) {
      res.end(JSON.stringify([{ status: "queued" }, { status: "completed" }]));
      return;
    }
    if (req.method === "PATCH") {
      const nextStatus = body?.status ?? "completed";
      res.end(JSON.stringify([{ ...baseRow, status: nextStatus, worker_id: "w-1" }]));
      return;
    }
    if (req.method === "DELETE") {
      res.end("");
      return;
    }
    res.end(JSON.stringify([baseRow]));
  });
  t.after(() => mock.close());

  const repo = createSupabaseTaskRepository({
    url: mock.url,
    publishableKey: "sb_publishable_test_key",
  });

  const created = await repo.create(sampleEnvelope);
  assert.equal(created.id, sampleEnvelope.data.id);
  assert.equal(created.status, "queued");

  const found = await repo.findById(sampleEnvelope.data.id);
  assert.equal(found.id, sampleEnvelope.data.id);

  const list = await repo.findAll({ status: "queued", agent: "codex", parent_id: null, limit: 10, offset: 5 });
  assert.equal(list.length, 1);

  const claimed = await repo.claimNext({
    allowedAgents: ["codex"],
    workerId: "w-1",
    leaseSeconds: 90,
  });
  assert.equal(claimed.status, "running");
  assert.equal(claimed.worker_id, "w-1");

  const extended = await repo.extendLease({
    taskId: sampleEnvelope.data.id,
    workerId: "w-1",
    leaseSeconds: 90,
  });
  assert.equal(extended, true);

  const finished = await repo.finishTask({
    taskId: sampleEnvelope.data.id,
    workerId: "w-1",
    status: "completed",
    resultEnvelope: { schema: { version: "v1", type: "task_result" } },
    finishedAt: "2026-11-24T10:01:00.000Z",
  });
  assert.equal(finished.status, "completed");

  const cancelled = await repo.cancelTask({
    taskId: sampleEnvelope.data.id,
    resultEnvelope: { schema: { version: "v1", type: "task_result" }, data: { status: "cancelled" } },
    finishedAt: "2026-11-24T10:02:00.000Z",
  });
  assert.equal(cancelled.status, "cancelled");

  const stats = await repo.stats();
  assert.equal(stats.provider, "supabase");
  assert.equal(stats.counts.total, 2);
  assert.equal(stats.counts.queued, 1);
  assert.equal(stats.counts.completed, 1);

  await repo.deleteById(sampleEnvelope.data.id);

  for (const r of requests) {
    assert.equal(r.apikey, "sb_publishable_test_key");
    assert.equal(r.authorization, "Bearer sb_publishable_test_key");
  }
  assert.equal(requests[2].url.includes("parent_id=is.null"), true);
  assert.equal(requests[2].url.includes("status=eq.queued"), true);
  assert.equal(requests[2].url.includes("agent=eq.codex"), true);
  const finishReq = requests.find(
    (r) => r.method === "PATCH" && r.url.includes("status=eq.running"),
  );
  assert.ok(finishReq, "finishTask PATCH must filter status=eq.running");
  const cancelReq = requests.find(
    (r) => r.method === "PATCH" && r.url.includes("status=in.%28queued%2Crunning%29"),
  );
  assert.ok(cancelReq, "cancelTask PATCH must filter status=in.(queued,running)");
  assert.equal(cancelReq.body.status, "cancelled");
});

test("Supabase task repository throws StorageError on error without leaking key", async (t) => {
  const mock = await startMockSupabaseServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Invalid API key" }));
  });
  t.after(() => mock.close());

  const repo = createSupabaseTaskRepository({
    url: mock.url,
    publishableKey: "secret-publishable-key",
  });

  await assert.rejects(
    () => repo.stats(),
    (err) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.statusCode, 401);
      assert.match(err.message, /Invalid API key/);
      assert.equal(err.message.includes("secret-publishable-key"), false);
      return true;
    },
  );
});
