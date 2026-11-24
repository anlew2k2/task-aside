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
