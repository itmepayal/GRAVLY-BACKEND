import crypto from "crypto";
import logger from "../../config/logger.config.js";
import {
  isRedisAvailable,
  redisEval,
  redisKeys,
} from "../../infrastructure/redis/index.js";

interface LocalWindowRecord {
  count: number;
  resetAt: number;
}

const SLIDING_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local clearBefore = now - window

redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
local current = redis.call('ZCARD', key)
if current < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return { 1, limit - current - 1 }
end
return { 0, 0 }
`;

const MAX_LOCAL_ENTRIES = 10_000;
const localCounters = new Map<string, LocalWindowRecord>();

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of localCounters.entries()) {
    if (now >= rec.resetAt) localCounters.delete(k);
  }
}, 60_000);
if (sweepTimer.unref) sweepTimer.unref();

const checkWindowLimit = async (
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<boolean> => {
  const now = Date.now();

  if (isRedisAvailable()) {
    try {
      const member = `${now}:${crypto.randomUUID()}`;
      const res = await redisEval<[number, number]>(
        SLIDING_LUA,
        [key],
        [now, windowMs, maxRequests, member],
      );
      return Number(res[0]) === 1;
    } catch (err) {
      logger.warn("Socket Redis rate limiter fallback to memory", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (localCounters.size >= MAX_LOCAL_ENTRIES && !localCounters.has(key)) {
    const oldest = localCounters.keys().next().value;
    if (oldest !== undefined) localCounters.delete(oldest);
  }

  let rec = localCounters.get(key);
  if (!rec || now >= rec.resetAt) {
    rec = { count: 1, resetAt: now + windowMs };
    localCounters.set(key, rec);
    return true;
  }

  rec.count += 1;
  return rec.count <= maxRequests;
};

export const allowSocketHandshake = async (ip: string): Promise<boolean> => {
  const safeIp = (ip || "unknown").trim().slice(0, 64);
  return checkWindowLimit(
    redisKeys.socketHandshakeLimit(safeIp),
    60_000,
    60,
  );
};

export const allowSocketEvent = async (
  userId: string,
  eventName: string,
  maxEvents = 30,
  windowMs = 60_000,
): Promise<boolean> => {
  return checkWindowLimit(
    redisKeys.socketEventLimit(userId, eventName),
    windowMs,
    maxEvents,
  );
};
