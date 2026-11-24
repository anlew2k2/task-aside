import { randomUUID } from "node:crypto";
import { QueueError } from "../utilities/errors.js";

const DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

function extractCloudflareErrorMessage(payload, status) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    return payload.errors
      .map((err) => err?.message || (err?.code ? `code ${err.code}` : null))
      .filter(Boolean)
      .join("; ");
  }
  return `HTTP ${status}`;
}

function parseMessageBody(rawBody) {
  if (typeof rawBody !== "string") {
    return rawBody;
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

/**
 * Cloudflare Queues HTTP API client (push + HTTP pull consumer + ack/retry).
 */
export function createCloudflareQueueService({
  accountId,
  apiToken,
  queueId,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  visibilityTimeoutMs = DEFAULT_VISIBILITY_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new QueueError("Fetch implementation is required for Cloudflare Queue service");
  }

  const baseQueueUrl = `${apiBaseUrl.replace(/\/+$/, "")}/accounts/${encodeURIComponent(
    accountId,
  )}/queues/${encodeURIComponent(queueId)}`;

  async function cfRequest(path, body, { signal } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseQueueUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      throw new QueueError(
        `Cloudflare Queue network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const rawText = await response.text();
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = null;
      }
    }

    if (!response.ok || payload?.success === false) {
      const detailMessage = extractCloudflareErrorMessage(payload, response.status);
      throw new QueueError(`Cloudflare Queue request failed: ${detailMessage}`, {
        statusCode: response.status,
        details: payload?.errors ?? null,
      });
    }

    return payload;
  }

  async function enqueue(taskMessage) {
    await cfRequest("/messages", {
      body: taskMessage,
      content_type: "json",
    });

    return {
      queued: true,
      message: taskMessage,
    };
  }

  async function dequeue({ signal } = {}) {
    const payload = await cfRequest(
      "/messages/pull",
      {
        batch_size: 1,
        visibility_timeout_ms: visibilityTimeoutMs,
      },
      { signal },
    );

    const messages = payload?.result?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }

    const raw = messages[0];
    return {
      queueMessageId: raw.id,
      leaseId: raw.lease_id,
      attempts: raw.attempts ?? 1,
      timestampMs: raw.timestamp_ms ?? null,
      body: parseMessageBody(raw.body),
    };
  }

  async function ack(queueMessage) {
    if (!queueMessage?.leaseId) {
      throw new QueueError("Cannot acknowledge message without leaseId");
    }

    await cfRequest("/messages/ack", {
      acks: [{ lease_id: queueMessage.leaseId }],
      retries: [],
    });
  }

  async function nack(queueMessage, _error) {
    if (!queueMessage?.leaseId) {
      throw new QueueError("Cannot retry message without leaseId");
    }

    await cfRequest("/messages/ack", {
      acks: [],
      retries: [{ lease_id: queueMessage.leaseId }],
    });
  }

  async function stats() {
    return {
      provider: "cloudflare",
      queueId,
    };
  }

  return {
    enqueue,
    dequeue,
    ack,
    nack,
    stats,
  };
}

/**
 * In-memory FIFO queue service matching the Cloudflare Queue service contract for tests.
 */
export function createInMemoryQueueService() {
  const queue = [];
  const inFlight = new Map();

  async function enqueue(taskMessage) {
    const record = {
      id: randomUUID(),
      body: structuredClone(taskMessage),
      attempts: 0,
      timestampMs: Date.now(),
    };
    queue.push(record);
    return {
      queued: true,
      message: structuredClone(taskMessage),
    };
  }

  async function dequeue() {
    const record = queue.shift();
    if (!record) {
      return null;
    }

    record.attempts += 1;
    const leaseId = randomUUID();
    inFlight.set(leaseId, record);

    return {
      queueMessageId: record.id,
      leaseId,
      attempts: record.attempts,
      timestampMs: record.timestampMs,
      body: structuredClone(record.body),
    };
  }

  async function ack(queueMessage) {
    if (queueMessage?.leaseId) {
      inFlight.delete(queueMessage.leaseId);
    }
  }

  async function nack(queueMessage, _error) {
    if (queueMessage?.leaseId && inFlight.has(queueMessage.leaseId)) {
      const record = inFlight.get(queueMessage.leaseId);
      inFlight.delete(queueMessage.leaseId);
      queue.push(record);
    }
  }

  async function stats() {
    return {
      provider: "in-memory",
      queuedCount: queue.length,
    };
  }

  return {
    enqueue,
    dequeue,
    ack,
    nack,
    stats,
  };
}
