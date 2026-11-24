import { ValidationError } from "./errors.js";
import { isUuidV7 } from "./uuid.js";

export const TASK_SCHEMA_VERSION = "v1";
export const TASK_PRIORITIES = Object.freeze(["P0", "P1", "P2", "P3"]);

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

export function assertTaskPriority(value, fieldName = "priority") {
  if (typeof value !== "string" || !TASK_PRIORITIES.includes(value)) {
    throw new ValidationError(
      `Argument "${fieldName}" must be one of: ${TASK_PRIORITIES.join(", ")}`,
    );
  }
  return value;
}
