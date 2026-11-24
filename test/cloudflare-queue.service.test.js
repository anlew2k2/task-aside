import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createCloudflareQueueService } from "../src/services/queue.service.js";
import { ConfigError, QueueError } from "../src/utilities/errors.js";
import { readCloudflareQueueConfig, readFeatureFlags } from "../src/utilities/env.js";

async function startMockServer(handler) {
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
    baseUrl: `http://127.0.0.1:${addr.port}/client/v4`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("readCloudflareQueueConfig validates required variables without leaking token", () => {
  assert.throws(
    () =>
      readCloudflareQueueConfig({
        CLOUDFLARE_ACCOUNT_ID: "acc",
        CLOUDFLARE_API_TOKEN: "super-secret-token",
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /CLOUDFLARE_TASKS_QUEUE_ID/);
      assert.equal(err.message.includes("super-secret-token"), false);
      return true;
    },
  );
});

test("readFeatureFlags parses boolean env flags with defaults and rejects invalid values", () => {
  assert.deepEqual(readFeatureFlags({}), {
    enableHttp: true,
    enableMcp: true,
    enableWorker: true,
  });

  assert.deepEqual(
    readFeatureFlags({
      ENABLE_HTTP: "false",
      ENABLE_MCP: "0",
      ENABLE_WORKER: "OFF",
    }),
    {
      enableHttp: false,
      enableMcp: false,
      enableWorker: false,
    },
  );

  assert.deepEqual(
    readFeatureFlags({
      ENABLE_HTTP: "1",
      ENABLE_MCP: "yes",
      ENABLE_WORKER: "on",
    }),
    {
      enableHttp: true,
      enableMcp: true,
      enableWorker: true,
    },
  );

  assert.throws(
    () => readFeatureFlags({ ENABLE_MCP: "maybe" }),
    (err) => err instanceof ConfigError && /ENABLE_MCP/.test(err.message),
  );
});

test("Cloudflare Queue service sends expected REST requests for enqueue, pull, ack, and nack", async (t) => {
  const requests = [];
  let pullMessages = [];

  const mock = await startMockServer((req, res, body) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      body,
    });

    if (req.url.endsWith("/messages/pull")) {
      const response = {
        success: true,
        errors: [],
        messages: [],
        result: { messages: pullMessages },
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, errors: [], messages: [], result: null }));
  });
  t.after(() => mock.close());

  const queueService = createCloudflareQueueService({
    accountId: "acc-123",
    apiToken: "cf-secret-token",
    queueId: "queue-456",
    apiBaseUrl: mock.baseUrl,
    visibilityTimeoutMs: 45_000,
  });

  const sampleTask = {
    schema: { version: "v1" },
    metadata: { created_at: "2025-11-24T12:23:49.000Z", updated_at: "2025-11-24T12:23:49.000Z" },
    data: {
      id: "01935e8b-0000-7000-8000-000000000000",
      title: "Test task",
      description: "Markdown",
      parent_id: null,
      priority: "P1",
    },
  };

  await queueService.enqueue(sampleTask);

  pullMessages = [];
  assert.equal(await queueService.dequeue(), null);

  pullMessages = [
    {
      id: "cf-msg-1",
      lease_id: "lease-xyz",
      attempts: 1,
      timestamp_ms: 1700000000123,
      body: JSON.stringify(sampleTask),
    },
  ];
  const pulled = await queueService.dequeue();
  assert.deepEqual(pulled, {
    queueMessageId: "cf-msg-1",
    leaseId: "lease-xyz",
    attempts: 1,
    timestampMs: 1700000000123,
    body: sampleTask,
  });

  await queueService.ack(pulled);
  await queueService.nack(pulled, new Error("retry me"));

  assert.equal(requests.length, 5);
  for (const req of requests) {
    assert.equal(req.method, "POST");
    assert.equal(req.authorization, "Bearer cf-secret-token");
    assert.equal(req.contentType, "application/json");
  }

  assert.equal(requests[0].url, "/client/v4/accounts/acc-123/queues/queue-456/messages");
  assert.deepEqual(requests[0].body, { body: sampleTask, content_type: "json" });

  assert.equal(
    requests[1].url,
    "/client/v4/accounts/acc-123/queues/queue-456/messages/pull",
  );
  assert.deepEqual(requests[1].body, { batch_size: 1, visibility_timeout_ms: 45_000 });

  assert.equal(
    requests[3].url,
    "/client/v4/accounts/acc-123/queues/queue-456/messages/ack",
  );
  assert.deepEqual(requests[3].body, {
    acks: [{ lease_id: "lease-xyz" }],
    retries: [],
  });

  assert.deepEqual(requests[4].body, {
    acks: [],
    retries: [{ lease_id: "lease-xyz" }],
  });
});

test("Cloudflare Queue service throws QueueError on HTTP or API errors without leaking token", async (t) => {
  const mock = await startMockServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      }),
    );
  });
  t.after(() => mock.close());

  const queueService = createCloudflareQueueService({
    accountId: "acc-123",
    apiToken: "do-not-leak-token",
    queueId: "queue-456",
    apiBaseUrl: mock.baseUrl,
  });

  await assert.rejects(
    () => queueService.enqueue({ hello: "world" }),
    (err) => {
      assert.ok(err instanceof QueueError);
      assert.equal(err.statusCode, 401);
      assert.match(err.message, /Authentication error/);
      assert.equal(err.message.includes("do-not-leak-token"), false);
      return true;
    },
  );
});
