import crypto from "crypto";
import { Request, Response, NextFunction, RequestHandler } from "express";
import logger from "../config/logger.config.js";
import {
  isRedisAvailable,
  redisEval,
  redisKeys,
  redisZremAndDel,
} from "../infrastructure/redis/index.js";

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  message?: string;
  statusCode?: number;
  keyPrefix?: string;
  failClosed?: boolean;
  progressiveCooldown?: boolean;
  maxCooldownSeconds?: number;
  skipSuccessfulRequests?: boolean;
  keyGenerator?: (req: Request) => string | null;
}

const MAX_IN_MEMORY_KEYS = 10_000;

/**
 * Derive client IP solely from Express req.ip (governed by `trust proxy`)
 * or direct socket remoteAddress. Never trust raw X-Forwarded-For headers.
 */
export const getTrustedClientIp = (req: Request): string => {
  const rawIp = req.ip || req.socket?.remoteAddress || "unknown";
  return rawIp.startsWith("::ffff:") ? rawIp.slice(7) : rawIp;
};

export const hashNormalizedEmail = (email: unknown): string | null => {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  return crypto
    .createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex")
    .slice(0, 32);
};

const defaultKeyGenerator = (req: Request): string => {
  return getTrustedClientIp(req);
};

/**
 * Atomic Redis Sliding-Window Rate Limiter Lua Script.
 * Uses a unique request member (ARGV[4]) so concurrent same-millisecond
 * requests never collide or overwrite one another in the Sorted Set.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local penaltyKey = KEYS[2]
local penaltyLockKey = KEYS[3]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local progressive = tonumber(ARGV[5])
local maxCooldownSec = tonumber(ARGV[6])
local clearBefore = now - window

if progressive == 1 then
    local lockTtl = redis.call('PTTL', penaltyLockKey)
    if lockTtl and lockTtl > 0 then
        return { 0, 0, math.max(1, math.ceil(lockTtl / 1000)) }
    end
end

redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
local currentRequests = redis.call('ZCARD', key)

if currentRequests < limit then
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, window)
    return { 1, limit - currentRequests - 1, math.ceil(window / 1000) }
else
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local resetTime = math.ceil(window / 1000)
    if oldest and #oldest >= 2 then
        local oldestScore = tonumber(oldest[2])
        resetTime = math.max(1, math.ceil((oldestScore + window - now) / 1000))
    end

    if progressive == 1 then
        local strikes = redis.call('INCR', penaltyKey)
        redis.call('EXPIRE', penaltyKey, maxCooldownSec * 2)
        if strikes > 1 then
            local cooldownSec = math.min(maxCooldownSec, math.ceil(window / 1000) * math.pow(2, math.min(strikes - 1, 4)))
            redis.call('SET', penaltyLockKey, '1', 'EX', cooldownSec)
            resetTime = math.max(resetTime, cooldownSec)
        end
    end

    return { 0, 0, resetTime }
end
`;

export const createRateLimiter = (
  options: RateLimiterOptions,
): RequestHandler => {
  const {
    windowMs,
    maxRequests,
    message = "Too many requests. Please try again later.",
    statusCode = 429,
    keyPrefix = "cafemart:ratelimit",
    failClosed = false,
    progressiveCooldown = false,
    maxCooldownSeconds = 3600,
    skipSuccessfulRequests = false,
    keyGenerator = defaultKeyGenerator,
  } = options;

  const inMemoryHits = new Map<string, RateLimitRecord>();

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of inMemoryHits.entries()) {
      if (now >= record.resetTime) {
        inMemoryHits.delete(key);
      }
    }
  }, 60000);

  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const rawKey = keyGenerator(req);
    if (rawKey === null) {
      next();
      return;
    }

    const now = Date.now();

    if (isRedisAvailable()) {
      try {
        const redisKey = redisKeys.rateLimit(keyPrefix, rawKey);
        const penaltyKey = redisKeys.rateLimitPenalty(keyPrefix, rawKey);
        const penaltyLockKey = redisKeys.rateLimitPenaltyLock(keyPrefix, rawKey);
        const uniqueMember = `${now}:${crypto.randomUUID()}`;

        const result = await redisEval<[number, number, number]>(
          SLIDING_WINDOW_LUA,
          [redisKey, penaltyKey, penaltyLockKey],
          [
            now,
            windowMs,
            maxRequests,
            uniqueMember,
            progressiveCooldown ? 1 : 0,
            maxCooldownSeconds,
          ],
        );

        const allowed = Number(result[0]) === 1;
        const remaining = Number(result[1]);
        const resetSeconds = Number(result[2]);

        res.setHeader("RateLimit-Limit", maxRequests);
        res.setHeader("RateLimit-Remaining", remaining);
        res.setHeader("RateLimit-Reset", resetSeconds);

        if (!allowed) {
          res.setHeader("Retry-After", resetSeconds);
          res.status(statusCode).json({
            success: false,
            message,
            retryAfterSeconds: resetSeconds,
          });
          return;
        }

        if (skipSuccessfulRequests) {
          res.once("finish", () => {
            if (res.statusCode < 400 && isRedisAvailable()) {
              void redisZremAndDel(redisKey, uniqueMember, penaltyKey).catch(
                (err) => {
                  logger.warn(
                    "Failed to rollback successful auth attempt rate-limit slot",
                    {
                      keyPrefix,
                      error: err instanceof Error ? err.message : String(err),
                    },
                  );
                },
              );
            }
          });
        }

        next();
        return;
      } catch (err) {
        logger.warn("Redis rate limiter evaluation failed", {
          keyPrefix,
          failClosed,
          error: err instanceof Error ? err.message : String(err),
        });

        if (failClosed) {
          res.status(503).json({
            success: false,
            message:
              "Authentication rate limiting service temporarily unavailable.",
          });
          return;
        }
      }
    } else if (failClosed) {
      logger.warn("Redis unavailable for fail-closed rate limiter", {
        keyPrefix,
      });
      res.status(503).json({
        success: false,
        message:
          "Authentication rate limiting service temporarily unavailable.",
      });
      return;
    }

    // PROCESS-LOCAL FALLBACK (Only for non-failClosed public/general limiters)
    if (inMemoryHits.size >= MAX_IN_MEMORY_KEYS && !inMemoryHits.has(rawKey)) {
      const oldestKey = inMemoryHits.keys().next().value;
      if (oldestKey !== undefined) {
        inMemoryHits.delete(oldestKey);
      }
    }

    let record = inMemoryHits.get(rawKey);

    if (!record || now >= record.resetTime) {
      record = {
        count: 1,
        resetTime: now + windowMs,
      };
      inMemoryHits.set(rawKey, record);
    } else {
      record.count += 1;
    }

    const remaining = Math.max(0, maxRequests - record.count);
    const resetSeconds = Math.ceil((record.resetTime - now) / 1000);

    res.setHeader("RateLimit-Limit", maxRequests);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", resetSeconds);

    if (record.count > maxRequests) {
      res.setHeader("Retry-After", resetSeconds);
      res.status(statusCode).json({
        success: false,
        message,
        retryAfterSeconds: resetSeconds,
      });
      return;
    }

    if (skipSuccessfulRequests) {
      const capturedRecord = record;
      res.once("finish", () => {
        if (res.statusCode < 400 && capturedRecord.count > 0) {
          capturedRecord.count -= 1;
        }
      });
    }

    next();
  };
};

const runSequentialLimiters = (limiters: RequestHandler[]): RequestHandler => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    let idx = 0;

    const advance = async (err?: unknown): Promise<void> => {
      if (err) {
        next(err);
        return;
      }
      if (res.headersSent) {
        return;
      }
      if (idx >= limiters.length) {
        next();
        return;
      }
      const current = limiters[idx++];
      try {
        await current(req, res, advance);
      } catch (limiterErr) {
        next(limiterErr);
      }
    };

    await advance();
  };
};

const adminIpLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  keyPrefix: "cafemart:ratelimit:admin_ip",
  message: "Too many login attempts. Please try again later.",
  failClosed: true,
  progressiveCooldown: true,
  maxCooldownSeconds: 3600,
  skipSuccessfulRequests: true,
});

const adminEmailLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  keyPrefix: "cafemart:ratelimit:admin_email",
  message: "Too many login attempts. Please try again later.",
  failClosed: true,
  progressiveCooldown: true,
  maxCooldownSeconds: 3600,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => hashNormalizedEmail(req.body?.email),
});

const adminIpEmailLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  keyPrefix: "cafemart:ratelimit:admin_ip_email",
  message: "Too many login attempts. Please try again later.",
  failClosed: true,
  progressiveCooldown: true,
  maxCooldownSeconds: 3600,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const emailHash = hashNormalizedEmail(req.body?.email);
    if (!emailHash) return null;
    return `${getTrustedClientIp(req)}:${emailHash}`;
  },
});

const adminRegisterIpLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  keyPrefix: "cafemart:ratelimit:admin_register_ip",
  message: "Too many admin registration attempts. Please try again later.",
  failClosed: true,
  progressiveCooldown: true,
  maxCooldownSeconds: 3600,
  skipSuccessfulRequests: true,
});

const adminRegisterEmailLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  keyPrefix: "cafemart:ratelimit:admin_register_email",
  message: "Too many admin registration attempts. Please try again later.",
  failClosed: true,
  progressiveCooldown: true,
  maxCooldownSeconds: 3600,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => hashNormalizedEmail(req.body?.email),
});

/**
 * Combined fail-closed rate limiter for Admin login endpoints:
 * Enforces IP, hashed normalized email, and IP+email limits across instances,
 * and rolls back slots on successful (2xx/3xx) logins so valid admins aren't penalized.
 */
export const adminLoginLimiter: RequestHandler = runSequentialLimiters([
  adminIpLimiter,
  adminEmailLimiter,
  adminIpEmailLimiter,
]);

/**
 * Isolated fail-closed rate limiter for Admin registration bootstrap endpoint.
 */
export const adminRegisterLimiter: RequestHandler = runSequentialLimiters([
  adminRegisterIpLimiter,
  adminRegisterEmailLimiter,
]);

export const refreshTokenLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyPrefix: "cafemart:ratelimit:refresh_token",
  message: "Too many token refresh attempts. Please slow down.",
});

export const authGeneralLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "cafemart:ratelimit:auth_general",
  message: "Too many authentication requests. Please try again in a minute.",
});

export const paymentInitiateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 20,
  keyPrefix: "cafemart:ratelimit:payment_initiate",
  message: "Too many payment initiation attempts. Please wait a moment.",
  keyGenerator: (req) => {
    const uid = req.user?._id ? String(req.user._id) : getTrustedClientIp(req);
    return uid;
  },
});
