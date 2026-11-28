import cluster from "node:cluster";
import logger from "../config/logger.config.js";
import {
  REDIS_TTLS,
  acquireDistributedLock,
  isRedisAvailable,
  redisKeys,
  redisSet,
  releaseDistributedLock,
} from "../infrastructure/redis/index.js";
import {
  reconcilePendingRefunds,
  type ReconcileRefundsResult,
} from "../service/payment.service.js";
import {
  expireUnpaidOrders,
  type ExpireUnpaidOrdersResult,
} from "./order.job.js";

export interface JobRunMetrics {
  name: string;
  running: boolean;
  schedulerEnabledOnWorker: boolean;
  totalRuns: number;
  totalFailures: number;
  consecutiveFailures: number;
  deadLetterCount: number;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: ExpireUnpaidOrdersResult | null;
}

const EXPIRE_JOB_INTERVAL_MS = 5 * 60 * 1000;
const REFUND_JOB_INTERVAL_MS = 60 * 1000;
const JOB_TIMEOUT_MS = 60 * 1000;
const REFUND_JOB_TIMEOUT_MS = 50 * 1000;
const MAX_JOB_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 1000;

let expireOrdersTimer: NodeJS.Timeout | undefined;
let refundReconcileTimer: NodeJS.Timeout | undefined;
let activeJobPromise: Promise<void> | null = null;
let activeRefundJobPromise: Promise<void> | null = null;
let isShuttingDown = false;
let initialized = false;

export const isSchedulerPrimaryWorker = (): boolean => {
  if (process.env.JOB_SCHEDULER_ENABLED === "false") {
    return false;
  }
  if (cluster.isWorker && cluster.worker && cluster.worker.id !== 1) {
    return false;
  }
  const instance = process.env.NODE_APP_INSTANCE?.trim();
  if (instance !== undefined && instance !== "" && instance !== "0") {
    return false;
  }
  return true;
};

const metrics: JobRunMetrics = {
  name: "expireUnpaidOrders",
  running: false,
  schedulerEnabledOnWorker: isSchedulerPrimaryWorker(),
  totalRuns: 0,
  totalFailures: 0,
  consecutiveFailures: 0,
  deadLetterCount: 0,
  lastRunAt: null,
  lastDurationMs: null,
  lastError: null,
  lastResult: null,
};

let refundJobRunning = false;
let lastRefundResult: ReconcileRefundsResult | null = null;

const sleepWithJitter = (attempt: number): Promise<void> => {
  const expDelay = BASE_RETRY_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 500);
  return new Promise((resolve) => {
    const t = setTimeout(resolve, expDelay + jitter);
    if (t.unref) t.unref();
  });
};

const runWithAbortableTimeout = async <T>(
  workFactory: (shouldAbort: () => boolean) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const shouldAbort = () => timedOut || isShuttingDown;

  const workPromise = workFactory(shouldAbort);

  try {
    return await Promise.race([
      workPromise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Job timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]);
  } catch (err) {
    // Wait for the aborted attempt to settle its current unit of work before
    // allowing a retry or lock release so two attempts never overlap.
    await Promise.race([
      workPromise.catch(() => {}),
      new Promise<void>((resolve) => {
        const drainTimer = setTimeout(resolve, 10_000);
        if (drainTimer.unref) drainTimer.unref();
      }),
    ]);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const recordDeadLetter = async (errorMessage: string): Promise<void> => {
  metrics.deadLetterCount += 1;
  if (!isRedisAvailable()) return;
  try {
    const dlqKey = `${redisKeys.jobDeadLetter(metrics.name)}:${Date.now()}`;
    await redisSet(
      dlqKey,
      JSON.stringify({
        job: metrics.name,
        failedAt: new Date().toISOString(),
        error: errorMessage,
        consecutiveFailures: metrics.consecutiveFailures,
      }),
      { ex: 7 * 24 * 3600 },
    );
  } catch {
    // Best-effort DLQ persistence
  }
};

export const runExpireUnpaidOrdersOnce = async (): Promise<void> => {
  if (isShuttingDown || metrics.running) {
    return;
  }

  const lockKey = redisKeys.expireUnpaidOrdersLock();
  const lock = await acquireDistributedLock(
    lockKey,
    REDIS_TTLS.EXPIRE_JOB_LOCK_SEC,
  );
  if (!lock && isRedisAvailable()) {
    logger.debug("[job] Skipping expireUnpaidOrders; distributed lock held", {
      operation: "JOB_EXPIRE_LOCK_SKIPPED",
    });
    return;
  }

  metrics.running = true;
  const startedAt = performance.now();
  logger.info("[job] expireUnpaidOrders started", {
    operation: "JOB_EXPIRE_STARTED",
  });

  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_JOB_RETRIES; attempt++) {
      if (isShuttingDown) break;

      try {
        const result = await runWithAbortableTimeout(
          (shouldAbort) => expireUnpaidOrders({ minutes: 20, shouldAbort }),
          JOB_TIMEOUT_MS,
        );
        metrics.lastResult = result;

        if (result.failed > 0) {
          throw new Error(
            `expireUnpaidOrders had ${result.failed} failed order(s) out of ${result.scanned} scanned`,
          );
        }

        metrics.totalRuns += 1;
        metrics.consecutiveFailures = 0;
        metrics.lastError = null;
        metrics.lastRunAt = new Date().toISOString();
        metrics.lastDurationMs =
          Math.round((performance.now() - startedAt) * 100) / 100;

        if (result.expired > 0 || result.scanned > 0) {
          logger.info("[job] expireUnpaidOrders completed", {
            ...result,
            durationMs: metrics.lastDurationMs,
          });
        }
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_JOB_RETRIES && !isShuttingDown) {
          logger.warn("[job] expireUnpaidOrders failed; retrying with backoff", {
            attempt: attempt + 1,
            maxRetries: MAX_JOB_RETRIES,
            error: err instanceof Error ? err.message : String(err),
          });
          await sleepWithJitter(attempt);
        }
      }
    }

    metrics.totalRuns += 1;
    metrics.totalFailures += 1;
    metrics.consecutiveFailures += 1;
    metrics.lastRunAt = new Date().toISOString();
    metrics.lastDurationMs =
      Math.round((performance.now() - startedAt) * 100) / 100;
    metrics.lastError =
      lastErr instanceof Error ? lastErr.message : String(lastErr);

    await recordDeadLetter(metrics.lastError);

    logger.error("[job] expireUnpaidOrders exhausted retries", {
      consecutiveFailures: metrics.consecutiveFailures,
      durationMs: metrics.lastDurationMs,
      error: metrics.lastError,
    });
  } finally {
    metrics.running = false;
    await releaseDistributedLock(lock);
  }
};

export const runReconcileRefundsOnce = async (): Promise<void> => {
  if (isShuttingDown || refundJobRunning) {
    return;
  }

  const lock = await acquireDistributedLock(
    redisKeys.refundRetryJobLock(),
    REDIS_TTLS.REFUND_JOB_LOCK_SEC,
  );
  if (!lock && isRedisAvailable()) {
    logger.debug("[job] Skipping reconcilePendingRefunds; distributed lock held", {
      operation: "JOB_REFUND_LOCK_SKIPPED",
    });
    return;
  }

  refundJobRunning = true;
  const startedAt = performance.now();
  logger.debug("[job] reconcilePendingRefunds started", {
    operation: "JOB_REFUND_STARTED",
  });
  try {
    const result = await runWithAbortableTimeout(
      (shouldAbort) => reconcilePendingRefunds({ shouldAbort }),
      REFUND_JOB_TIMEOUT_MS,
    );
    lastRefundResult = result;
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    if (
      result.scanned > 0 ||
      result.refunded > 0 ||
      result.failed > 0 ||
      result.permanentFailures > 0
    ) {
      logger.info("[job] reconcilePendingRefunds completed", {
        ...result,
        durationMs,
        operation: "JOB_REFUND_COMPLETED",
      });
    }
  } catch (err) {
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    logger.warn("[job] reconcilePendingRefunds failed", {
      durationMs,
      error: err instanceof Error ? err.message : String(err),
      lastRefundResult,
      operation: "JOB_REFUND_FAILED",
    });
  } finally {
    refundJobRunning = false;
    await releaseDistributedLock(lock);
  }
};

export const startBackgroundJobs = (): void => {
  metrics.schedulerEnabledOnWorker = isSchedulerPrimaryWorker();
  if (!metrics.schedulerEnabledOnWorker) {
    logger.info("[job] Secondary cluster worker; background scheduler disabled locally", {
      workerInstance: process.env.NODE_APP_INSTANCE,
    });
    return;
  }

  if (initialized) {
    logger.warn("[job] Background jobs already initialized; skipping duplicate registration");
    return;
  }

  initialized = true;
  isShuttingDown = false;

  expireOrdersTimer = setInterval(() => {
    if (activeJobPromise || isShuttingDown) return;
    activeJobPromise = runExpireUnpaidOrdersOnce().finally(() => {
      activeJobPromise = null;
    });
  }, EXPIRE_JOB_INTERVAL_MS);

  if (expireOrdersTimer.unref) {
    expireOrdersTimer.unref();
  }

  refundReconcileTimer = setInterval(() => {
    if (activeRefundJobPromise || isShuttingDown) return;
    activeRefundJobPromise = runReconcileRefundsOnce().finally(() => {
      activeRefundJobPromise = null;
    });
  }, REFUND_JOB_INTERVAL_MS);

  if (refundReconcileTimer.unref) {
    refundReconcileTimer.unref();
  }

  logger.info("[job] Background job scheduler started", {
    job: metrics.name,
    intervalMs: EXPIRE_JOB_INTERVAL_MS,
    refundRetryIntervalMs: REFUND_JOB_INTERVAL_MS,
  });
};

export const stopBackgroundJobs = async (timeoutMs = 5000): Promise<void> => {
  isShuttingDown = true;
  initialized = false;

  if (expireOrdersTimer) {
    clearInterval(expireOrdersTimer);
    expireOrdersTimer = undefined;
  }

  if (refundReconcileTimer) {
    clearInterval(refundReconcileTimer);
    refundReconcileTimer = undefined;
  }

  const pendingPromises: Promise<unknown>[] = [];
  if (activeJobPromise) pendingPromises.push(activeJobPromise);
  if (activeRefundJobPromise) pendingPromises.push(activeRefundJobPromise);

  if (pendingPromises.length > 0) {
    await Promise.race([
      Promise.allSettled(pendingPromises),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]);
  }

  logger.info("[job] Background job scheduler stopped");
};

export const getBackgroundJobMetrics = (): JobRunMetrics => ({
  ...metrics,
});
