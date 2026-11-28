import crypto from "crypto";
import logger from "../../config/logger.config.js";
import { ConflictError, ExternalServiceError } from "../../utils/errors/app.error.js";
import { REDIS_TTLS } from "./redis.constants.js";
import { redisKeys } from "./redis.keys.js";
import {
  isRedisAvailable,
  redisEval,
  redisGet,
  redisSet,
} from "./redis.store.js";
import { safeJsonParse, safeJsonStringify } from "./redis.cache.js";

const IN_PROGRESS_PREFIX = "__INFLIGHT__:";

const SET_RESULT_IF_OWNED_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
end
return nil
`;

const RELEASE_INFLIGHT_IF_OWNED_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface IdempotencyExecutionResult<T> {
  value: T;
  replayed: boolean;
}

/**
 * Execute an operation idempotently when an explicit Idempotency-Key is supplied.
 * Acquires an atomic Redis ownership token via SET NX EX and never executes
 * `work()` without owning the lock when a key is provided.
 */
export const executeWithIdempotency = async <T>(
  scope: string,
  ownerId: string,
  rawKey: string | undefined,
  work: () => Promise<T>,
  resultTtlSec: number = REDIS_TTLS.IDEMPOTENCY_RESULT_SEC,
): Promise<IdempotencyExecutionResult<T>> => {
  const keyTrimmed = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!keyTrimmed) {
    return { value: await work(), replayed: false };
  }

  if (!isRedisAvailable()) {
    throw new ExternalServiceError(
      "Idempotency service temporarily unavailable. Please try again.",
      503,
    );
  }

  const redisKey = redisKeys.idempotency(scope, ownerId, keyTrimmed);
  const lockValue = `${IN_PROGRESS_PREFIX}${crypto.randomUUID()}`;
  let acquired = false;

  try {
    const res = await redisSet(redisKey, lockValue, {
      ex: REDIS_TTLS.IDEMPOTENCY_INFLIGHT_SEC,
      nx: true,
    });
    acquired = res === "OK";

    if (!acquired) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const stored = await redisGet(redisKey);
        if (stored && !stored.startsWith(IN_PROGRESS_PREFIX)) {
          const parsed = safeJsonParse<T>(stored);
          if (parsed !== null) {
            logger.debug("[redis-idempotency] Replaying cached idempotent result", {
              scope,
              ownerId,
              operation: "IDEMPOTENCY_REPLAY",
            });
            return { value: parsed, replayed: true };
          }
          break;
        }
        if (!stored) {
          const retrySet = await redisSet(redisKey, lockValue, {
            ex: REDIS_TTLS.IDEMPOTENCY_INFLIGHT_SEC,
            nx: true,
          });
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
            logger.debug("[redis-idempotency] Replaying cached idempotent result", {
              scope,
              ownerId,
              operation: "IDEMPOTENCY_REPLAY",
            });
            return { value: parsed, replayed: true };
          }
        }
        throw new ConflictError(
          "A request with this Idempotency-Key is already in progress. Please retry shortly.",
        );
      }
    }
  } catch (err) {
    if (err instanceof ConflictError) {
      throw err;
    }
    logger.error("[redis-idempotency] Lock acquisition failed", {
      scope,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ExternalServiceError(
      "Idempotency service temporarily unavailable. Please try again.",
      503,
    );
  }

  try {
    const value = await work();
    const serialized = safeJsonStringify(value);
    if (serialized) {
      await redisEval(
        SET_RESULT_IF_OWNED_LUA,
        [redisKey],
        [lockValue, serialized, Math.max(10, Math.floor(resultTtlSec))],
      ).catch((err) => {
        logger.warn("[redis-idempotency] Failed caching idempotent result", {
          scope,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      await redisEval(
        RELEASE_INFLIGHT_IF_OWNED_LUA,
        [redisKey],
        [lockValue],
      ).catch(() => {});
    }
    return { value, replayed: false };
  } catch (err) {
    await redisEval(
      RELEASE_INFLIGHT_IF_OWNED_LUA,
      [redisKey],
      [lockValue],
    ).catch((relErr) => {
      logger.warn("[redis-idempotency] Failed releasing in-flight lock", {
        scope,
        error: relErr instanceof Error ? relErr.message : String(relErr),
      });
    });
    throw err;
  }
};
