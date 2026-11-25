import mongoose, { ClientSession } from "mongoose";
import "dotenv/config";

import { serverConfig } from "./index.js";
import logger from "./logger.config.js";

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

    /**
     * Connection pool budgeting:
     * Single instance: maxPoolSize: 200
     * Clustered mode (e.g. 8 PM2 workers): maxPoolSize: 50 (8 × 50 = 400 total connections)
     */
    const maxPoolSize =
      Number(process.env.DB_MAX_POOL_SIZE) ||
      (process.env.CLUSTER_MODE === "true" ? 50 : 200);
    const minPoolSize = Math.max(5, Math.floor(maxPoolSize * 0.1));
    const slowQueryThresholdMs = Number(process.env.MONGO_SLOW_QUERY_MS) || 150;

    const connection = await mongoose.connect(MONGO_URL, {
      maxPoolSize,
      minPoolSize,
      maxConnecting: 20,
      maxIdleTimeMS: 60000,
      waitQueueTimeoutMS: 5000,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      monitorCommands: process.env.MONGO_MONITOR_COMMANDS === "true",
    });

    if (process.env.MONGO_MONITOR_COMMANDS === "true") {
      const mongoClient = connection.connection.getClient();
      mongoClient.on("commandSucceeded", (ev) => {
        if (ev.duration >= slowQueryThresholdMs) {
          logger.warn("[mongo] Slow database command", {
            commandName: ev.commandName,
            durationMs: ev.duration,
          });
        }
      });
    }

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

/**
 * Determine whether the connected MongoDB topology supports multi-document ACID transactions
 * (Replica Set or Sharded Cluster / Mongos). Standalone instances return false.
 */
export const supportsMongoTransactions = (): boolean => {
  const client = mongoose.connection.getClient?.() as
    | { topology?: { description?: { type?: string } } }
    | undefined;
  const topologyType = client?.topology?.description?.type;
  return (
    topologyType === "ReplicaSetWithPrimary" ||
    topologyType === "ReplicaSetNoPrimary" ||
    topologyType === "Sharded" ||
    topologyType === "LoadBalanced"
  );
};

/**
 * Execute a multi-document workflow inside a MongoDB transaction when supported by topology,
 * falling back cleanly on standalone MongoDB without masking real database errors.
 */
export const runWithOptionalTransaction = async <T>(
  work: (session?: ClientSession) => Promise<T>,
): Promise<T> => {
  if (!supportsMongoTransactions()) {
    return work(undefined);
  }

  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};
