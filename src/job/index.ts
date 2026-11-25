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
const JOB_TIMEOUT_MS = 60 * 1000;
const MAX_JOB_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 1000;

let expireOrdersTimer: NodeJS.Timeout | undefined;
let activeJobPromise: Promise<void> | null = null;
let isShuttingDown = false;
let initialized = false;

export const isSchedulerPrimaryWorker = (): boolean => {
  if (process.env.JOB_SCHEDULER_ENABLED === "false") {
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

const sleepWithJitter = (attempt: number): Promise<void> => {
  const expDelay = BASE_RETRY_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 500);
  return new Promise((resolve) => {
    const t = setTimeout(resolve, expDelay + jitter);
    if (t.unref) t.unref();
  });
};

const runWithTimeout = async <T>(
  work: () => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Job timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        if (timer.unref) timer.unref();
      }),
    ]);
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
    return;
  }

  metrics.running = true;
  const startedAt = performance.now();

  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_JOB_RETRIES; attempt++) {
      if (isShuttingDown) break;

      try {
        const result = await runWithTimeout(
          () => expireUnpaidOrders(20),
          JOB_TIMEOUT_MS,
        );
        metrics.totalRuns += 1;
        metrics.consecutiveFailures = 0;
        metrics.lastError = null;
        metrics.lastResult = result;
        metrics.lastRunAt = new Date().toISOString();
        metrics.lastDurationMs =
          Math.round((performance.now() - startedAt) * 100) / 100;

        if (result.expired > 0 || result.failed > 0) {
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

  logger.info("[job] Background job scheduler started", {
    job: metrics.name,
    intervalMs: EXPIRE_JOB_INTERVAL_MS,
  });
};

export const stopBackgroundJobs = async (timeoutMs = 5000): Promise<void> => {
  isShuttingDown = true;
  initialized = false;

  if (expireOrdersTimer) {
    clearInterval(expireOrdersTimer);
    expireOrdersTimer = undefined;
  }

  if (activeJobPromise) {
    await Promise.race([
      activeJobPromise,
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
