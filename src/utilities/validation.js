import { ValidationError } from "./errors.js";

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
