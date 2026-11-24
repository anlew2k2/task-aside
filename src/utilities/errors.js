/**
 * Base application error carrying a stable error code across layers.
 */
export class AppError extends Error {
  constructor(message, code = "APP_ERROR") {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, "VALIDATION_ERROR");
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super(message, "NOT_FOUND");
  }
}

export class ConfigError extends AppError {
  constructor(message) {
    super(message, "CONFIG_ERROR");
  }
}

export class QueueError extends AppError {
  constructor(message, { statusCode = null, details = null } = {}) {
    super(message, "QUEUE_ERROR");
    this.statusCode = statusCode;
    this.details = details;
  }
}
