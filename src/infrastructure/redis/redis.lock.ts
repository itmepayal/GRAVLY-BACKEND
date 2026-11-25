import crypto from "crypto";
import logger from "../../config/logger.config.js";
import { REDIS_TTLS } from "./redis.constants.js";
import { isRedisAvailable, redisEval, redisSet } from "./redis.store.js";

export interface DistributedLockHandle {
  key: string;
  token: string;
}

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Acquire an atomic distributed lock using SET NX EX with a unique ownership token.
 * Returns null if the lock is already held or if Redis is unavailable (caller decides behavior).
 */
export const acquireDistributedLock = async (
  key: string,
  ttlSec: number = REDIS_TTLS.DEFAULT_LOCK_SEC,
): Promise<DistributedLockHandle | null> => {
  if (!isRedisAvailable()) {
    return null;
  }

  const token = crypto.randomUUID();
  const safeTtl = Math.max(1, Math.floor(ttlSec));

  try {
    const acquired = await redisSet(key, token, { ex: safeTtl, nx: true });
    if (acquired === "OK") {
      return { key, token };
    }
    return null;
  } catch (err) {
    logger.warn("[redis-lock] Failed to acquire lock", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};

/**
 * Atomically release a distributed lock only if the stored token still matches ours.
 */
export const releaseDistributedLock = async (
  handle: DistributedLockHandle | null,
): Promise<boolean> => {
  if (!handle || !isRedisAvailable()) {
    return false;
  }

  try {
    const released = await redisEval<number>(
      RELEASE_LOCK_LUA,
      [handle.key],
      [handle.token],
    );
    return Number(released) === 1;
  } catch (err) {
    logger.warn("[redis-lock] Failed to release lock", {
      key: handle.key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
};
