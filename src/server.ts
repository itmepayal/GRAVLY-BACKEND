import http, { type Server } from "http";

import { connectDB } from "./config/db.config.js";
import { initRedis, closeRedis } from "./config/redis.config.js";
import logger, { flushLoggers } from "./config/logger.config.js";
import { serverConfig } from "./config/index.js";
import createApp, { markServerDraining } from "./app/app.js";
import { initSocketServer, closeSocketServer } from "./socket/index.js";
import { startBackgroundJobs, stopBackgroundJobs } from "./job/index.js";

let httpServer: Server | undefined;
let isShuttingDown = false;
let memoryMonitorTimer: NodeJS.Timeout | undefined;

const shutdown = async (signal: string): Promise<void> => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  markServerDraining(true);

  if (memoryMonitorTimer) {
    clearInterval(memoryMonitorTimer);
    memoryMonitorTimer = undefined;
  }

  logger.info(`${signal} received. Starting graceful shutdown...`);

  const forceShutdownTimer = setTimeout(() => {
    logger.error("Graceful shutdown timed out. Forcing process exit.");
    process.exit(1);
  }, 10_000);

  forceShutdownTimer.unref();

  try {
    const drainDelayMs = Number(process.env.SHUTDOWN_DRAIN_DELAY_MS) || 0;
    if (drainDelayMs > 0) {
      await new Promise((r) => setTimeout(r, drainDelayMs));
    }

    await stopBackgroundJobs();

    if (httpServer) {
      httpServer.closeIdleConnections?.();
    }

    await closeSocketServer();

    if (httpServer && httpServer.listening) {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          httpServer!.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
          httpServer!.closeIdleConnections?.();
        }),
        new Promise<void>((resolve) => {
          const drainTimer = setTimeout(() => {
            httpServer?.closeAllConnections?.();
            resolve();
          }, 2500);
          if (drainTimer.unref) drainTimer.unref();
        }),
      ]);

      logger.info("HTTP server closed successfully.");
    }

    await closeRedis();

    const mongoose = await import("mongoose");

    if (mongoose.default.connection.readyState !== 0) {
      await mongoose.default.connection.close();
      logger.info("MongoDB connection closed successfully.");
    }

    clearTimeout(forceShutdownTimer);

    logger.info("Graceful shutdown completed.");
    await flushLoggers(1500);
    process.exit(0);
  } catch (error: unknown) {
    clearTimeout(forceShutdownTimer);

    logger.error("Error during graceful shutdown.", {
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : error,
    });

    await flushLoggers(1000);
    process.exit(1);
  }
};

const startServer = async (): Promise<void> => {
  try {
    await connectDB();
    await initRedis();
    const app = createApp();

    httpServer = http.createServer(app);
    httpServer.keepAliveTimeout = 65_000;
    httpServer.headersTimeout = 66_000;
    httpServer.requestTimeout = 30_000;
    httpServer.maxRequestsPerSocket = 0;

    await initSocketServer(httpServer);

    httpServer.listen(serverConfig.PORT, "0.0.0.0", () => {
      logger.info(`Gravly Backend running on port ${serverConfig.PORT}`, {
        pid: process.pid,
        workerIndex: process.env.NODE_APP_INSTANCE ?? "standalone",
      });

      logger.info(`Health check: http://localhost:${serverConfig.PORT}/health`);

      logger.info(
        `API documentation: http://localhost:${serverConfig.PORT}/docs`,
      );

      logger.info("Press Ctrl+C to stop the server.");

      if (typeof process.send === "function") {
        process.send("ready");
      }
    });

    startBackgroundJobs();

    const memoryWarnMb = Number(process.env.MEMORY_WARN_MB) || 768;
    memoryMonitorTimer = setInterval(() => {
      const mem = process.memoryUsage();
      const rssMb = Math.round((mem.rss / 1048576) * 100) / 100;
      const heapMb = Math.round((mem.heapUsed / 1048576) * 100) / 100;
      if (rssMb >= memoryWarnMb) {
        logger.warn("[process] High memory usage detected", {
          pid: process.pid,
          rssMb,
          heapMb,
          thresholdMb: memoryWarnMb,
        });
      }
    }, 30_000);
    if (memoryMonitorTimer.unref) memoryMonitorTimer.unref();

    httpServer.on("error", (error: NodeJS.ErrnoException) => {
      logger.error("HTTP server error.", {
        code: error.code,
        message: error.message,
      });

      if (error.code === "EADDRINUSE") {
        logger.error(`Port ${serverConfig.PORT} is already in use.`);
      }

      process.exit(1);
    });

    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });

    process.on("unhandledRejection", (reason: unknown) => {
      logger.error("Unhandled promise rejection detected", {
        operation: "UNHANDLED_REJECTION",
        error:
          reason instanceof Error
            ? { name: reason.name, message: reason.message, stack: reason.stack }
            : String(reason),
      });
    });

    process.once("uncaughtException", (err: Error) => {
      logger.error("Uncaught exception detected; initiating controlled shutdown", {
        operation: "UNCAUGHT_EXCEPTION",
        error: { name: err.name, message: err.message, stack: err.stack },
      });
      void shutdown("uncaughtException");
    });
  } catch (error: unknown) {
    logger.error("Application startup failed.", {
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : error,
    });

    process.exitCode = 1;
  }
};

void startServer();
