import { randomUUID } from "node:crypto";

/**
 * In-memory FIFO queue service.
 * External integration boundary intended to be swapped with Cloudflare Queue or another broker.
 */
export function createQueueService() {
  const queue = [];

  async function enqueue(payload) {
    const message = {
      id: randomUUID(),
      ...payload,
      enqueuedAt: new Date().toISOString(),
    };
    queue.push(message);
    return { ...message };
  }

  async function dequeue() {
    const message = queue.shift();
    return message ? { ...message } : null;
  }

  async function ack(_message) {
    // No-op for in-memory queue; external brokers (e.g. Cloudflare Queue) ack explicitly.
  }

  async function nack(_message, _error) {
    // No-op for in-memory queue; external brokers can retry or dead-letter.
  }

  async function stats() {
    return {
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
