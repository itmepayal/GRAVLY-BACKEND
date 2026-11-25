import crypto from "crypto";
import express, { Request } from "express";
import cors, { CorsOptions } from "cors";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import mongoose from "mongoose";
import logger from "../config/logger.config.js";
import { serverConfig } from "../config/index.js";
import { swaggerSpec } from "../config/swagger.config.js";
import v1Router from "../routers/v1/index.router.js";
import {
  appErrorHandler,
  genericErrorHandler,
} from "../middlewares/error.middleware.js";
import { multerErrorHandler } from "../middlewares/upload.middleware.js";
import { ForbiddenError, NotFoundError } from "../utils/errors/app.error.js";

import { getRedisHealthDetails } from "../config/redis.config.js";
import { getSocketHealthStatus } from "../socket/index.js";

const devLocalOrigins = [
  "http://localhost:3000",
  "http://localhost:8081",
  "http://localhost:8082",
  "http://localhost:19006",
  "http://localhost:8000",
];

const getAllowedOrigins = (): string[] => {
  const configured = [...serverConfig.CORS_ORIGINS];
  if (serverConfig.NODE_ENV !== "production") {
    configured.push(...devLocalOrigins);
  }
  return Array.from(new Set(configured));
};

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = origin.trim().replace(/\/+$/, "");
    const allowed = getAllowedOrigins();

    if (allowed.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    logger.warn("Blocked CORS origin", { origin: normalizedOrigin });
    return callback(new ForbiddenError("CORS origin not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "X-Request-ID",
    "X-Swagger-Key",
    "Idempotency-Key",
  ],
  exposedHeaders: ["X-Request-ID"],
  maxAge: 600,
};

const resolveTrustProxy = (): boolean | number | string => {
  const raw = process.env.TRUST_PROXY?.trim();
  if (raw !== undefined) {
    if (!raw || raw === "false") return false;
    if (raw === "true") return 1;
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw;
  }
  return serverConfig.TRUST_PROXY;
};

let serverDraining = false;

export const markServerDraining = (draining = true): void => {
  serverDraining = draining;
};

export const isServerDraining = (): boolean => serverDraining;

export const createApp = (): express.Application => {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", resolveTrustProxy());

  // Request correlation ID
  app.use((req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const sanitized =
      typeof incoming === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(incoming)
        ? incoming
        : crypto.randomUUID();
    (req as Request & { requestId?: string }).requestId = sanitized;
    res.setHeader("X-Request-ID", sanitized);
    next();
  });

  // Strict HTTP security headers via Helmet
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", ...getAllowedOrigins()],
          fontSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      hsts:
        serverConfig.NODE_ENV === "production"
          ? {
              maxAge: 31536000,
              includeSubDomains: true,
              preload: false,
            }
          : false,
      frameguard: { action: "deny" },
      noSniff: true,
      referrerPolicy: { policy: "no-referrer" },
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  app.get("/health", async (_req, res) => {
    const dbConnected = mongoose.connection.readyState === 1;
    const [redisDetails, socketStatus] = await Promise.all([
      getRedisHealthDetails(),
      Promise.resolve(getSocketHealthStatus()),
    ]);

    const isHealthy = dbConnected; // MongoDB is mandatory; Redis is ephemeral cache/rate limiter

    res.status(isHealthy ? 200 : 503).json({
      success: isHealthy,
      message: isHealthy
        ? "Gravly Backend Running Successfully"
        : "Critical database unavailable",
      services: {
        database: dbConnected ? "connected" : "disconnected",
        redis: redisDetails.healthy ? "healthy" : "degraded",
        socket: socketStatus.initialized ? "ready" : "uninitialized",
      },
      diagnostics: {
        redis: redisDetails,
        socket: socketStatus,
      },
    });
  });

  app.get("/ready", (_req, res) => {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected || serverDraining) {
      res.status(503).json({
        success: false,
        ready: false,
        draining: serverDraining,
      });
      return;
    }
    res.status(200).json({ success: true, ready: true });
  });

  app.get("/live", (_req, res) => {
    res.status(200).json({ success: true, live: true });
  });

  app.use(cors(corsOptions));
  app.options(/.*/, cors(corsOptions));

  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );

  if (
    serverConfig.NODE_ENV !== "production" ||
    process.env.ENABLE_SWAGGER === "true"
  ) {
    const swaggerCsp = helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", ...getAllowedOrigins()],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    });

    app.get("/docs-json", swaggerCsp, (_req, res) => {
      res.json(swaggerSpec);
    });

    app.use(
      "/docs",
      swaggerCsp,
      swaggerUi.serve,
      swaggerUi.setup(swaggerSpec, {
        swaggerOptions: {
          withCredentials: true,
          persistAuthorization: true,
          url: "/docs-json",
        },
        customSiteTitle: "Gravly API Docs",
      }),
    );
  }

  app.use("/api/v1", v1Router);

  app.use((_req, _res, next) => {
    next(new NotFoundError("Route not found"));
  });

  app.use(multerErrorHandler);
  app.use(appErrorHandler);
  app.use(genericErrorHandler);

  return app;
};

export default createApp;
