import logger from "../../config/logger.config.js";
import { recordCacheHit, recordCacheMiss } from "./redis.metrics.js";
import { isRedisAvailable, redisDel, redisGet, redisSet } from "./redis.store.js";

const inFlightLoads = new Map<string, Promise<unknown>>();
const MAX_INFLIGHT_LOADS = 2000;

export const safeJsonStringify = (value: unknown): string | null => {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch (err) {
    logger.warn("[redis-cache] Failed to serialize JSON payload", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};

export const safeJsonParse = <T>(raw: string | null | undefined): T | null => {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const cacheGetJson = async <T>(key: string): Promise<T | null> => {
  if (!isRedisAvailable()) {
    return null;
  }

  try {
    const raw = await redisGet(key);
    if (!raw) {
      recordCacheMiss();
      return null;
    }
    const parsed = safeJsonParse<T>(raw);
    if (parsed === null) {
      recordCacheMiss();
      return null;
    }
    recordCacheHit();
    return parsed;
  } catch (err) {
    recordCacheMiss();
    logger.warn("[redis-cache] Cache read failed; degrading gracefully", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};

export const cacheSetJson = async (
  key: string,
  value: unknown,
  ttlSec: number,
): Promise<void> => {
  if (!isRedisAvailable()) {
    return;
  }
  const serialized = safeJsonStringify(value);
  if (!serialized) return;

  try {
    await redisSet(key, serialized, { ex: Math.max(1, Math.floor(ttlSec)) });
  } catch (err) {
    logger.warn("[redis-cache] Cache write failed; continuing", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const cacheDeleteKeys = async (...keys: string[]): Promise<void> => {
  if (keys.length === 0 || !isRedisAvailable()) {
    return;
  }
  try {
    await redisDel(...keys);
  } catch (err) {
    logger.warn("[redis-cache] Cache invalidation failed", {
      keysCount: keys.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

/**
 * Cache-aside helper with single-flight stampede protection.
 * Degrades cleanly to the authoritative loader on Redis failure.
 */
export const getOrLoadCachedJson = async <T>(
  key: string,
  ttlSec: number,
  loader: () => Promise<T>,
): Promise<T> => {
  const cached = await cacheGetJson<T>(key);
  if (cached !== null) {
    return cached;
  }

  const existing = inFlightLoads.get(key) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }

  const loadPromise = (async () => {
    const fresh = await loader();
    await cacheSetJson(key, fresh, ttlSec);
    return fresh;
  })().finally(() => {
    inFlightLoads.delete(key);
  });

  if (inFlightLoads.size < MAX_INFLIGHT_LOADS) {
    inFlightLoads.set(key, loadPromise);
  }

  return loadPromise;
};
