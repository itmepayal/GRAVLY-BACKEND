import type { CorsOptions } from "cors";
import { serverConfig } from "./index.js";
import logger from "./logger.config.js";
import { ForbiddenError } from "../utils/errors/app.error.js";

const DEV_LOCAL_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:8081",
  "http://localhost:8082",
  "http://localhost:19006",
  "http://localhost:8000",
];

const PROD_BACKEND_SELF_ORIGINS = ["https://gravly-backend-api.onrender.com"];

export const ALLOWED_CORS_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

export const ALLOWED_CORS_HEADERS = [
  "Content-Type",
  "Authorization",
  "Accept",
  "Origin",
  "X-Requested-With",
  "X-Request-ID",
  "X-Swagger-Key",
  "Idempotency-Key",
];

export const EXPOSED_CORS_HEADERS = ["X-Request-ID"];

export const extractOrigin = (rawUrl?: string): string | null => {
  if (!rawUrl || !rawUrl.trim()) return null;
  try {
    return new URL(rawUrl.trim()).origin;
  } catch {
    return null;
  }
};

export const normalizeOrigin = (origin: string): string =>
  origin.trim().replace(/\/+$/, "");

export const getAllowedOrigins = (): string[] => {
  const configured = [...serverConfig.CORS_ORIGINS];

  for (const candidate of [
    extractOrigin(serverConfig.CLIENT_URL),
    extractOrigin(serverConfig.SERVER_URL),
    extractOrigin(serverConfig.API_BASE_URL),
    ...(serverConfig.NODE_ENV === "production"
      ? PROD_BACKEND_SELF_ORIGINS
      : []),
  ]) {
    if (candidate) {
      configured.push(candidate);
    }
  }

  if (serverConfig.NODE_ENV !== "production") {
    configured.push(...DEV_LOCAL_ORIGINS);
  }

  return Array.from(new Set(configured));
};

export const isOriginAllowed = (origin: string): boolean => {
  const normalizedOrigin = normalizeOrigin(origin);
  return getAllowedOrigins().includes(normalizedOrigin);
};

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    logger.warn("Blocked CORS origin", {
      origin: normalizeOrigin(origin),
      env: serverConfig.NODE_ENV,
    });
    return callback(new ForbiddenError("CORS origin not allowed"));
  },
  credentials: true,
  methods: ALLOWED_CORS_METHODS,
  allowedHeaders: ALLOWED_CORS_HEADERS,
  exposedHeaders: EXPOSED_CORS_HEADERS,
  optionsSuccessStatus: 204,
  preflightContinue: false,
  maxAge: 600,
};
