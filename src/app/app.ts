import crypto from "crypto";
import express, { Request, RequestHandler } from "express";
import cors, { CorsOptions } from "cors";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import mongoose from "mongoose";
import logger, { runWithLogContext } from "../config/logger.config.js";
import { serverConfig } from "../config/index.js";
import { swaggerSpec } from "../config/swagger.config.js";
import v1Router from "../routers/v1/index.router.js";
import {
  authenticate,
  authorize,
} from "../middlewares/authenticate.middleware.js";
import {
  appErrorHandler,
  genericErrorHandler,
} from "../middlewares/error.middleware.js";
import { multerErrorHandler } from "../middlewares/upload.middleware.js";
import { ForbiddenError, NotFoundError } from "../utils/errors/app.error.js";

import { getRedisHealthDetails } from "../config/redis.config.js";
import { isRedisAvailable } from "../infrastructure/redis/index.js";
import { getSocketHealthStatus } from "../socket/index.js";

const devLocalOrigins = [
  "http://localhost:3000",
  "http://localhost:8081",
  "http://localhost:8082",
  "http://localhost:19006",
  "http://localhost:8000",
];

const extractOrigin = (rawUrl?: string): string | null => {
  if (!rawUrl || !rawUrl.trim()) return null;
  try {
    return new URL(rawUrl.trim()).origin;
  } catch {
    return null;
  }
};

const getAllowedOrigins = (): string[] => {
  const configured = [...serverConfig.CORS_ORIGINS];
  for (const candidate of [
    extractOrigin(serverConfig.SERVER_URL),
    extractOrigin(serverConfig.API_BASE_URL),
    ...(serverConfig.NODE_ENV === "production"
      ? ["https://gravly-backend-api.onrender.com"]
      : []),
  ]) {
    if (candidate) configured.push(candidate);
  }
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

  app.use((req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const sanitized =
      typeof incoming === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(incoming)
        ? incoming
        : crypto.randomUUID();
    (req as Request & { requestId?: string }).requestId = sanitized;
    res.setHeader("X-Request-ID", sanitized);

    const startedAt = performance.now();
    const rawPath = (req.originalUrl || req.url || "/").split("?")[0];
    const isHealthProbe =
      rawPath === "/health" || rawPath === "/live" || rawPath === "/ready";

    res.once("finish", () => {
      if (
        (res.locals as { __serverErrorLogged?: boolean }).__serverErrorLogged
      ) {
        return;
      }

      const durationMs =
        Math.round((performance.now() - startedAt) * 100) / 100;
      const statusCode = res.statusCode;
      const routeTemplate = req.route?.path
        ? `${req.baseUrl}${String(req.route.path)}`
        : rawPath;
      const userId = req.user?._id ? String(req.user._id) : undefined;
      const contentLengthHeader = res.getHeader("content-length");
      const responseBytes =
        typeof contentLengthHeader === "string" ||
        typeof contentLengthHeader === "number"
          ? Number(contentLengthHeader)
          : undefined;

      const meta = {
        requestId: sanitized,
        method: req.method,
        route: routeTemplate,
        statusCode,
        durationMs,
        ...(responseBytes !== undefined && Number.isFinite(responseBytes)
          ? { responseBytes }
          : {}),
        ip: req.ip,
        ...(userId ? { userId } : {}),
        operation: "HTTP_REQUEST",
      };

      if (statusCode >= 500) {
        logger.error("HTTP request failed", meta);
      } else if (statusCode >= 400) {
        if (!isHealthProbe) {
          logger.warn("HTTP request completed with client error", meta);
        }
      } else if (isHealthProbe) {
        logger.debug("Health probe completed", meta);
      } else {
        logger.info("HTTP request completed", meta);
      }
    });

    runWithLogContext(
      {
        requestId: sanitized,
        method: req.method,
        route: rawPath,
        ip: req.ip,
      },
      next,
    );
  });

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

    const isHealthy = dbConnected;

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
    const redisRequired =
      process.env.REDIS_REVOCATION_FAIL_CLOSED !== undefined
        ? process.env.REDIS_REVOCATION_FAIL_CLOSED !== "false"
        : serverConfig.REDIS_REVOCATION_FAIL_CLOSED;
    const redisReady = !redisRequired || isRedisAvailable();
    const ready = dbConnected && redisReady && !serverDraining;

    if (!ready) {
      res.status(503).json({
        success: false,
        ready: false,
        draining: serverDraining,
        dependencies: {
          database: dbConnected ? "ready" : "unavailable",
          redis: !redisRequired
            ? "optional"
            : redisReady
              ? "ready"
              : "unavailable",
        },
      });
      return;
    }
    res.status(200).json({
      success: true,
      ready: true,
      dependencies: {
        database: "ready",
        redis: redisRequired ? "ready" : "optional",
      },
    });
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

  const safeKeyEquals = (a: string, b: string): boolean => {
    const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
    const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
    return crypto.timingSafeEqual(hashA, hashB);
  };

  const swaggerAccessGuard: RequestHandler = (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const configuredKey = process.env.SWAGGER_ACCESS_KEY?.trim();
    const headerKey =
      typeof req.headers["x-swagger-key"] === "string"
        ? req.headers["x-swagger-key"].trim()
        : "";

    if (
      configuredKey &&
      configuredKey.length >= 16 &&
      headerKey &&
      safeKeyEquals(headerKey, configuredKey)
    ) {
      next();
      return;
    }

    authenticate(req, res, (authErr?: unknown) => {
      if (authErr) {
        next(authErr);
        return;
      }
      authorize("admin")(req, res, next);
    });
  };

  const swaggerEnabled =
    process.env.ENABLE_SWAGGER?.trim().toLowerCase() !== "false";
  const configuredSwaggerKey = process.env.SWAGGER_ACCESS_KEY?.trim() ?? "";
  const swaggerRestricted =
    process.env.SWAGGER_REQUIRE_AUTH?.trim().toLowerCase() === "true" ||
    configuredSwaggerKey.length >= 16;

  if (swaggerEnabled) {
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
        upgradeInsecureRequests:
          serverConfig.NODE_ENV === "production" ? [] : null,
      },
    });

    const noStoreHeader: RequestHandler = (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    };

    const redirectDocsRoot: RequestHandler = (req, res, next) => {
      const cleanOriginal = (req.originalUrl || req.url || "").split("?")[0];
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        cleanOriginal === "/docs"
      ) {
        const queryIdx = (req.originalUrl || "").indexOf("?");
        const qs = queryIdx >= 0 ? req.originalUrl.slice(queryIdx) : "";
        res.redirect(301, `/docs/${qs}`);
        return;
      }
      next();
    };

    const swaggerMiddlewares: RequestHandler[] = swaggerRestricted
      ? [swaggerAccessGuard, swaggerCsp]
      : [noStoreHeader, swaggerCsp];

    app.get("/docs-json", ...swaggerMiddlewares, (_req, res) => {
      res.json(swaggerSpec);
    });

    app.use(
      "/docs",
      ...swaggerMiddlewares,
      redirectDocsRoot,
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

  app.use((req, _res, next) => {
    logger.warn("Route not found", {
      requestId: (req as Request & { requestId?: string }).requestId,
      method: req.method,
      route: (req.originalUrl || req.url).split("?")[0],
      operation: "HTTP_NOT_FOUND",
    });
    next(new NotFoundError("Route not found"));
  });

  app.use(multerErrorHandler);
  app.use(appErrorHandler);
  app.use(genericErrorHandler);

  return app;
};

export default createApp;
