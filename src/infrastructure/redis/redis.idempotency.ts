import logger from "../../config/logger.config.js";
import { REDIS_TTLS } from "./redis.constants.js";
import { redisKeys } from "./redis.keys.js";
import {
  isRedisAvailable,
  redisDel,
  redisGet,
  redisSet,
} from "./redis.store.js";
import { safeJsonParse, safeJsonStringify } from "./redis.cache.js";

const IN_PROGRESS_PREFIX = "__INFLIGHT__:";

export interface IdempotencyExecutionResult<T> {
  value: T;
  replayed: boolean;
}

/**
 * Execute an operation idempotently when an explicit Idempotency-Key is supplied.
 * Uses atomic Redis SET NX EX to deduplicate concurrent or retried client requests
 * while never blocking or weakening MongoDB transactional guarantees when Redis is unavailable.
 */
export const executeWithIdempotency = async <T>(
  scope: string,
  ownerId: string,
  rawKey: string | undefined,
  work: () => Promise<T>,
  resultTtlSec: number = REDIS_TTLS.IDEMPOTENCY_RESULT_SEC,
): Promise<IdempotencyExecutionResult<T>> => {
  const keyTrimmed = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!keyTrimmed || !isRedisAvailable()) {
    return { value: await work(), replayed: false };
  }

  const redisKey = redisKeys.idempotency(scope, ownerId, keyTrimmed);
  let acquired = false;

  try {
    const res = await redisSet(redisKey, `${IN_PROGRESS_PREFIX}${Date.now()}`, {
      ex: REDIS_TTLS.IDEMPOTENCY_INFLIGHT_SEC,
      nx: true,
    });
    acquired = res === "OK";

    if (!acquired) {
      // Poll briefly if an identical in-flight request is finishing
      for (let attempt = 0; attempt < 20; attempt++) {
        const stored = await redisGet(redisKey);
        if (stored && !stored.startsWith(IN_PROGRESS_PREFIX)) {
          const parsed = safeJsonParse<T>(stored);
          if (parsed !== null) {
            return { value: parsed, replayed: true };
          }
          break;
        }
        if (!stored) {
          const retrySet = await redisSet(
            redisKey,
            `${IN_PROGRESS_PREFIX}${Date.now()}`,
            { ex: REDIS_TTLS.IDEMPOTENCY_INFLIGHT_SEC, nx: true },
          );
          if (retrySet === "OK") {
            acquired = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 75));
      }

      if (!acquired) {
        const stored = await redisGet(redisKey);
        if (stored && !stored.startsWith(IN_PROGRESS_PREFIX)) {
          const parsed = safeJsonParse<T>(stored);
          if (parsed !== null) {
            return { value: parsed, replayed: true };
          }
        }
      }
    }
  } catch (err) {
    logger.warn("[redis-idempotency] Falling back to direct execution", {
      scope,
      error: err instanceof Error ? err.message : String(err),
    });
    return { value: await work(), replayed: false };
  }

  try {
    const value = await work();
    if (acquired) {
      const serialized = safeJsonStringify(value);
      if (serialized) {
        await redisSet(redisKey, serialized, {
          ex: Math.max(10, resultTtlSec),
        }).catch(() => {});
      } else {
        await redisDel(redisKey).catch(() => {});
      }
    }
    return { value, replayed: false };
  } catch (err) {
    if (acquired) {
      await redisDel(redisKey).catch(() => {});
    }
    throw err;
  }
};
