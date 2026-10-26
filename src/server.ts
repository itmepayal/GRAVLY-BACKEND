import type { Server } from "http";

import { connectDB } from "./config/db.config";
import logger from "./config/logger.config";
import { serverConfig } from "./config";
import createApp from "./app/app";

let httpServer: Server | undefined;
let isShuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  logger.info(`${signal} received. Starting graceful shutdown...`);

  const forceShutdownTimer = setTimeout(() => {
    logger.error("Graceful shutdown timed out. Forcing process exit.");
    process.exit(1);
  }, 10_000);

  forceShutdownTimer.unref();

  try {
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      logger.info("HTTP server closed successfully.");
    }

    const mongoose = await import("mongoose");

    if (mongoose.default.connection.readyState !== 0) {
      await mongoose.default.connection.close();
      logger.info("MongoDB connection closed successfully.");
    }

    clearTimeout(forceShutdownTimer);

    logger.info("Graceful shutdown completed.");
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

    process.exit(1);
  }
};

const startServer = async (): Promise<void> => {
  try {
    await connectDB();
    const app = createApp();

    httpServer = app.listen(serverConfig.PORT, "0.0.0.0", () => {
      logger.info(`Gravly Backend running on port ${serverConfig.PORT}`);

      logger.info(`Health check: http://localhost:${serverConfig.PORT}/health`);

      logger.info(
        `API documentation: http://localhost:${serverConfig.PORT}/docs`,
      );

      logger.info("Press Ctrl+C to stop the server.");
    });

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
