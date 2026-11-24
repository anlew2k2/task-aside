import { randomBytes } from "node:crypto";

const TRACE_ID_REGEX = /^[0-9a-f]{32}$/i;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/i;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function isValidTraceId(value) {
  return (
    typeof value === "string" &&
    TRACE_ID_REGEX.test(value) &&
    value.toLowerCase() !== ZERO_TRACE_ID
  );
}

export function isValidSpanId(value) {
  return (
    typeof value === "string" &&
    SPAN_ID_REGEX.test(value) &&
    value.toLowerCase() !== ZERO_SPAN_ID
  );
}

export function generateTraceId() {
  let traceId = randomBytes(16).toString("hex");
  while (traceId === ZERO_TRACE_ID) {
    traceId = randomBytes(16).toString("hex");
  }
  return traceId;
}

export function generateSpanId() {
  let spanId = randomBytes(8).toString("hex");
  while (spanId === ZERO_SPAN_ID) {
    spanId = randomBytes(8).toString("hex");
  }
  return spanId;
}

export function parseTraceparent(headerValue) {
  if (typeof headerValue !== "string") {
    return null;
  }

  const match = TRACEPARENT_REGEX.exec(headerValue.trim());
  if (!match) {
    return null;
  }

  const version = match[1].toLowerCase();
  const traceId = match[2].toLowerCase();
  const parentSpanId = match[3].toLowerCase();
  const traceFlags = match[4].toLowerCase();

  if (version === "ff" || !isValidTraceId(traceId) || !isValidSpanId(parentSpanId)) {
    return null;
  }

  return {
    version,
    traceId,
    parentSpanId,
    traceFlags,
  };
}

/**
 * Resolve OpenTelemetry trace_id and span_id, propagating trace_id from W3C traceparent when valid.
 */
export function createTraceContext({ traceparent = null, traceId = null, spanId = null } = {}) {
  const parsed = parseTraceparent(traceparent);
  const resolvedTraceId = isValidTraceId(traceId)
    ? traceId.toLowerCase()
    : parsed?.traceId ?? generateTraceId();
  const resolvedSpanId = isValidSpanId(spanId) ? spanId.toLowerCase() : generateSpanId();

  return {
    trace_id: resolvedTraceId,
    span_id: resolvedSpanId,
  };
}
