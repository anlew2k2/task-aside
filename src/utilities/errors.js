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

export class StorageError extends AppError {
  constructor(message, { statusCode = null, details = null } = {}) {
    super(message, "STORAGE_ERROR");
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class AgentExecutionError extends AppError {
  constructor(message, { code = "AGENT_EXECUTION_ERROR", category = "execution", details = null } = {}) {
    super(message, code);
    this.category = category;
    this.details = details;
  }
}
