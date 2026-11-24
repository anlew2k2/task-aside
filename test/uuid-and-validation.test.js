import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "../src/utilities/errors.js";
import { generateUuidV7, isUuidV7 } from "../src/utilities/uuid.js";
import {
  assertAgentName,
  assertNonEmptyString,
  assertNullableUuidV7,
  assertOptionalAgentName,
  assertOptionalPermissionMode,
  assertOptionalTaskStatus,
  assertPaginationInt,
  assertPlainObject,
  assertString,
  assertTaskExecution,
  assertTaskPriority,
  assertUuidV7,
  PERMISSION_MODES,
  SUPPORTED_AGENTS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "../src/utilities/validation.js";

test("generateUuidV7 creates valid RFC 9562 v7 UUIDs with embedded timestamp", () => {
  const fixedMs = Date.now() + 5_000;
  const id = generateUuidV7(fixedMs);

  assert.equal(isUuidV7(id), true);
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  const hex = id.replaceAll("-", "");
  const extractedMs = Number.parseInt(hex.slice(0, 12), 16);
  assert.equal(extractedMs, fixedMs);
});

test("generateUuidV7 is strictly monotonic within the same millisecond", () => {
  const sameMs = Date.now() + 10_000;
  const ids = [];
  for (let i = 0; i < 200; i += 1) {
    ids.push(generateUuidV7(sameMs));
  }

  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(
      ids[i] > ids[i - 1],
      `Expected ${ids[i]} > ${ids[i - 1]} at index ${i}`,
    );
    assert.equal(isUuidV7(ids[i]), true);
  }
});

test("isUuidV7 rejects v4 and malformed UUIDs", () => {
  assert.equal(isUuidV7("550e8400-e29b-41d4-a716-446655440000"), false);
  assert.equal(isUuidV7("01935e8b-0000-7000-0000-000000000000"), false);
  assert.equal(isUuidV7("not-a-uuid"), false);
  assert.equal(isUuidV7(null), false);
});

test("validation helpers enforce task and execution field rules", () => {
  assert.deepEqual(assertPlainObject({ a: 1 }), { a: 1 });
  assert.throws(() => assertPlainObject([]), ValidationError);

  assert.equal(assertNonEmptyString("Ship feature", "title"), "Ship feature");
  assert.throws(() => assertNonEmptyString("   ", "title"), ValidationError);

  assert.equal(assertString("", "description"), "");
  assert.equal(assertString("# Heading", "description"), "# Heading");
  assert.throws(() => assertString(123, "description"), ValidationError);

  assert.equal(assertNullableUuidV7(undefined, "parent_id"), null);
  assert.equal(assertNullableUuidV7(null, "parent_id"), null);

  const upper = generateUuidV7().toUpperCase();
  assert.equal(assertNullableUuidV7(upper, "parent_id"), upper.toLowerCase());
  assert.equal(assertUuidV7(upper, "id"), upper.toLowerCase());
  assert.throws(() => assertUuidV7(null, "id"), ValidationError);
  assert.throws(
    () => assertNullableUuidV7("550e8400-e29b-41d4-a716-446655440000", "parent_id"),
    ValidationError,
  );

  for (const priority of TASK_PRIORITIES) {
    assert.equal(assertTaskPriority(priority), priority);
  }
  assert.throws(() => assertTaskPriority("P4"), ValidationError);
  assert.throws(() => assertTaskPriority("high"), ValidationError);

  for (const agent of SUPPORTED_AGENTS) {
    assert.equal(assertAgentName(agent), agent);
    assert.equal(assertOptionalAgentName(agent), agent);
  }
  assert.equal(assertOptionalAgentName(undefined), null);
  assert.equal(assertOptionalAgentName(""), null);
  assert.throws(() => assertAgentName("unknown"), ValidationError);

  for (const mode of PERMISSION_MODES) {
    assert.equal(assertOptionalPermissionMode(mode), mode);
  }
  assert.equal(assertOptionalPermissionMode(null), null);
  assert.throws(() => assertOptionalPermissionMode("root"), ValidationError);

  for (const status of TASK_STATUSES) {
    assert.equal(assertOptionalTaskStatus(status), status);
  }
  assert.equal(assertOptionalTaskStatus(undefined), null);
  assert.throws(() => assertOptionalTaskStatus("pending"), ValidationError);

  assert.equal(assertPaginationInt(undefined, "limit", { min: 1, max: 200, defaultValue: 50 }), 50);
  assert.equal(assertPaginationInt("25", "limit", { min: 1, max: 200, defaultValue: 50 }), 25);
  assert.throws(() => assertPaginationInt("0", "limit", { min: 1, max: 200, defaultValue: 50 }), ValidationError);
  assert.throws(() => assertPaginationInt("201", "limit", { min: 1, max: 200, defaultValue: 50 }), ValidationError);

  assert.deepEqual(
    assertTaskExecution({
      agent: "codex",
      model: " gpt-5 ",
      effort: "medium",
      cwd: "/tmp/repo",
      permission_mode: "workspace",
      timeout_ms: 120000,
      session_id: "thread_1",
    }),
    {
      agent: "codex",
      model: "gpt-5",
      effort: "medium",
      cwd: "/tmp/repo",
      permission_mode: "workspace",
      timeout_ms: 120000,
      session_id: "thread_1",
    },
  );

  assert.deepEqual(assertTaskExecution({ agent: "agy" }), {
    agent: "agy",
    model: null,
    effort: null,
    cwd: null,
    permission_mode: null,
    timeout_ms: null,
    session_id: null,
  });

  assert.throws(() => assertTaskExecution({ agent: "agy", extra: 1 }), ValidationError);
  assert.throws(() => assertTaskExecution({ agent: "codex", timeout_ms: -5 }), ValidationError);
  assert.throws(() => assertTaskExecution(null), ValidationError);
});
