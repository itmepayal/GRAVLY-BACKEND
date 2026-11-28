import { NextFunction, Request, Response } from "express";
import logger from "../config/logger.config.js";
import { AppError } from "../utils/errors/app.error.js";

export const resolveStatusCode = (err: any): number => {
  if (!err) return 500;

  const rawCode = err.statusCode ?? err.status;

  if (typeof rawCode === "number") {
    if (Number.isInteger(rawCode) && rawCode >= 400 && rawCode <= 599) {
      return rawCode;
    }
    return 500;
  }

  if (typeof rawCode === "string") {
    const parsed = parseInt(rawCode, 10);
    if (Number.isInteger(parsed) && parsed >= 400 && parsed <= 599) {
      return parsed;
    }
    return 500;
  }

  return 500;
};

const handleError = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) {
    return next(err);
  }

  const isProduction = process.env.NODE_ENV === "production";
  let statusCode = 500;
  let message = "Internal Server Error";
  let errors: any = undefined;

  if (!err || typeof err !== "object") {
    const fallbackMessage = err ? String(err) : "An unexpected error occurred";
    message = isProduction ? "Internal Server Error" : fallbackMessage;
    logger.error("Non-object error thrown", { error: err });
    res.status(500).json({
      success: false,
      message,
    });
    return;
  }

  if (err.code === 11000) {
    statusCode = 409;
    let field = "";
    if (err.keyValue && typeof err.keyValue === "object") {
      const keys = Object.keys(err.keyValue);
      if (keys.length > 0) {
        field = keys[0];
      }
    }
    message = field
      ? `Duplicate value for field '${field}'. A record with this value already exists.`
      : "Duplicate field value entered. A record with this information already exists.";
  } else if (err.name === "ValidationError") {
    statusCode = 400;
    if (err.errors && typeof err.errors === "object") {
      const errorMessages = Object.values(err.errors)
        .map((val: any) => val?.message || "Invalid field")
        .filter(Boolean);
      message =
        errorMessages.length > 0
          ? errorMessages.join(", ")
          : "Validation failed.";
      errors = err.errors;
    } else {
      message = err.message || "Validation failed.";
    }
  } else if (err.name === "VersionError") {
    statusCode = 409;
    message = "The resource was modified concurrently. Please retry.";
  } else if (err.name === "CastError") {
    statusCode = 400;
    const path = err.path || "identifier";
    const value = err.value !== undefined ? String(err.value) : "invalid value";
    message = `Invalid ${path}: ${value}.`;
  } else if (err.name === "TokenExpiredError") {
    statusCode = 401;
    message = "Token has expired. Please log in again.";
  } else if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    message = "Invalid token. Please authenticate.";
  } else if (err.name === "NotBeforeError") {
    statusCode = 401;
    message = "Token not active yet.";
  } else if (
    (err instanceof SyntaxError && "body" in err) ||
    (err.name === "SyntaxError" &&
      (err.status === 400 || (err as any).statusCode === 400))
  ) {
    statusCode = 400;
    message = "Malformed JSON in request body.";
  } else if (err.name === "MulterError") {
    statusCode = 400;
    message = err.message || "File upload error.";
  } else if (err.name === "ZodError") {
    statusCode = 400;
    if (Array.isArray(err.errors) && err.errors.length > 0) {
      message = err.errors
        .map((e: any) => `${e.path?.join(".") || "field"}: ${e.message}`)
        .join(", ");
      errors = err.errors;
    } else {
      message = "Validation failed.";
    }
  } else if (err.statusCode !== undefined || err.status !== undefined) {
    const candidateStatus = resolveStatusCode(err);
    statusCode = candidateStatus;
    if (candidateStatus >= 500 && isProduction) {
      message = "Internal Server Error";
    } else {
      message =
        err.message ||
        (candidateStatus >= 500
          ? "Internal Server Error"
          : "An error occurred.");
    }
  } else {
    statusCode = 500;
    message = isProduction
      ? "Internal Server Error"
      : err.message || "Internal Server Error";
  }

  const requestId = (req as Request & { requestId?: string }).requestId;
  const route =
    req?.route?.path !== undefined
      ? `${req.baseUrl}${String(req.route.path)}`
      : (req?.originalUrl || req?.url || "/").split("?")[0];
  const userId = req?.user?._id ? String(req.user._id) : undefined;

  if (statusCode >= 500) {
    (res.locals as { __serverErrorLogged?: boolean }).__serverErrorLogged = true;
    logger.error(err.message || "Internal Server Error", {
      requestId,
      statusCode,
      errorCode: err.code,
      name: err.name,
      stack: err.stack,
      method: req?.method,
      route,
      ...(userId ? { userId } : {}),
      operation: "HTTP_ERROR",
    });
  } else {
    logger.debug("Operational request error", {
      requestId,
      statusCode,
      errorCode: err.code,
      name: err.name,
      message,
      method: req?.method,
      route,
      ...(userId ? { userId } : {}),
      operation: "HTTP_OPERATIONAL_ERROR",
    });
  }

  const responsePayload: {
    success: false;
    message: string;
    requestId?: string;
    errors?: any;
    stack?: string;
  } = {
    success: false,
    message,
    ...(requestId ? { requestId } : {}),
  };

  if (!isProduction) {
    if (err.stack) {
      responsePayload.stack = err.stack;
    }
    if (errors !== undefined) {
      responsePayload.errors = errors;
    } else if (err.errors) {
      responsePayload.errors = err.errors;
    }
  }

  res.status(statusCode).json(responsePayload);
};

export const appErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  handleError(err, req, res, next);
};

export const genericErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  handleError(err, req, res, next);
};
