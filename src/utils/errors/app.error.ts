export interface AppError extends Error {
  statusCode: number;
  category?: string;
}

export class InternalServerError implements AppError {
  statusCode: number;
  message: string;
  name: string;
  category: string;
  constructor(message: string) {
    this.statusCode = 500;
    this.message = message;
    this.name = "InternalServerError";
    this.category = "INTERNAL_ERROR";
  }
}

export class BadRequestError implements AppError {
  statusCode: number;
  message: string;
  name: string;
  category: string;
  constructor(message: string) {
    this.statusCode = 400;
    this.message = message;
    this.name = "BadRequestError";
    this.category = "VALIDATION_ERROR";
  }
}

export class ValidationError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
    this.category = "VALIDATION_ERROR";
  }
}

export class NotFoundError implements AppError {
  statusCode: number;
  message: string;
  name: string;
  category: string;
  constructor(message: string) {
    this.statusCode = 404;
    this.message = message;
    this.name = "NotFoundError";
    this.category = "NOT_FOUND_ERROR";
  }
}

export class UnauthorizedError implements AppError {
  statusCode: number;
  message: string;
  name: string;
  category: string;
  constructor(message: string) {
    this.statusCode = 401;
    this.message = message;
    this.name = "UnauthorizedError";
    this.category = "AUTHENTICATION_ERROR";
  }
}

export class AuthenticationError extends UnauthorizedError {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class ForbiddenError implements AppError {
  statusCode: number;
  message: string;
  name: string;
  category: string;
  constructor(message: string) {
    this.statusCode = 403;
    this.message = message;
    this.name = "ForbiddenError";
    this.category = "AUTHORIZATION_ERROR";
  }
}

export class AuthorizationError extends ForbiddenError {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class ConflictError implements AppError {
  statusCode: number;
  message: string;
  name: string;
  category: string;
  constructor(message: string) {
    this.statusCode = 409;
    this.message = message;
    this.name = "ConflictError";
    this.category = "CONFLICT_ERROR";
  }
}

export class RateLimitError implements AppError {
  statusCode: number;
  message: string;
  name: string;
  category: string;
  constructor(message: string) {
    this.statusCode = 429;
    this.message = message;
    this.name = "RateLimitError";
    this.category = "RATE_LIMIT_ERROR";
  }
}

export class ExternalServiceError implements AppError {
  statusCode: number;
  message: string;
  name: string;
  category: string;
  constructor(message: string, statusCode = 503) {
    this.statusCode = statusCode;
    this.message = message;
    this.name = "ExternalServiceError";
    this.category = "EXTERNAL_SERVICE_ERROR";
  }
}

export class DatabaseError implements AppError {
  statusCode: number;
  message: string;
  name: string;
  category: string;
  constructor(message: string, statusCode = 503) {
    this.statusCode = statusCode;
    this.message = message;
    this.name = "DatabaseError";
    this.category = "DATABASE_ERROR";
  }
}

export class NotImplementedError implements AppError {
  statusCode: number;
  message: string;
  name: string;
  category: string;
  constructor(message: string) {
    this.statusCode = 501;
    this.message = message;
    this.name = "NotImplementedError";
    this.category = "NOT_IMPLEMENTED";
  }
}
