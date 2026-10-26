import mongoose from "mongoose";
import "dotenv/config";

import { serverConfig } from ".";
import logger from "./logger.config";

const MONGO_URL = serverConfig.MONGODB_URI;

/**
 * =========================================================
 * DATABASE CONNECTION
 * =========================================================
 */

export const connectDB = async (): Promise<void> => {
  try {
    /**
     * =====================================================
     * MONGOOSE CONNECTION
     * =====================================================
     */

    const connection = await mongoose.connect(MONGO_URL, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });

    /**
     * =====================================================
     * SUCCESS LOG
     * =====================================================
     */

    logger.info(
      `MongoDB connected successfully: ${connection.connection.host}`,
    );
  } catch (error) {
    /**
     * =====================================================
     * ERROR LOG
     * =====================================================
     */

    logger.error("MongoDB connection failed", {
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

/**
 * =========================================================
 * CONNECTION EVENTS
 * =========================================================
 */

mongoose.connection.on("connecting", () => {
  logger.info("MongoDB connection is connecting...");
});

mongoose.connection.on("connected", () => {
  logger.info("MongoDB connection established");
});

mongoose.connection.on("open", () => {
  logger.info("MongoDB connection is open");
});

mongoose.connection.on("reconnected", () => {
  logger.info("MongoDB reconnected successfully");
});

mongoose.connection.on("disconnecting", () => {
  logger.warn("MongoDB connection is disconnecting...");
});

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB disconnected");
});

mongoose.connection.on("close", () => {
  logger.warn("MongoDB connection closed");
});

mongoose.connection.on("error", (error) => {
  logger.error("MongoDB connection error", {
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
    },
  });
});

export const closeDB = async (): Promise<void> => {
  await mongoose.connection.close();
};