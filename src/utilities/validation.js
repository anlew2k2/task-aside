import { ValidationError } from "#src/utilities/errors.js";
import { isUuidV7 } from "#src/utilities/uuid.js";

export const TASK_SCHEMA_VERSION = "v1";
export const TASK_RESULT_SCHEMA_TYPE = "task_result";
export const TASK_PRIORITIES = Object.freeze(["P0", "P1", "P2", "P3"]);
export const SUPPORTED_AGENTS = Object.freeze(["agy", "claude", "codex"]);
export const PERMISSION_MODES = Object.freeze(["read-only", "workspace", "full"]);
export const PERMISSION_MODE_RANK = Object.freeze({
  "read-only": 0,
  workspace: 1,
  full: 2,
});
export const TASK_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "timeout",
  "interrupted",
  "cancelled",
]);
export const TERMINAL_TASK_STATUSES = Object.freeze([
  "completed",
  "failed",
  "timeout",
  "interrupted",
  "cancelled",
]);

const EXECUTION_ALLOWED_KEYS = new Set([
  "agent",
  "model",
  "effort",
  "cwd",
  "permission_mode",
  "timeout_ms",
  "session_id",
  "worktree",
]);

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertPlainObject(value, message = "Expected an object") {
  if (!isPlainObject(value)) {
    throw new ValidationError(message);
  }
  return value;
}

export function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`Argument "${fieldName}" must be a non-empty string`);
  }
  return value;
}

export function assertString(value, fieldName) {
  if (typeof value !== "string") {
    throw new ValidationError(`Argument "${fieldName}" must be a string`);
  }
  return value;
}

export function assertNullableUuidV7(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isUuidV7(value)) {
    throw new ValidationError(`Argument "${fieldName}" must be a valid UUID v7 or null`);
  }
  return value.toLowerCase();
}

export function assertUuidV7(value, fieldName = "id") {
  if (!isUuidV7(value)) {
    throw new ValidationError(`Argument "${fieldName}" must be a valid UUID v7`);
  }
  return value.toLowerCase();
}

export function assertTaskPriority(value, fieldName = "priority") {
  if (typeof value !== "string" || !TASK_PRIORITIES.includes(value)) {
    throw new ValidationError(
      `Argument "${fieldName}" must be one of: ${TASK_PRIORITIES.join(", ")}`,
    );
  }
  return value;
}

export function assertAgentName(value, fieldName = "execution.agent") {
  if (typeof value !== "string" || !SUPPORTED_AGENTS.includes(value)) {
    throw new ValidationError(
      `Argument "${fieldName}" must be one of: ${SUPPORTED_AGENTS.join(", ")}`,
    );
  }
  return value;
}

export function assertOptionalNonEmptyString(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`Argument "${fieldName}" must be a non-empty string or null`);
  }
  return value.trim();
}

export function assertOptionalPermissionMode(value, fieldName = "execution.permission_mode") {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !PERMISSION_MODES.includes(value)) {
    throw new ValidationError(
      `Argument "${fieldName}" must be one of: ${PERMISSION_MODES.join(", ")}`,
    );
  }
  return value;
}

export function assertOptionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`Argument "${fieldName}" must be a positive integer or null`);
  }
  return value;
}

export function assertOptionalBoolean(value, fieldName, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new ValidationError(`Argument "${fieldName}" must be a boolean`);
  }
  return value;
}

export function assertOptionalIdempotencyKey(value, fieldName = "idempotency_key") {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`Argument "${fieldName}" must be a non-empty string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length > 256) {
    throw new ValidationError(`Argument "${fieldName}" must be at most 256 characters`);
  }
  return trimmed;
}

export function assertTaskExecution(value, fieldName = "execution") {
  const execObj = assertPlainObject(value, `Argument "${fieldName}" must be an object`);
  for (const key of Object.keys(execObj)) {
    if (!EXECUTION_ALLOWED_KEYS.has(key)) {
      throw new ValidationError(`Unsupported execution field "${fieldName}.${key}"`);
    }
  }

  return {
    agent: assertAgentName(execObj.agent, `${fieldName}.agent`),
    model: assertOptionalNonEmptyString(execObj.model, `${fieldName}.model`),
    effort: assertOptionalNonEmptyString(execObj.effort, `${fieldName}.effort`),
    cwd: assertOptionalNonEmptyString(execObj.cwd, `${fieldName}.cwd`),
    permission_mode: assertOptionalPermissionMode(
      execObj.permission_mode,
      `${fieldName}.permission_mode`,
    ),
    timeout_ms: assertOptionalPositiveInteger(execObj.timeout_ms, `${fieldName}.timeout_ms`),
    session_id: assertOptionalNonEmptyString(execObj.session_id, `${fieldName}.session_id`),
    worktree: assertOptionalBoolean(execObj.worktree, `${fieldName}.worktree`, false),
  };
}

export function assertOptionalTaskStatus(value, fieldName = "status") {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !TASK_STATUSES.includes(value)) {
    throw new ValidationError(
      `Argument "${fieldName}" must be one of: ${TASK_STATUSES.join(", ")}`,
    );
  }
  return value;
}

export function assertOptionalAgentName(value, fieldName = "agent") {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return assertAgentName(value, fieldName);
}

export function assertPaginationInt(
  value,
  fieldName,
  { min = 0, max = 200, defaultValue = 50 } = {},
) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  let parsed;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    parsed = Number.parseInt(value.trim(), 10);
  } else {
    throw new ValidationError(
      `Argument "${fieldName}" must be an integer between ${min} and ${max}`,
    );
  }

  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(
      `Argument "${fieldName}" must be an integer between ${min} and ${max}`,
    );
  }

  return parsed;
}
