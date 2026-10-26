import express from "express";
import cors, { CorsOptions } from "cors";
import swaggerUi from "swagger-ui-express";
import mongoose from "mongoose";
import logger from "../config/logger.config.js";
import { swaggerSpec } from "../config/swagger.config.js";
import v1Router from "../routers/v1/index.router.js";
import {
  appErrorHandler,
  genericErrorHandler,
} from "../middlewares/error.middleware.js";

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:8081",
  "http://localhost:8082",
  "http://localhost:19006",
  "http://localhost:8000",
  "https://gravly-backend.onrender.com",
  process.env.CLIENT_URL,
].filter(Boolean) as string[];

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    logger.warn(`Blocked CORS Origin: ${origin}`);
    return callback(new Error("CORS not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "X-Request-ID",
    "X-Swagger-Key",
  ],
  exposedHeaders: ["X-Request-ID"],
};

export const createApp = (): express.Application => {
  const app = express();

  app.get("/health", (_req, res) => {
    const dbConnected = mongoose.connection.readyState === 1;

    res.status(dbConnected ? 200 : 503).json({
      success: dbConnected,
      message: dbConnected
        ? "Gravil Backend Running Successfully"
        : "Database unavailable",
      database: dbConnected ? "connected" : "disconnected",
    });
  });

  app.get("/ready", (_req, res) => {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      res.status(503).json({ success: false, ready: false });
      return;
    }
    res.status(200).json({ success: true, ready: true });
  });

  app.get("/live", (_req, res) => {
    res.status(200).json({ success: true, live: true });
  });

  app.use(cors(corsOptions));
  app.options(/.*/, cors(corsOptions));

  app.use(express.json({ limit: "1mb" }));

  app.get("/docs-json", (_req, res) => {
    res.json(swaggerSpec);
  });

  app.use(
    "/docs",
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

  app.use("/api/v1", v1Router);

  app.use(appErrorHandler);
  app.use(genericErrorHandler);

  return app;
};

export default createApp;
