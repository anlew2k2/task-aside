import { randomBytes } from "node:crypto";

const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let lastTimestampMs = -1;
let lastSequence = 0;

/**
 * Generate an RFC 9562 Section 5.7 UUID v7 (48-bit Unix ms + 12-bit monotonic seq + 62-bit random).
 */
export function generateUuidV7(nowMs = Date.now()) {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError("Timestamp must be a non-negative finite number");
  }

  let ts = Math.trunc(nowMs);
  const bytes = randomBytes(16);

  if (ts > lastTimestampMs) {
    lastTimestampMs = ts;
    // Seed 12-bit sequence with random bits (upper bit cleared to leave headroom in same ms)
    lastSequence = ((bytes[6] & 0x07) << 8) | bytes[7];
  } else {
    ts = lastTimestampMs;
    lastSequence += 1;
    if (lastSequence > 0x0fff) {
      ts += 1;
      lastTimestampMs = ts;
      lastSequence = 0;
    }
  }

  const time = BigInt(ts);
  bytes[0] = Number((time >> 40n) & 0xffn);
  bytes[1] = Number((time >> 32n) & 0xffn);
  bytes[2] = Number((time >> 24n) & 0xffn);
  bytes[3] = Number((time >> 16n) & 0xffn);
  bytes[4] = Number((time >> 8n) & 0xffn);
  bytes[5] = Number(time & 0xffn);

  // Version 7 (0b0111) + 12-bit monotonic sequence
  bytes[6] = 0x70 | ((lastSequence >> 8) & 0x0f);
  bytes[7] = lastSequence & 0xff;

  // Variant RFC 9562 (0b10xxxxxx)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function isUuidV7(value) {
  return typeof value === "string" && UUID_V7_REGEX.test(value);
}
