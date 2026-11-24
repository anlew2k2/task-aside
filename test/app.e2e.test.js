import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { startApp } from "../src/index.js";
import { ConfigError } from "../src/utilities/errors.js";
import { generateUuidV7, isUuidV7 } from "../src/utilities/uuid.js";

function createMockCloudflareQueueServer() {
  const pending = [];
  const inFlight = new Map();
  const acked = [];
  const retried = [];
  let maxInFlight = 0;
  let failNextEnqueue = false;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (pathname.endsWith("/messages")) {
      if (failNextEnqueue) {
        failNextEnqueue = false;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            errors: [{ code: 5000, message: "Queue temporarily unavailable" }],
          }),
        );
        return;
      }

      pending.push({
        id: randomUUID(),
        body: body.body,
        attempts: 0,
        timestamp_ms: Date.now(),
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, errors: [], messages: [], result: null }));
      return;
    }

    if (pathname.endsWith("/messages/pull")) {
      const batchSize = Math.max(1, body.batch_size ?? 1);
      const pulled = [];
      while (pulled.length < batchSize && pending.length > 0) {
        const msg = pending.shift();
        msg.attempts += 1;
        const leaseId = randomUUID();
        inFlight.set(leaseId, msg);
        if (inFlight.size > maxInFlight) {
          maxInFlight = inFlight.size;
        }
        pulled.push({
          id: msg.id,
          lease_id: leaseId,
          attempts: msg.attempts,
          timestamp_ms: msg.timestamp_ms,
          body: msg.body,
        });
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { messages: pulled },
        }),
      );
      return;
    }

    if (pathname.endsWith("/messages/ack")) {
      for (const item of body.acks ?? []) {
        const msg = inFlight.get(item.lease_id);
        if (msg) {
          inFlight.delete(item.lease_id);
          acked.push(msg.body);
        }
      }
      for (const item of body.retries ?? []) {
        const msg = inFlight.get(item.lease_id);
        if (msg) {
          inFlight.delete(item.lease_id);
          retried.push(msg.body);
          pending.push(msg);
        }
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, errors: [], messages: [], result: null }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, errors: [{ message: "Not Found" }] }));
  });

  return {
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      return {
        apiBaseUrl: `http://127.0.0.1:${addr.port}/client/v4`,
      };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    setFailNextEnqueue(flag) {
      failNextEnqueue = flag;
    },
    getState() {
      return {
        pendingCount: pending.length,
        inFlightCount: inFlight.size,
        maxInFlight,
        acked: structuredClone(acked),
        retried: structuredClone(retried),
      };
    },
  };
}

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
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function assertTaskEnvelope(task, expected) {
  assert.deepEqual(Object.keys(task).sort(), ["data", "metadata", "schema"]);
  assert.deepEqual(task.schema, { version: "v1" });

  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  assert.equal(typeof task.metadata.created_at, "string");
  assert.equal(typeof task.metadata.updated_at, "string");
  assert.match(task.metadata.created_at, isoRegex);
  assert.equal(task.metadata.created_at, task.metadata.updated_at);
  assert.ok(Date.parse(task.metadata.created_at) > 1_700_000_000_000);

  assert.equal(isUuidV7(task.data.id), true);
  assert.equal(task.data.title, expected.title);
  assert.equal(task.data.description, expected.description);
  assert.equal(task.data.parent_id, expected.parent_id);
  assert.equal(task.data.priority, expected.priority);
}

test("HTTP and MCP create_task expose v1 envelope and push to Cloudflare Queue", async (t) => {
  const cfMock = createMockCloudflareQueueServer();
  const { apiBaseUrl } = await cfMock.start();
  t.after(() => cfMock.close());

  const logger = createMemoryLogger();
  const app = await startApp({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    startWorker: false,
    logger,
    env: {
      CLOUDFLARE_ACCOUNT_ID: "acc-test",
      CLOUDFLARE_API_TOKEN: "tok-test",
      CLOUDFLARE_TASKS_QUEUE_ID: "queue-test",
      CLOUDFLARE_API_BASE_URL: apiBaseUrl,
    },
  });
  t.after(() => app.stop());

  // Health endpoint
  const healthRes = await fetch(`${app.url}/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.worker.provider, "cloudflare");

  // HTTP POST /tasks with parent_id null
  const httpRes1 = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Implement queue producer",
      description: "## Details\n- Push to CF Queue",
      parent_id: null,
      priority: "P0",
    }),
  });
  assert.equal(httpRes1.status, 201);
  const httpTask1 = await httpRes1.json();
  assertTaskEnvelope(httpTask1, {
    title: "Implement queue producer",
    description: "## Details\n- Push to CF Queue",
    parent_id: null,
    priority: "P0",
  });

  // HTTP POST /tasks with parent_id UUID v7
  const parentId = generateUuidV7();
  const httpRes2 = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Subtask",
      description: "Child task",
      parent_id: parentId.toUpperCase(),
      priority: "P2",
    }),
  });
  assert.equal(httpRes2.status, 201);
  const httpTask2 = await httpRes2.json();
  assertTaskEnvelope(httpTask2, {
    title: "Subtask",
    description: "Child task",
    parent_id: parentId.toLowerCase(),
    priority: "P2",
  });

  // HTTP validation & method errors
  const badRes = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "",
      description: "x",
      priority: "P9",
    }),
  });
  assert.equal(badRes.status, 400);

  const methodRes = await fetch(`${app.url}/tasks`, { method: "GET" });
  assert.equal(methodRes.status, 405);

  // HTTP 502 when Cloudflare Queue rejects enqueue
  cfMock.setFailNextEnqueue(true);
  const cfErrRes = await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Queue fail",
      description: "Should fail",
      priority: "P1",
    }),
  });
  assert.equal(cfErrRes.status, 502);

  // MCP tools/list
  const listRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }),
  });
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.deepEqual(
    listJson.result.tools.map((tool) => tool.name),
    ["create_task"],
  );

  // MCP tools/call create_task
  const mcpCallRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "create_task",
        arguments: {
          title: "MCP task",
          description: "- Bullet markdown",
          parent_id: httpTask1.data.id,
          priority: "P3",
        },
      },
    }),
  });
  assert.equal(mcpCallRes.status, 200);
  const mcpCallJson = await mcpCallRes.json();
  const mcpTask = JSON.parse(mcpCallJson.result.content[0].text);
  assertTaskEnvelope(mcpTask, {
    title: "MCP task",
    description: "- Bullet markdown",
    parent_id: httpTask1.data.id,
    priority: "P3",
  });

  // MCP invalid params -> -32602
  const mcpBadRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "create_task",
        arguments: {
          title: "Missing priority",
          description: "md",
        },
      },
    }),
  });
  const mcpBadJson = await mcpBadRes.json();
  assert.equal(mcpBadJson.error.code, -32602);

  assert.equal(cfMock.getState().pendingCount, 3);
});

test("Sequential worker pulls messages one at a time, sleeps, logs, and acks in order", async (t) => {
  const cfMock = createMockCloudflareQueueServer();
  const { apiBaseUrl } = await cfMock.start();
  t.after(() => cfMock.close());

  const logger = createMemoryLogger();
  const mockDelayMs = 60;
  const startMs = Date.now();

  const app = await startApp({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    workerIntervalMs: 15,
    mockDelayMs,
    logger,
    env: {
      CLOUDFLARE_ACCOUNT_ID: "acc-test",
      CLOUDFLARE_API_TOKEN: "tok-test",
      CLOUDFLARE_TASKS_QUEUE_ID: "queue-test",
      CLOUDFLARE_API_BASE_URL: apiBaseUrl,
    },
  });
  t.after(() => app.stop());

  // Enqueue 3 tasks across HTTP and MCP
  const t1 = await (
    await fetch(`${app.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "First",
        description: "1",
        priority: "P0",
      }),
    })
  ).json();

  const t2 = JSON.parse(
    (
      await (
        await fetch(`${app.url}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 10,
            method: "tools/call",
            params: {
              name: "create_task",
              arguments: {
                title: "Second",
                description: "2",
                priority: "P1",
              },
            },
          }),
        })
      ).json()
    ).result.content[0].text,
  );

  const t3 = await (
    await fetch(`${app.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Third",
        description: "3",
        priority: "P2",
      }),
    })
  ).json();

  await waitFor(() => cfMock.getState().acked.length === 3);

  const elapsedMs = Date.now() - startMs;
  const state = cfMock.getState();

  assert.equal(state.maxInFlight, 1);
  assert.equal(state.pendingCount, 0);
  assert.equal(state.inFlightCount, 0);
  assert.deepEqual(
    state.acked.map((m) => m.data.id),
    [t1.data.id, t2.data.id, t3.data.id],
  );
  assert.ok(
    elapsedMs >= mockDelayMs * 3 - 20,
    `Expected sequential elapsed >= ${mockDelayMs * 3 - 20}ms, got ${elapsedMs}ms`,
  );

  const workerLogs = logger.logs.filter(
    (entry) => typeof entry[0] === "string" && entry[0].includes("[worker] Processed task"),
  );
  assert.equal(workerLogs.length, 3);
  assert.match(workerLogs[0][0], new RegExp(t1.data.id));
  assert.match(workerLogs[1][0], new RegExp(t2.data.id));
  assert.match(workerLogs[2][0], new RegExp(t3.data.id));
});

test("Worker retries (nacks) on execution failure and shuts down promptly on active sleep", async (t) => {
  const cfMock = createMockCloudflareQueueServer();
  const { apiBaseUrl } = await cfMock.start();
  t.after(() => cfMock.close());

  const logger = createMemoryLogger();
  let attempt = 0;

  const app = await startApp({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    workerIntervalMs: 15,
    logger,
    executeTask: async (task) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("Transient failure");
      }
      return { ok: true, id: task.data.id };
    },
    env: {
      CLOUDFLARE_ACCOUNT_ID: "acc-test",
      CLOUDFLARE_API_TOKEN: "tok-test",
      CLOUDFLARE_TASKS_QUEUE_ID: "queue-test",
      CLOUDFLARE_API_BASE_URL: apiBaseUrl,
    },
  });

  await fetch(`${app.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Retryable task",
      description: "Fails once then succeeds",
      priority: "P1",
    }),
  });

  await waitFor(() => cfMock.getState().acked.length === 1);
  assert.equal(cfMock.getState().retried.length, 1);
  await app.stop();

  // Verify graceful shutdown aborts default 5000ms sleep promptly without acking
  const cfMock2 = createMockCloudflareQueueServer();
  const { apiBaseUrl: apiBaseUrl2 } = await cfMock2.start();
  t.after(() => cfMock2.close());

  const app2 = await startApp({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    workerIntervalMs: 15,
    mockDelayMs: 5_000,
    logger: createMemoryLogger(),
    env: {
      CLOUDFLARE_ACCOUNT_ID: "acc-test",
      CLOUDFLARE_API_TOKEN: "tok-test",
      CLOUDFLARE_TASKS_QUEUE_ID: "queue-test",
      CLOUDFLARE_API_BASE_URL: apiBaseUrl2,
    },
  });

  await fetch(`${app2.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Long sleep task",
      description: "Interrupted by shutdown",
      priority: "P0",
    }),
  });

  await waitFor(() => cfMock2.getState().inFlightCount === 1);

  const stopStart = Date.now();
  await app2.stop();
  const stopElapsed = Date.now() - stopStart;

  assert.ok(stopElapsed < 500, `Expected stop() < 500ms, took ${stopElapsed}ms`);
  assert.equal(cfMock2.getState().acked.length, 0);
});

test("ENABLE_HTTP, ENABLE_MCP, and ENABLE_WORKER toggle transports independently", async (t) => {
  const cfMock = createMockCloudflareQueueServer();
  const { apiBaseUrl } = await cfMock.start();
  t.after(() => cfMock.close());

  const baseEnv = {
    CLOUDFLARE_ACCOUNT_ID: "acc-test",
    CLOUDFLARE_API_TOKEN: "tok-test",
    CLOUDFLARE_TASKS_QUEUE_ID: "queue-test",
    CLOUDFLARE_API_BASE_URL: apiBaseUrl,
  };

  // 1. MCP-only mode (HTTP disabled, worker disabled)
  const mcpOnly = await startApp({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    logger: createMemoryLogger(),
    env: {
      ...baseEnv,
      ENABLE_HTTP: "false",
      ENABLE_MCP: "true",
      ENABLE_WORKER: "false",
    },
  });
  t.after(() => mcpOnly.stop());

  assert.deepEqual(mcpOnly.transports, { http: false, mcp: true, worker: false });
  assert.equal(mcpOnly.workerTransport.status().running, false);

  const healthMcpOnly = await (await fetch(`${mcpOnly.url}/health`)).json();
  assert.deepEqual(healthMcpOnly.transports, { http: false, mcp: true, worker: false });

  const httpDisabledRes = await fetch(`${mcpOnly.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Blocked", description: "x", priority: "P1" }),
  });
  assert.equal(httpDisabledRes.status, 404);

  const mcpEnabledRes = await fetch(`${mcpOnly.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_task",
        arguments: {
          title: "MCP-only task",
          description: "Queued while HTTP and worker are off",
          priority: "P1",
        },
      },
    }),
  });
  assert.equal(mcpEnabledRes.status, 200);
  await mcpOnly.stop();

  // 2. HTTP-only mode (MCP disabled, worker disabled)
  const httpOnly = await startApp({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    logger: createMemoryLogger(),
    env: {
      ...baseEnv,
      ENABLE_HTTP: "true",
      ENABLE_MCP: "false",
      ENABLE_WORKER: "false",
    },
  });
  t.after(() => httpOnly.stop());

  const httpEnabledRes = await fetch(`${httpOnly.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "HTTP-only task",
      description: "Queued while MCP and worker are off",
      priority: "P2",
    }),
  });
  assert.equal(httpEnabledRes.status, 201);

  const mcpDisabledRes = await fetch(`${httpOnly.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(mcpDisabledRes.status, 404);
  await httpOnly.stop();

  // 3. Worker-only mode (HTTP disabled, MCP disabled -> no HTTP port bound, drains the 2 queued tasks)
  const workerOnly = await startApp({
    host: "127.0.0.1",
    port: 0,
    installSignalHandlers: false,
    workerIntervalMs: 15,
    mockDelayMs: 20,
    logger: createMemoryLogger(),
    env: {
      ...baseEnv,
      ENABLE_HTTP: "false",
      ENABLE_MCP: "false",
      ENABLE_WORKER: "true",
    },
  });
  t.after(() => workerOnly.stop());

  assert.equal(workerOnly.url, null);
  assert.equal(workerOnly.httpTransport, null);
  assert.equal(workerOnly.workerTransport.status().running, true);

  await waitFor(() => cfMock.getState().acked.length === 2);
  await workerOnly.stop();

  // 4. All transports disabled -> ConfigError
  await assert.rejects(
    () =>
      startApp({
        host: "127.0.0.1",
        port: 0,
        installSignalHandlers: false,
        logger: createMemoryLogger(),
        env: {
          ...baseEnv,
          ENABLE_HTTP: "false",
          ENABLE_MCP: "false",
          ENABLE_WORKER: "false",
        },
      }),
    (err) => err instanceof ConfigError,
  );
});
