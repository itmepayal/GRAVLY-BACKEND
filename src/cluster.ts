import cluster from "node:cluster";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./config/index.js";
import logger from "./config/logger.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "server.js");

const resolveWorkerCount = (): number => {
  const configured = Number(process.env.CLUSTER_WORKERS || process.env.WEB_CONCURRENCY);
  if (Number.isInteger(configured) && configured >= 1) {
    return configured;
  }
  return Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
};

if (cluster.isPrimary) {
  const workerCount = resolveWorkerCount();
  let shuttingDown = false;

  cluster.setupPrimary({ exec: serverEntry });

  logger.info(`[cluster] Primary ${process.pid} spawning ${workerCount} workers`);

  const spawnWorker = (instanceIndex: number) => {
    const worker = cluster.fork({
      ...process.env,
      CLUSTER_MODE: "true",
      NODE_APP_INSTANCE: String(instanceIndex),
    });
    worker.on("exit", (code, signal) => {
      if (shuttingDown) return;
      logger.warn("[cluster] Worker exited unexpectedly; restarting", {
        workerId: worker.id,
        instanceIndex,
        code,
        signal,
      });
      spawnWorker(instanceIndex);
    });
  };

  for (let i = 0; i < workerCount; i++) {
    spawnWorker(i);
  }

  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[cluster] Primary received ${signal}; shutting down workers`);

    const forceTimer = setTimeout(() => {
      process.exit(0);
    }, 12_000);
    if (forceTimer.unref) forceTimer.unref();

    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.process.kill(signal);
    }

    cluster.on("exit", () => {
      const remaining = Object.keys(cluster.workers ?? {}).length;
      if (remaining === 0) {
        clearTimeout(forceTimer);
        process.exit(0);
      }
    });
  };

  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  process.once("SIGINT", () => handleSignal("SIGINT"));
}
