import crypto from "crypto";
import mongoose, { ClientSession } from "mongoose";
import { Request, Response, NextFunction, RequestHandler } from "express";

import { User, IUser, UserRole } from "../models/user.model.js";
import { Session } from "../models/session.model.js";
import { verifyAccessToken } from "../utils/jwt/jwt.js";
import {
  subscribeToChannel,
  publishEvent,
  onRedisReconnect,
} from "../config/redis.config.js";
import {
  REDIS_CHANNELS,
  REDIS_TTLS,
  isRedisAvailable,
  recordCacheHit,
  recordCacheMiss,
  redisDel,
  redisKeys,
  redisMget,
  redisSet,
} from "../infrastructure/redis/index.js";
import logger, { logSecurityAudit } from "../config/logger.config.js";
import { serverConfig } from "../config/index.js";

export const ROLE_RANK: Record<UserRole, number> = {
  student: 1,
  cafeOwner: 2,
  admin: 3,
};

export interface RequestAuthContext {
  jti?: string;
  sid?: string;
  tv: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      targetUser?: IUser;
      auth?: RequestAuthContext;
    }
  }
}

/* =========================================================
   DISTRIBUTED USER CACHE, PUB/SUB INVALIDATION & REVOCATION
========================================================= */
export const AUTH_INVALIDATION_CHANNEL = REDIS_CHANNELS.AUTH_INVALIDATION;
const INSTANCE_ID = crypto.randomUUID();
const DEFAULT_ACCESS_TTL_SEC = REDIS_TTLS.DEFAULT_ACCESS_REVOCATION_SEC;
const USER_CACHE_TTL_SEC = REDIS_TTLS.USER_CACHE_SEC;
const SESSION_META_CACHE_TTL_SEC = REDIS_TTLS.SESSION_META_CACHE_SEC;
const LOCAL_FALLBACK_CACHE_TTL_MS = 5 * 1000; // Tight 5s fallback TTL when Redis is down
const MAX_LOCAL_CACHE_ENTRIES = 5000;

const parseDurationSeconds = (raw: string | number | undefined): number => {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.ceil(raw);
  }
  if (typeof raw !== "string") return DEFAULT_ACCESS_TTL_SEC;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.max(60, Number(trimmed));
  }
  const match = trimmed.match(/^(\d+)\s*([smhd])$/i);
  if (!match) return DEFAULT_ACCESS_TTL_SEC;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return Math.max(60, amount * multiplier);
};

const getRevocationTtlSeconds = (tokenExpUnixSec?: number): number => {
  const configuredSec = parseDurationSeconds(serverConfig.JWT_ACCESS_EXPIRES);
  if (typeof tokenExpUnixSec === "number" && Number.isFinite(tokenExpUnixSec)) {
    const remainingSec = Math.ceil(tokenExpUnixSec - Date.now() / 1000) + 15;
    return Math.max(60, configuredSec, remainingSec);
  }
  return Math.max(60, configuredSec);
};

interface CachedSessionMeta {
  userId: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  expiresAtMs: number;
  idleExpiresAtMs?: number;
}

interface CachedUserEntry {
  user: IUser;
  expiresAt: number;
}

interface RevokedEntry {
  expiresAt: number;
}

interface MinVersionEntry {
  minVersion: number;
  expiresAt: number;
}

interface InvalidationMessage {
  type: "user_cache_clear" | "user_revoked" | "session_revoked";
  userId: string;
  sessionId?: string;
  jti?: string;
  minTokenVersion?: number;
  instanceId: string;
}

const inMemoryUserCache = new Map<string, CachedUserEntry>();
const inMemoryRevokedSessions = new Map<string, RevokedEntry>();
const inMemoryRevokedJtis = new Map<string, RevokedEntry>();
const inMemoryMinTokenVersions = new Map<string, MinVersionEntry>();
const inMemoryActivityThrottle = new Map<string, number>();
const inFlightUserFetches = new Map<string, Promise<IUser | null>>();
const inFlightLiveAuthChecks = new Map<
  string,
  Promise<{ isActive: boolean; tokenVersion: number } | null>
>();

const setBoundedMapEntry = <V>(
  map: Map<string, V>,
  key: string,
  value: V,
  maxSize = MAX_LOCAL_CACHE_ENTRIES,
): void => {
  if (map.size >= maxSize && !map.has(key)) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
};

// Evict expired in-memory entries every 60 seconds
const userCacheCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of inMemoryUserCache.entries()) {
    if (now >= entry.expiresAt) inMemoryUserCache.delete(id);
  }
  for (const [sid, entry] of inMemoryRevokedSessions.entries()) {
    if (now >= entry.expiresAt) inMemoryRevokedSessions.delete(sid);
  }
  for (const [jti, entry] of inMemoryRevokedJtis.entries()) {
    if (now >= entry.expiresAt) inMemoryRevokedJtis.delete(jti);
  }
  for (const [uid, entry] of inMemoryMinTokenVersions.entries()) {
    if (now >= entry.expiresAt) inMemoryMinTokenVersions.delete(uid);
  }
  for (const [sid, nextAt] of inMemoryActivityThrottle.entries()) {
    if (now >= nextAt) inMemoryActivityThrottle.delete(sid);
  }
}, 60000);

if (userCacheCleanupInterval.unref) {
  userCacheCleanupInterval.unref();
}

export const applyCacheInvalidationMessage = (rawMessage: string): void => {
  try {
    const msg = JSON.parse(rawMessage) as InvalidationMessage;
    if (!msg || !msg.userId) return;

    inMemoryUserCache.delete(msg.userId);
    const expiresAt = Date.now() + getRevocationTtlSeconds() * 1000;

    if (
      msg.type === "user_revoked" &&
      typeof msg.minTokenVersion === "number"
    ) {
      const existing = inMemoryMinTokenVersions.get(msg.userId);
      const nextMin = Math.max(existing?.minVersion ?? 0, msg.minTokenVersion);
      setBoundedMapEntry(inMemoryMinTokenVersions, msg.userId, {
        minVersion: nextMin,
        expiresAt,
      });
    } else if (msg.type === "session_revoked") {
      if (msg.sessionId) {
        setBoundedMapEntry(inMemoryRevokedSessions, msg.sessionId, {
          expiresAt,
        });
      }
      if (msg.jti) {
        setBoundedMapEntry(inMemoryRevokedJtis, msg.jti, { expiresAt });
      }
    }
  } catch {
    // Ignore malformed pub/sub payloads
  }
};

let syncInitialized = false;
export const ensureAuthCacheSyncInitialized = (): void => {
  if (syncInitialized) return;
  syncInitialized = true;

  void subscribeToChannel(AUTH_INVALIDATION_CHANNEL, (_channel, message) => {
    applyCacheInvalidationMessage(message);
  });

  onRedisReconnect(() => {
    // Purge local caches on reconnect to avoid serving stale data from missed pub/sub events
    inMemoryUserCache.clear();
  });
};

ensureAuthCacheSyncInitialized();

const fetchUserFromDatabase = async (userId: string): Promise<IUser | null> => {
  const existing = inFlightUserFetches.get(userId);
  if (existing) {
    return existing;
  }

  const fetchPromise = (async () => {
    const user = (await User.findById(userId)
      .select("-password -fcmTokens")
      .lean()) as unknown as IUser | null;
    return user;
  })().finally(() => {
    inFlightUserFetches.delete(userId);
  });

  inFlightUserFetches.set(userId, fetchPromise);
  return fetchPromise;
};

const verifyUserLiveInDb = async (
  userId: string,
): Promise<{ isActive: boolean; tokenVersion: number } | null> => {
  const existing = inFlightLiveAuthChecks.get(userId);
  if (existing) {
    return existing;
  }

  const checkPromise = (async () => {
    const doc = (await User.findById(userId)
      .select("isActive tokenVersion")
      .lean()) as { isActive?: boolean; tokenVersion?: number } | null;
    if (!doc) return null;
    return {
      isActive: Boolean(doc.isActive),
      tokenVersion: doc.tokenVersion ?? 0,
    };
  })().finally(() => {
    inFlightLiveAuthChecks.delete(userId);
  });

  inFlightLiveAuthChecks.set(userId, checkPromise);
  return checkPromise;
};

const writeSessionMetaCache = async (
  sessionId: string,
  meta: CachedSessionMeta,
): Promise<void> => {
  if (!isRedisAvailable()) return;
  const effectiveEndMs = Math.min(
    meta.expiresAtMs,
    meta.idleExpiresAtMs ?? meta.expiresAtMs,
  );
  const ttlSec = Math.min(
    SESSION_META_CACHE_TTL_SEC,
    Math.max(1, Math.ceil((effectiveEndMs - Date.now()) / 1000)),
  );
  try {
    await redisSet(redisKeys.sessionMeta(sessionId), JSON.stringify(meta), {
      ex: ttlSec,
    });
  } catch (err) {
    logger.warn("Failed to populate Redis session metadata cache", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

/**
 * Invalidate user cache across all cluster instances and process memory.
 */
export const clearUserCache = async (userId?: string): Promise<void> => {
  ensureAuthCacheSyncInitialized();

  if (userId) {
    inMemoryUserCache.delete(userId);
    if (isRedisAvailable()) {
      try {
        await redisDel(redisKeys.userCache(userId));
      } catch (err) {
        logger.warn("Failed to delete Redis user cache key", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await publishEvent(AUTH_INVALIDATION_CHANNEL, {
        type: "user_cache_clear",
        userId,
        instanceId: INSTANCE_ID,
      } satisfies InvalidationMessage);
    }
  } else {
    inMemoryUserCache.clear();
  }
};

/**
 * Revoke a single login session (and its access token JTI) across all instances.
 */
export const revokeSession = async (
  userId: string,
  sessionId?: string,
  jti?: string,
  reason = "logout",
  tokenExpUnixSec?: number,
): Promise<void> => {
  ensureAuthCacheSyncInitialized();
  const ttlSec = getRevocationTtlSeconds(tokenExpUnixSec);
  const expiresAt = Date.now() + ttlSec * 1000;

  if (sessionId) {
    setBoundedMapEntry(inMemoryRevokedSessions, sessionId, { expiresAt });
  }
  if (jti) {
    setBoundedMapEntry(inMemoryRevokedJtis, jti, { expiresAt });
  }

  await clearUserCache(userId);

  if (isRedisAvailable()) {
    try {
      const ops: Promise<unknown>[] = [];
      if (sessionId) {
        ops.push(redisDel(redisKeys.sessionMeta(sessionId)));
        ops.push(
          redisSet(redisKeys.sessionRevoked(sessionId), reason, { ex: ttlSec }),
        );
      }
      if (jti) {
        ops.push(redisSet(redisKeys.jtiRevoked(jti), reason, { ex: ttlSec }));
      }
      await Promise.all(ops);
    } catch (err) {
      logger.warn("Failed to persist Redis session revocation markers", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await publishEvent(AUTH_INVALIDATION_CHANNEL, {
      type: "session_revoked",
      userId,
      sessionId,
      jti,
      instanceId: INSTANCE_ID,
    } satisfies InvalidationMessage);
  }

  logger.info("Security audit: session revoked", {
    event: "SESSION_REVOKED",
    userId,
    sessionId,
    reason,
  });
};

/**
 * Atomically increment User.tokenVersion in MongoDB (optionally participating in a transaction).
 * Propagates database errors so partial revocations never silently succeed.
 */
export const incrementUserTokenVersion = async (
  userId: string,
  txSession?: ClientSession,
): Promise<number> => {
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $inc: { tokenVersion: 1 } },
    { returnDocument: "after", ...(txSession ? { session: txSession } : {}) },
  )
    .select("tokenVersion")
    .lean();

  if (!updatedUser) {
    throw new Error(`User ${userId} not found during tokenVersion increment`);
  }

  return updatedUser.tokenVersion ?? 1;
};

/**
 * Broadcast global user revocation across local memory, Redis, and Pub/Sub subscribers.
 */
export const broadcastUserRevocation = async (
  userId: string,
  minTokenVersion: number,
  reason = "global_revocation",
): Promise<void> => {
  ensureAuthCacheSyncInitialized();

  const ttlSec = getRevocationTtlSeconds();
  const existing = inMemoryMinTokenVersions.get(userId);
  const nextMin = Math.max(existing?.minVersion ?? 0, minTokenVersion);
  setBoundedMapEntry(inMemoryMinTokenVersions, userId, {
    minVersion: nextMin,
    expiresAt: Date.now() + ttlSec * 1000,
  });

  await clearUserCache(userId);

  if (isRedisAvailable()) {
    try {
      await redisSet(redisKeys.userRevokedVersion(userId), String(nextMin), {
        ex: ttlSec,
      });
    } catch (err) {
      logger.warn("Failed to set Redis session revocation marker", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await publishEvent(AUTH_INVALIDATION_CHANNEL, {
      type: "user_revoked",
      userId,
      minTokenVersion: nextMin,
      instanceId: INSTANCE_ID,
    } satisfies InvalidationMessage);
  }

  logger.info("Security audit: all user sessions revoked", {
    event: "USER_SESSIONS_REVOKED",
    userId,
    reason,
    minTokenVersion: nextMin,
  });
};

/**
 * Signal immediate distributed revocation of all active sessions for a user
 * (logout-all, password change, account deactivation, or reuse compromise).
 */
export const revokeUserSessions = async (
  userId: string,
  reason = "global_revocation",
): Promise<void> => {
  const newTokenVersion = await incrementUserTokenVersion(userId);
  await broadcastUserRevocation(userId, newTokenVersion, reason);
};

const updateSessionActivityThrottled = async (
  sessionId: string | undefined,
  userId: string,
  knownExpiresAtMs?: number,
): Promise<void> => {
  if (!sessionId || !isRedisAvailable()) return;

  const idleHalfSec = Math.max(
    1,
    Math.floor(serverConfig.SESSION_IDLE_TIMEOUT_MS / 2000),
  );
  const throttleSec = Math.max(
    1,
    Math.min(serverConfig.SESSION_ACTIVITY_THROTTLE_SEC, idleHalfSec),
  );

  const nowMs = Date.now();
  const localNextAt = inMemoryActivityThrottle.get(sessionId);
  if (localNextAt !== undefined && nowMs < localNextAt) {
    return;
  }

  const throttleKey = redisKeys.sessionActivityThrottle(sessionId);

  try {
    const acquired = await redisSet(throttleKey, "1", {
      ex: throttleSec,
      nx: true,
    });
    setBoundedMapEntry(
      inMemoryActivityThrottle,
      sessionId,
      nowMs + throttleSec * 1000,
    );
    if (acquired !== "OK") {
      return;
    }

    const now = new Date(nowMs);
    const nextIdleMs = nowMs + serverConfig.SESSION_IDLE_TIMEOUT_MS;

    if (knownExpiresAtMs !== undefined && knownExpiresAtMs > nowMs) {
      const clampedIdleMs = Math.min(knownExpiresAtMs, nextIdleMs);
      const res = await Session.updateOne(
        {
          sessionId,
          user: userId,
          status: "ACTIVE",
          expiresAt: { $gt: now },
          $or: [
            { idleExpiresAt: { $exists: false } },
            { idleExpiresAt: { $gt: now } },
          ],
        },
        {
          $set: {
            lastActivityAt: now,
            idleExpiresAt: new Date(clampedIdleMs),
          },
        },
      );

      if (res.matchedCount === 1) {
        await writeSessionMetaCache(sessionId, {
          userId,
          status: "ACTIVE",
          expiresAtMs: knownExpiresAtMs,
          idleExpiresAtMs: clampedIdleMs,
        });
        return;
      }
    } else {
      const updated = await Session.findOneAndUpdate(
        {
          sessionId,
          user: userId,
          status: "ACTIVE",
          expiresAt: { $gt: now },
          $or: [
            { idleExpiresAt: { $exists: false } },
            { idleExpiresAt: { $gt: now } },
          ],
        },
        [
          {
            $set: {
              lastActivityAt: now,
              idleExpiresAt: { $min: ["$expiresAt", new Date(nextIdleMs)] },
            },
          },
        ],
        { returnDocument: "after", updatePipeline: true },
      )
        .select("expiresAt idleExpiresAt")
        .lean();

      if (updated) {
        await writeSessionMetaCache(sessionId, {
          userId,
          status: "ACTIVE",
          expiresAtMs: updated.expiresAt.getTime(),
          idleExpiresAtMs: updated.idleExpiresAt?.getTime(),
        });
        return;
      }
    }

    const existing = await Session.findOne({ sessionId, user: userId })
      .select("status expiresAt idleExpiresAt")
      .lean();
    if (existing) {
      const isExpired =
        existing.status === "EXPIRED" ||
        existing.expiresAt <= now ||
        Boolean(existing.idleExpiresAt && existing.idleExpiresAt <= now);
      if (isExpired && existing.status === "ACTIVE") {
        await Session.updateOne(
          { _id: existing._id, status: "ACTIVE" },
          {
            $set: {
              status: "EXPIRED",
              revokedAt: now,
              revokedReason: "session_expired",
            },
          },
        );
        logSecurityAudit({
          eventType: "SESSION_EXPIRED",
          userId,
          sessionId,
          success: false,
          reasonCode: "SESSION_EXPIRED_ON_ACTIVITY",
        });
      }
      await revokeSession(
        userId,
        sessionId,
        undefined,
        isExpired ? "session_expired" : "session_inactive",
      );
    }
  } catch (err) {
    logger.error("Failed to update throttled session activity", {
      userId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

const verifyActiveSessionForRequest = async (
  userId: string,
  sid: string | undefined,
  jti: string | undefined,
  tokenExpUnixSec: number | undefined,
  cachedMetaJson: string | null,
  requestId?: string,
  ip?: string,
): Promise<{
  valid: boolean;
  expired?: boolean;
  reason?: string;
  expiresAtMs?: number;
}> => {
  if (!sid) {
    return { valid: true };
  }

  const now = Date.now();

  if (cachedMetaJson) {
    try {
      const meta = JSON.parse(cachedMetaJson) as CachedSessionMeta;
      if (meta && meta.userId === userId) {
        const isExpired =
          meta.status === "EXPIRED" ||
          meta.expiresAtMs <= now ||
          Boolean(meta.idleExpiresAtMs && meta.idleExpiresAtMs <= now);

        if (isExpired) {
          await Session.updateOne(
            { sessionId: sid, user: userId, status: "ACTIVE" },
            {
              $set: {
                status: "EXPIRED",
                revokedAt: new Date(now),
                revokedReason: "session_expired",
              },
            },
          );
          await revokeSession(
            userId,
            sid,
            jti,
            "session_expired",
            tokenExpUnixSec,
          );
          logSecurityAudit({
            eventType: "SESSION_EXPIRED",
            userId,
            sessionId: sid,
            requestId,
            ip,
            success: false,
            reasonCode: "SESSION_IDLE_OR_ABSOLUTE_EXPIRED",
          });
          return { valid: false, expired: true, reason: "session_expired" };
        }

        if (meta.status === "ACTIVE") {
          return { valid: true, expiresAtMs: meta.expiresAtMs };
        }
      }
    } catch {
      // Malformed cached session metadata; fall through to MongoDB lookup
    }
  }

  const dbSession = await Session.findOne({ sessionId: sid, user: userId })
    .select("status expiresAt idleExpiresAt revokedReason")
    .lean();

  if (!dbSession) {
    logSecurityAudit({
      eventType: "UNAUTHORIZED_ACCESS_ATTEMPT",
      userId,
      sessionId: sid,
      requestId,
      ip,
      success: false,
      reasonCode: "DB_SESSION_NOT_FOUND",
    });
    return { valid: false, reason: "session_not_found" };
  }

  const isExpired =
    dbSession.status === "EXPIRED" ||
    dbSession.expiresAt.getTime() <= now ||
    Boolean(
      dbSession.idleExpiresAt && dbSession.idleExpiresAt.getTime() <= now,
    );

  if (isExpired) {
    if (dbSession.status === "ACTIVE") {
      await Session.updateOne(
        { _id: dbSession._id, status: "ACTIVE" },
        {
          $set: {
            status: "EXPIRED",
            revokedAt: new Date(now),
            revokedReason: "session_expired",
          },
        },
      );
    }
    await revokeSession(userId, sid, jti, "session_expired", tokenExpUnixSec);
    logSecurityAudit({
      eventType: "SESSION_EXPIRED",
      userId,
      sessionId: sid,
      requestId,
      ip,
      success: false,
      reasonCode: "SESSION_EXPIRED_DB_FALLBACK",
    });
    return { valid: false, expired: true, reason: "session_expired" };
  }

  if (dbSession.status !== "ACTIVE") {
    const reason = dbSession.revokedReason || "session_revoked";
    await revokeSession(userId, sid, jti, reason, tokenExpUnixSec);
    logSecurityAudit({
      eventType: "UNAUTHORIZED_ACCESS_ATTEMPT",
      userId,
      sessionId: sid,
      requestId,
      ip,
      success: false,
      reasonCode: "DB_SESSION_REVOKED",
    });
    return { valid: false, reason };
  }

  await writeSessionMetaCache(sid, {
    userId,
    status: "ACTIVE",
    expiresAtMs: dbSession.expiresAt.getTime(),
    idleExpiresAtMs: dbSession.idleExpiresAt?.getTime(),
  });

  return { valid: true, expiresAtMs: dbSession.expiresAt.getTime() };
};

export type VerifiedAuthResult =
  | { ok: true; user: IUser; auth: RequestAuthContext }
  | { ok: false; statusCode: 401 | 503; message: string };

/**
 * Shared transport-agnostic access credential verification used by both
 * Express `authenticate` and Socket.IO handshake / token-refresh handlers.
 */
export const verifyAuthenticatedCredential = async (
  token: string,
  meta: { requestId?: string; ip?: string; updateActivity?: boolean } = {},
): Promise<VerifiedAuthResult> => {
  ensureAuthCacheSyncInitialized();

  const failClosedRevocation =
    process.env.REDIS_REVOCATION_FAIL_CLOSED !== undefined
      ? process.env.REDIS_REVOCATION_FAIL_CLOSED !== "false"
      : serverConfig.REDIS_REVOCATION_FAIL_CLOSED;

  const { requestId, ip, updateActivity = true } = meta;

  let decoded: ReturnType<typeof verifyAccessToken>;
  try {
    decoded = verifyAccessToken(token);
  } catch {
    return {
      ok: false,
      statusCode: 401,
      message: "Invalid or expired access token",
    };
  }

  try {
    const userId = decoded.id;
    const tokenVersion = decoded.tv ?? 0;
    const sid = decoded.sid;
    const jti = decoded.jti;
    const tokenExpUnixSec = decoded.exp;
    const now = Date.now();
    const redisReady = isRedisAvailable();

    // 1. LOCAL REVOCATION CHECK (Populated immediately via Pub/Sub & local revocations)
    const localRevokedJti = jti ? inMemoryRevokedJtis.get(jti) : undefined;
    const localRevokedSid = sid ? inMemoryRevokedSessions.get(sid) : undefined;
    const localMinTv = inMemoryMinTokenVersions.get(userId);

    if (
      (localRevokedJti && now < localRevokedJti.expiresAt) ||
      (localRevokedSid && now < localRevokedSid.expiresAt) ||
      (localMinTv &&
        now < localMinTv.expiresAt &&
        tokenVersion < localMinTv.minVersion)
    ) {
      logSecurityAudit({
        eventType: "UNAUTHORIZED_ACCESS_ATTEMPT",
        userId,
        sessionId: sid,
        requestId,
        ip,
        success: false,
        reasonCode: "LOCAL_SESSION_OR_TOKEN_REVOKED",
      });
      return {
        ok: false,
        statusCode: 401,
        message: "Session has been revoked. Please log in again.",
      };
    }

    // 2. DISTRIBUTED SESSION & VERSION REVOCATION CHECK IN REDIS (FAIL-CLOSED)
    let cachedMetaJson: string | null = null;
    let cachedUserJson: string | null = null;

    if (!redisReady) {
      if (failClosedRevocation) {
        logger.error("Redis unavailable for security revocation lookup", {
          requestId,
          userId,
        });
        return {
          ok: false,
          statusCode: 503,
          message: "Authentication security service temporarily unavailable.",
        };
      }
    } else {
      try {
        const keysToCheck = [
          redisKeys.userRevokedVersion(userId),
          redisKeys.userCache(userId),
        ];
        const sidIdx = sid
          ? keysToCheck.push(redisKeys.sessionRevoked(sid)) - 1
          : -1;
        const jtiIdx = jti
          ? keysToCheck.push(redisKeys.jtiRevoked(jti)) - 1
          : -1;
        const metaIdx = sid
          ? keysToCheck.push(redisKeys.sessionMeta(sid)) - 1
          : -1;

        const values = await redisMget(keysToCheck);
        const revokedVersionStr = values[0];
        cachedUserJson = values[1];
        const sessionRevoked = sidIdx >= 0 ? values[sidIdx] : null;
        const jtiRevoked = jtiIdx >= 0 ? values[jtiIdx] : null;
        cachedMetaJson = metaIdx >= 0 ? values[metaIdx] : null;

        if (
          sessionRevoked ||
          jtiRevoked ||
          (revokedVersionStr !== null &&
            tokenVersion < Number(revokedVersionStr))
        ) {
          logSecurityAudit({
            eventType: "UNAUTHORIZED_ACCESS_ATTEMPT",
            userId,
            sessionId: sid,
            requestId,
            ip,
            success: false,
            reasonCode: "REDIS_SESSION_OR_JTI_REVOKED",
          });
          return {
            ok: false,
            statusCode: 401,
            message: "Session has been revoked. Please log in again.",
          };
        }
      } catch (revocationErr) {
        logger.error("Redis revocation check failed", {
          requestId,
          userId,
          error:
            revocationErr instanceof Error
              ? revocationErr.message
              : String(revocationErr),
        });
        if (failClosedRevocation) {
          return {
            ok: false,
            statusCode: 503,
            message: "Authentication security service temporarily unavailable.",
          };
        }
      }
    }

    // 3. SYNCHRONOUS SESSION STATUS, EXPIRY & IDLE CHECK (WITH DB FALLBACK ON CACHE MISS)
    let sessionExpiresAtMs: number | undefined;
    if (sid) {
      const sessionCheck = await verifyActiveSessionForRequest(
        userId,
        sid,
        jti,
        tokenExpUnixSec,
        cachedMetaJson,
        requestId,
        ip,
      );
      if (!sessionCheck.valid) {
        return {
          ok: false,
          statusCode: 401,
          message: sessionCheck.expired
            ? "Session has expired. Please log in again."
            : "Session has been revoked. Please log in again.",
        };
      }
      sessionExpiresAtMs = sessionCheck.expiresAtMs;
    }

    // 4. CHECK DISTRIBUTED REDIS USER CACHE (BOUNDED 30s TTL + PUB/SUB & REDIS REVOCATION CHECKED ABOVE)
    if (redisReady && cachedUserJson) {
      try {
        const cachedUser = JSON.parse(cachedUserJson) as IUser;
        const cachedTv = cachedUser.tokenVersion ?? 0;

        if (!cachedUser.isActive || tokenVersion !== cachedTv) {
          await clearUserCache(userId);
          if (tokenVersion < cachedTv) {
            setBoundedMapEntry(inMemoryMinTokenVersions, userId, {
              minVersion: cachedTv,
              expiresAt: now + getRevocationTtlSeconds(tokenExpUnixSec) * 1000,
            });
          }
          return {
            ok: false,
            statusCode: 401,
            message:
              tokenVersion !== cachedTv
                ? "Session has been revoked. Please log in again."
                : "Unauthorized. User not found or account deactivated.",
          };
        }

        recordCacheHit();
        if (updateActivity) {
          void updateSessionActivityThrottled(sid, userId, sessionExpiresAtMs);
        }
        return {
          ok: true,
          user: cachedUser,
          auth: { jti, sid, tv: tokenVersion, exp: tokenExpUnixSec },
        };
      } catch (cacheErr) {
        logger.warn("Cached user verification failed; falling back to DB", {
          userId,
          error:
            cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
      }
    } else if (!redisReady) {
      // 5. REDIS UNAVAILABLE (FAIL-OPEN MODE ONLY): VERIFY LIVE DB BEFORE USING FALLBACK CACHE
      const localEntry = inMemoryUserCache.get(userId);
      if (localEntry && now < localEntry.expiresAt) {
        const localTv = localEntry.user.tokenVersion ?? 0;
        const liveState = await verifyUserLiveInDb(userId);
        if (
          !localEntry.user.isActive ||
          tokenVersion !== localTv ||
          !liveState ||
          !liveState.isActive ||
          tokenVersion !== liveState.tokenVersion
        ) {
          inMemoryUserCache.delete(userId);
          return {
            ok: false,
            statusCode: 401,
            message:
              liveState && tokenVersion !== liveState.tokenVersion
                ? "Session has been revoked. Please log in again."
                : "Unauthorized. User not found or account deactivated.",
          };
        }

        return {
          ok: true,
          user: localEntry.user,
          auth: { jti, sid, tv: tokenVersion, exp: tokenExpUnixSec },
        };
      }
    }

    // 6. AUTHORITATIVE MONGODB QUERY WITH STAMPEDE COALESCING (NO PASSWORD)
    if (redisReady) {
      recordCacheMiss();
    }
    const user = await fetchUserFromDatabase(userId);

    if (!user || !user.isActive) {
      await clearUserCache(userId);
      return {
        ok: false,
        statusCode: 401,
        message: "Unauthorized. User not found or account deactivated.",
      };
    }

    const dbTokenVersion = user.tokenVersion ?? 0;
    if (tokenVersion !== dbTokenVersion) {
      return {
        ok: false,
        statusCode: 401,
        message: "Session has been revoked. Please log in again.",
      };
    }

    // 7. POPULATE REDIS CACHE (AND LOCAL FALLBACK ONLY WHEN REDIS IS DOWN)
    if (redisReady) {
      try {
        await redisSet(redisKeys.userCache(userId), JSON.stringify(user), {
          ex: USER_CACHE_TTL_SEC,
        });
      } catch (setCacheErr) {
        logger.warn("Failed to populate Redis user cache", {
          userId,
          error:
            setCacheErr instanceof Error
              ? setCacheErr.message
              : String(setCacheErr),
        });
      }
    } else {
      setBoundedMapEntry(inMemoryUserCache, userId, {
        user,
        expiresAt: now + LOCAL_FALLBACK_CACHE_TTL_MS,
      });
    }

    if (updateActivity) {
      void updateSessionActivityThrottled(sid, userId, sessionExpiresAtMs);
    }

    return {
      ok: true,
      user,
      auth: { jti, sid, tv: tokenVersion, exp: tokenExpUnixSec },
    };
  } catch (err) {
    logger.error("Authentication database verification failed", {
      requestId,
      userId: decoded.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      statusCode: 503,
      message: "Authentication service temporarily unavailable.",
    };
  }
};

/**
 * Authenticate user using JWT access token.
 *
 * Header:
 * Authorization: Bearer <access_token>
 */
export const authenticate: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      message: "Authorization token is required",
    });
    return;
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    res.status(401).json({
      success: false,
      message: "Authorization token is required",
    });
    return;
  }

  const requestId = (req as Request & { requestId?: string }).requestId;
  const result = await verifyAuthenticatedCredential(token, {
    requestId,
    ip: req.ip,
    updateActivity: true,
  });

  if (!result.ok) {
    res.status(result.statusCode).json({
      success: false,
      message: result.message,
    });
    return;
  }

  req.user = result.user;
  req.auth = result.auth;
  next();
};

/**
 * Authorize users by role.
 */
export const authorize = (...roles: UserRole[]): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        message: "Forbidden. Insufficient permissions.",
      });
      return;
    }

    next();
  };
};

/**
 * Allow access only when the logged-in user's rank is
 * strictly higher than the target user's rank.
 * Supports `:userId` (primary contract) and `:id` (legacy fallback).
 */
export const requireHigherRank: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const rawUserId = req.params?.userId;
    const rawId = req.params?.id;
    const targetId =
      typeof rawUserId === "string" && rawUserId.trim()
        ? rawUserId.trim()
        : typeof rawId === "string" && rawId.trim()
          ? rawId.trim()
          : "";

    if (!targetId) {
      res.status(400).json({
        success: false,
        message: "Target user ID is required",
      });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      res.status(400).json({
        success: false,
        message: "Invalid target user ID",
      });
      return;
    }

    if (req.user._id.toString() === targetId) {
      res.status(403).json({
        success: false,
        message: "You cannot perform this action on your own account",
      });
      return;
    }

    const target = await User.findById(targetId);

    if (!target) {
      res.status(404).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    const currentRank = ROLE_RANK[req.user.role];
    const targetRank = ROLE_RANK[target.role];

    if (currentRank <= targetRank) {
      res.status(403).json({
        success: false,
        message: "Insufficient privileges to manage this user",
      });
      return;
    }

    req.targetUser = target;

    next();
  } catch (error) {
    logger.error("requireHigherRank error:", { error });

    res.status(500).json({
      success: false,
      message: "Failed to verify user permissions",
    });
  }
};
