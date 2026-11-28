import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { ClientSession } from "mongoose";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth, DecodedIdToken } from "firebase-admin/auth";
import { User, IUser } from "../models/user.model.js";
import { Student } from "../models/student.model.js";
import { Cafe, CafeApprovalStatus } from "../models/cafe.model.js";
import { RefreshToken } from "../models/refreshToken.model.js";
import { Session, ISession } from "../models/session.model.js";
import { runWithOptionalTransaction } from "../config/db.config.js";
import {
  extractClientMetadata,
  maskIpAddress,
  SessionClientMetadata,
} from "../utils/session/device.util.js";
import {
  generateTokens,
  verifyRefreshToken,
  TokenPair,
} from "../utils/jwt/jwt.js";
import {
  BadRequestError,
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from "../utils/errors/app.error.js";
import { serverConfig } from "../config/index.js";
import { hashPassword, verifyPassword } from "../utils/password/password.js";
import { cacheDeleteKeys, redisKeys } from "../infrastructure/redis/index.js";

/* =====================================================
   FIREBASE CONFIGURATION
===================================================== */
const getFirebaseAuth = () => {
  if (getApps().length === 0) {
    const projectId = serverConfig.FIREBASE_PROJECT_ID;
    const clientEmail = serverConfig.FIREBASE_CLIENT_EMAIL;
    const privateKey = serverConfig.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
      throw new InternalServerError("Social login not configured");
    }

    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
    });
  }

  return getAuth();
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* =====================================================
   TYPES
===================================================== */

type SocialProvider = "google" | "apple";
type SocialRole = "student" | "cafeOwner";

interface SocialProfile {
  provider: SocialProvider;
  providerId: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export interface AuthResult {
  user: IUser;
  token: string;
  refreshToken: string;
  isApproved?: boolean;
  approvalStatus?: CafeApprovalStatus | "not_registered";
}

import {
  clearUserCache,
  revokeSession,
  incrementUserTokenVersion,
  broadcastUserRevocation,
  RequestAuthContext,
} from "../middlewares/authenticate.middleware.js";
import logger, { logSecurityAudit } from "../config/logger.config.js";

/* =====================================================
   COMMON HELPERS
===================================================== */

const safeEqual = (a: string, b: string): boolean => {
  const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
  const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(hashA, hashB);
};

const toDuplicateKeyError = (error: unknown, message: string): unknown => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 11000
  ) {
    return new ConflictError(message);
  }

  return error;
};

/* =====================================================
   REFRESH TOKEN HELPERS
===================================================== */
const hashToken = (token: string): string => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

const hashForAudit = (value: string): string => {
  return crypto
    .createHash("sha256")
    .update(value.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
};

const issueTokens = async (
  user: IUser,
  metadata?: SessionClientMetadata,
  sessionId?: string,
  familyId?: string,
  txSession?: ClientSession,
): Promise<TokenPair> => {
  const tokens = generateTokens({
    id: user._id.toString(),
    role: user.role,
    tokenVersion: user.tokenVersion ?? 0,
    sessionId,
    familyId,
  });

  const decoded = jwt.decode(tokens.refreshToken) as {
    exp?: number;
    iat?: number;
  } | null;

  if (!decoded?.exp) {
    throw new InternalServerError("Failed to issue refresh token");
  }

  const now = decoded.iat ? new Date(decoded.iat * 1000) : new Date();
  const expiresAt = new Date(decoded.exp * 1000);
  const idleTimeoutMs = serverConfig.SESSION_IDLE_TIMEOUT_MS;
  const idleExpiresAt = new Date(
    Math.min(expiresAt.getTime(), now.getTime() + idleTimeoutMs),
  );
  const clientMeta = metadata ?? extractClientMetadata();

  let createdSession = false;
  if (!sessionId) {
    const sessionDoc = {
      sessionId: tokens.sessionId,
      user: user._id,
      familyId: tokens.familyId,
      deviceName: clientMeta.deviceName,
      deviceType: clientMeta.deviceType,
      os: clientMeta.os,
      browser: clientMeta.browser,
      userAgent: clientMeta.userAgent,
      ipAddress: clientMeta.ipAddress,
      loginAt: now,
      lastActivityAt: now,
      expiresAt,
      idleExpiresAt,
      status: "ACTIVE" as const,
    };
    if (txSession) {
      await Session.create([sessionDoc], { session: txSession });
    } else {
      await Session.create(sessionDoc);
    }
    createdSession = true;
  }

  const tokenDoc = {
    user: user._id,
    jti: tokens.refreshJti,
    sessionId: tokens.sessionId,
    familyId: tokens.familyId,
    tokenHash: hashToken(tokens.refreshToken),
    status: "active" as const,
    isRevoked: false,
    issuedAt: now,
    expiresAt,
  };

  try {
    if (txSession) {
      await RefreshToken.create([tokenDoc], { session: txSession });
    } else {
      await RefreshToken.create(tokenDoc);
    }
  } catch (err) {
    if (createdSession && !txSession) {
      await Session.deleteOne({ sessionId: tokens.sessionId }).catch(() => {});
    }
    throw err;
  }

  if (createdSession) {
    logSecurityAudit({
      eventType: "SESSION_CREATED",
      userId: user._id.toString(),
      sessionId: tokens.sessionId,
      ip: maskIpAddress(clientMeta.ipAddress),
      userAgent: clientMeta.userAgent,
      success: true,
      reasonCode: "LOGIN_SESSION_CREATED",
      metadata: {
        deviceType: clientMeta.deviceType,
        os: clientMeta.os,
        browser: clientMeta.browser,
      },
    });
  }

  return tokens;
};

const buildAuthResult = async (
  user: IUser,
  metadata?: SessionClientMetadata,
): Promise<AuthResult> => {
  const { accessToken, refreshToken } = await runWithOptionalTransaction(
    (txSession) => issueTokens(user, metadata, undefined, undefined, txSession),
  );

  return {
    user,
    token: accessToken,
    refreshToken,
  };
};

const revokeTokenFamily = async (
  familyId: string | undefined,
  fallbackUserId: string,
  reason: string,
  txSession?: ClientSession,
): Promise<void> => {
  const filter = familyId
    ? { familyId, status: { $ne: "revoked" as const } }
    : { user: fallbackUserId, status: { $ne: "revoked" as const } };

  await RefreshToken.updateMany(
    filter,
    {
      $set: {
        status: "revoked",
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    },
    txSession ? { session: txSession } : undefined,
  );
};

/* =====================================================
   ADMIN REGISTER 
===================================================== */
export const adminRegisterService = async (
  name: string,
  email: string,
  password: string,
  secret: string,
  metadata?: SessionClientMetadata,
): Promise<AuthResult> => {
  if (process.env.ALLOW_ADMIN_REGISTRATION === "false") {
    throw new ForbiddenError("Admin registration is disabled");
  }

  const expectedSecret = serverConfig.ADMIN_REGISTER_SECRET;

  if (!expectedSecret || expectedSecret.length < 16) {
    throw new InternalServerError("Admin registration not configured");
  }

  if (
    typeof secret !== "string" ||
    !secret ||
    !safeEqual(secret, expectedSecret)
  ) {
    logSecurityAudit({
      eventType: "PRIVILEGE_ESCALATION_ATTEMPT",
      success: false,
      reasonCode: "ADMIN_REGISTER_INVALID_SECRET",
    });
    throw new ForbiddenError("Invalid admin registration secret");
  }

  const normalizedName = typeof name === "string" ? name.trim() : "";

  const normalizedEmail =
    typeof email === "string" ? email.trim().toLowerCase() : "";

  if (!normalizedName) {
    throw new BadRequestError("Name is required");
  }

  if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
    throw new BadRequestError("Invalid email");
  }

  logger.info("Admin registration started", {
    emailHash: hashForAudit(normalizedEmail),
    operation: "ADMIN_REGISTER",
  });

  const existingAdmin = await User.exists({ role: "admin" });
  if (existingAdmin) {
    logSecurityAudit({
      eventType: "PRIVILEGE_ESCALATION_ATTEMPT",
      success: false,
      reasonCode: "ADMIN_REGISTER_ALREADY_EXISTS",
    });
    throw new ConflictError("An administrator account already exists");
  }

  const existingUser = await User.findOne({
    email: normalizedEmail,
  });

  if (existingUser) {
    throw new ConflictError("An account already exists with this email");
  }

  const hashedPassword = await hashPassword(password);

  let user: IUser;

  try {
    user = (await User.create({
      name: normalizedName,
      email: normalizedEmail,
      password: hashedPassword,
      authProvider: "password",
      role: "admin",
      isVerified: true,
      tokenVersion: 0,
    })) as IUser;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      const keyPattern = (error as { keyPattern?: Record<string, unknown> })
        .keyPattern;
      if (keyPattern && "role" in keyPattern) {
        throw new ConflictError("An administrator account already exists");
      }
      throw new ConflictError("An account already exists with this email");
    }
    throw error;
  }

  logSecurityAudit({
    eventType: "ADMIN_CREATED",
    userId: user._id.toString(),
    success: true,
    reasonCode: "BOOTSTRAP_ADMIN_CREATED",
    metadata: { emailHash: hashForAudit(normalizedEmail) },
  });
  logger.info("Admin registration completed", {
    userId: user._id.toString(),
    operation: "ADMIN_REGISTER",
  });

  return buildAuthResult(user, metadata);
};

/* =====================================================
   ADMIN LOGIN
===================================================== */

export const adminLoginService = async (
  email: string,
  password: string,
  metadata?: SessionClientMetadata,
): Promise<AuthResult> => {
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email.trim() ||
    !password
  ) {
    throw new BadRequestError("Email and password are required");
  }

  const normalizedEmail = email.trim().toLowerCase();

  const user = await User.findOne({
    email: normalizedEmail,
  }).select("+password");

  const passwordMatches = await verifyPassword(password, user?.password);

  if (
    !user ||
    user.role !== "admin" ||
    user.authProvider !== "password" ||
    !user.password ||
    !passwordMatches
  ) {
    logSecurityAudit({
      eventType: "ADMIN_LOGIN_FAILURE",
      userId: user?._id?.toString(),
      success: false,
      reasonCode: "INVALID_CREDENTIALS",
      metadata: { emailHash: hashForAudit(normalizedEmail) },
    });
    throw new UnauthorizedError("Invalid email or password");
  }

  if (!user.isActive) {
    logSecurityAudit({
      eventType: "ADMIN_LOGIN_FAILURE",
      userId: user._id.toString(),
      success: false,
      reasonCode: "ACCOUNT_DEACTIVATED",
    });
    throw new ForbiddenError("Your account is deactivated");
  }

  logSecurityAudit({
    eventType: "ADMIN_LOGIN",
    userId: user._id.toString(),
    success: true,
    reasonCode: "ADMIN_LOGIN_SUCCESS",
  });

  return buildAuthResult(user as IUser, metadata);
};

/* =====================================================
   REFRESH TOKEN (STRICT SINGLE-USE ROTATION + FAMILY REUSE DETECTION)
===================================================== */

export const refreshTokenService = async (
  refreshToken: string,
): Promise<AuthResult> => {
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new BadRequestError("Refresh token is required");
  }

  let decoded: ReturnType<typeof verifyRefreshToken>;

  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  const currentHash = hashToken(refreshToken);

  // Find the stored token record
  const stored = await RefreshToken.findOne({
    tokenHash: currentHash,
  });

  if (!stored) {
    // Unknown or TTL-expired token. If JWT carries a familyId, ensure that family is revoked.
    if (decoded.fid) {
      const existingFamily = await RefreshToken.exists({
        familyId: decoded.fid,
        user: decoded.id,
      });
      if (existingFamily) {
        const nextVersion = await runWithOptionalTransaction(
          async (txSession) => {
            await revokeTokenFamily(
              decoded.fid,
              decoded.id,
              "unknown_family_token_replay",
              txSession,
            );
            return incrementUserTokenVersion(decoded.id, txSession);
          },
        );
        await broadcastUserRevocation(
          decoded.id,
          nextVersion,
          "unknown_family_token_replay",
        );
      }
    }
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  // Distinguish true token reuse (already-rotated or compromise replay) from explicit session revocation
  if ((stored.status ?? "active") !== "active" || stored.isRevoked) {
    const isGenuineReuse =
      stored.status === "rotated" ||
      stored.revokedReason === "refresh_token_reuse_detected" ||
      stored.revokedReason === "unknown_family_token_replay";

    if (!isGenuineReuse) {
      logSecurityAudit({
        eventType: "SESSION_INVALID_ACCESS_ATTEMPT",
        userId: decoded.id,
        sessionId: stored.sessionId,
        success: false,
        reasonCode: "REVOKED_SESSION_REFRESH_ATTEMPT",
        metadata: {
          familyId: stored.familyId,
          priorStatus: stored.status,
          revokedReason: stored.revokedReason,
        },
      });
      throw new UnauthorizedError(
        "Session has been revoked or logged out. Please log in again.",
      );
    }

    const nextVersion = await runWithOptionalTransaction(async (txSession) => {
      await revokeTokenFamily(
        stored.familyId,
        decoded.id,
        "refresh_token_reuse_detected",
        txSession,
      );
      if (stored.sessionId) {
        await Session.updateOne(
          { sessionId: stored.sessionId, status: "ACTIVE" },
          {
            $set: {
              status: "REVOKED",
              revokedAt: new Date(),
              revokedReason: "refresh_token_reuse_detected",
            },
          },
          txSession ? { session: txSession } : undefined,
        );
      }
      return incrementUserTokenVersion(decoded.id, txSession);
    });

    await revokeSession(
      decoded.id,
      stored.sessionId,
      undefined,
      "refresh_token_reuse_detected",
    );
    await broadcastUserRevocation(
      decoded.id,
      nextVersion,
      "refresh_token_reuse_detected",
    );

    logSecurityAudit({
      eventType: "SESSION_REUSE_DETECTED",
      userId: decoded.id,
      sessionId: stored.sessionId,
      success: false,
      reasonCode: "REFRESH_TOKEN_REUSE_DETECTED",
      metadata: { familyId: stored.familyId, priorStatus: stored.status },
    });

    throw new UnauthorizedError(
      "Refresh token reuse detected. All sessions revoked. Please log in again.",
    );
  }

  // Validate associated Session state, idle timeout, and absolute expiration
  const now = new Date();
  const activeSession = stored.sessionId
    ? await Session.findOne({ sessionId: stored.sessionId, user: decoded.id })
    : null;

  if (stored.sessionId && !activeSession) {
    await revokeTokenFamily(stored.familyId, decoded.id, "session_not_found");
    await revokeSession(
      decoded.id,
      stored.sessionId,
      undefined,
      "session_not_found",
    );
    logSecurityAudit({
      eventType: "SESSION_INVALID_ACCESS_ATTEMPT",
      userId: decoded.id,
      sessionId: stored.sessionId,
      success: false,
      reasonCode: "REFRESH_SESSION_NOT_FOUND",
    });
    throw new UnauthorizedError("Session has expired. Please log in again.");
  }

  if (activeSession) {
    const isExpired =
      activeSession.status === "EXPIRED" ||
      activeSession.expiresAt <= now ||
      Boolean(
        activeSession.idleExpiresAt && activeSession.idleExpiresAt <= now,
      );

    if (isExpired) {
      await runWithOptionalTransaction(async (txSession) => {
        if (activeSession.status === "ACTIVE") {
          await Session.updateOne(
            { _id: activeSession._id, status: "ACTIVE" },
            {
              $set: {
                status: "EXPIRED",
                revokedAt: now,
                revokedReason: "session_expired",
              },
            },
            txSession ? { session: txSession } : undefined,
          );
        }
        await revokeTokenFamily(
          stored.familyId,
          decoded.id,
          "session_expired",
          txSession,
        );
      });
      await revokeSession(
        decoded.id,
        activeSession.sessionId,
        undefined,
        "session_expired",
      );
      logSecurityAudit({
        eventType: "SESSION_EXPIRED",
        userId: decoded.id,
        sessionId: activeSession.sessionId,
        success: false,
        reasonCode: "SESSION_IDLE_OR_ABSOLUTE_EXPIRED",
      });
      throw new UnauthorizedError("Session has expired. Please log in again.");
    }

    if (activeSession.status !== "ACTIVE") {
      await revokeTokenFamily(stored.familyId, decoded.id, "session_revoked");
      await revokeSession(
        decoded.id,
        activeSession.sessionId,
        undefined,
        "session_revoked",
      );
      logSecurityAudit({
        eventType: "SESSION_INVALID_ACCESS_ATTEMPT",
        userId: decoded.id,
        sessionId: activeSession.sessionId,
        success: false,
        reasonCode: "REFRESH_ON_REVOKED_SESSION",
      });
      throw new UnauthorizedError(
        "Session has been revoked. Please log in again.",
      );
    }
  }

  // Fetch user before rotating
  const user = await User.findById(decoded.id);

  if (!user) {
    await revokeTokenFamily(undefined, decoded.id, "user_not_found");
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  if (!user.isActive) {
    const nextVersion = await runWithOptionalTransaction(async (txSession) => {
      await revokeTokenFamily(
        undefined,
        user._id.toString(),
        "account_deactivated",
        txSession,
      );
      return incrementUserTokenVersion(user._id.toString(), txSession);
    });
    await broadcastUserRevocation(
      user._id.toString(),
      nextVersion,
      "account_deactivated",
    );
    throw new ForbiddenError("Your account is deactivated");
  }

  const userTokenVersion = user.tokenVersion ?? 0;
  if ((decoded.tv ?? 0) !== userTokenVersion) {
    await revokeTokenFamily(
      stored.familyId,
      user._id.toString(),
      "token_version_mismatch",
    );
    throw new UnauthorizedError(
      "Session has been revoked. Please log in again.",
    );
  }

  const sessionId = stored.sessionId || decoded.sid || crypto.randomUUID();
  const familyId = stored.familyId || decoded.fid || crypto.randomUUID();

  // Generate successor tokens within the same session & token family
  const newTokens = generateTokens({
    id: user._id.toString(),
    role: user.role,
    tokenVersion: userTokenVersion,
    sessionId,
    familyId,
  });

  const newDecoded = jwt.decode(newTokens.refreshToken) as {
    exp?: number;
    iat?: number;
  } | null;
  if (!newDecoded?.exp) {
    throw new InternalServerError("Failed to issue refresh token");
  }

  const newHash = hashToken(newTokens.refreshToken);

  const rotationOutcome = await runWithOptionalTransaction(
    async (txSession) => {
      const sessionOpt = txSession ? { session: txSession } : {};
      const updated = await RefreshToken.findOneAndUpdate(
        {
          _id: stored._id,
          isRevoked: false,
          $or: [{ status: "active" }, { status: { $exists: false } }],
        },
        {
          $set: {
            status: "rotated",
            isRevoked: true,
            rotatedAt: new Date(),
            replacedByTokenHash: newHash,
          },
        },
        { returnDocument: "after", ...sessionOpt },
      );

      if (!updated) {
        const latest = await RefreshToken.findById(stored._id, undefined, sessionOpt)
          .select("status revokedReason")
          .lean();

        const isBenignLogoutRace =
          latest?.status === "revoked" &&
          latest.revokedReason !== "refresh_token_reuse_detected" &&
          latest.revokedReason !== "unknown_family_token_replay" &&
          latest.revokedReason !== "concurrent_refresh_conflict";

        if (isBenignLogoutRace) {
          return {
            conflict: true as const,
            genuineReuse: false as const,
            revokedReason: latest.revokedReason || "logout",
          };
        }

        await revokeTokenFamily(
          familyId,
          user._id.toString(),
          "concurrent_refresh_conflict",
          txSession,
        );
        await Session.updateOne(
          { sessionId, user: user._id, status: "ACTIVE" },
          {
            $set: {
              status: "REVOKED",
              revokedAt: new Date(),
              revokedReason: "concurrent_refresh_conflict",
            },
          },
          sessionOpt,
        );
        const nextVersion = await incrementUserTokenVersion(
          user._id.toString(),
          txSession,
        );
        return {
          conflict: true as const,
          genuineReuse: true as const,
          nextVersion,
        };
      }

      const successorDoc = {
        user: user._id,
        jti: newTokens.refreshJti,
        sessionId,
        familyId,
        tokenHash: newHash,
        status: "active" as const,
        isRevoked: false,
        issuedAt: newDecoded.iat ? new Date(newDecoded.iat * 1000) : new Date(),
        expiresAt: new Date(newDecoded.exp! * 1000),
      };

      try {
        if (txSession) {
          await RefreshToken.create([successorDoc], { session: txSession });
        } else {
          await RefreshToken.create(successorDoc);
        }
      } catch (createErr) {
        if (!txSession) {
          // Standalone fallback: compensate so family is cleanly revoked instead of orphaned
          await revokeTokenFamily(
            familyId,
            user._id.toString(),
            "refresh_rotation_partial_failure",
          ).catch(() => {});
        }
        throw createErr;
      }

      if (activeSession) {
        const refreshTime = new Date();
        const nextIdle = new Date(
          Math.min(
            activeSession.expiresAt.getTime(),
            refreshTime.getTime() + serverConfig.SESSION_IDLE_TIMEOUT_MS,
          ),
        );
        await Session.updateOne(
          { _id: activeSession._id, status: "ACTIVE" },
          {
            $set: {
              lastRefreshAt: refreshTime,
              lastActivityAt: refreshTime,
              idleExpiresAt: nextIdle,
            },
          },
          sessionOpt,
        );
      }

      return { conflict: false as const };
    },
  );

  if (rotationOutcome.conflict) {
    if (!rotationOutcome.genuineReuse) {
      await revokeSession(
        user._id.toString(),
        sessionId,
        undefined,
        rotationOutcome.revokedReason,
      );
      logSecurityAudit({
        eventType: "SESSION_INVALID_ACCESS_ATTEMPT",
        userId: user._id.toString(),
        sessionId,
        success: false,
        reasonCode: "REVOKED_SESSION_REFRESH_RACE",
        metadata: {
          familyId,
          revokedReason: rotationOutcome.revokedReason,
        },
      });
      throw new UnauthorizedError(
        "Session has been revoked or logged out. Please log in again.",
      );
    }

    await revokeSession(
      user._id.toString(),
      sessionId,
      undefined,
      "concurrent_refresh_conflict",
    );
    await broadcastUserRevocation(
      user._id.toString(),
      rotationOutcome.nextVersion,
      "concurrent_refresh_conflict",
    );

    logSecurityAudit({
      eventType: "SESSION_REUSE_DETECTED",
      userId: user._id.toString(),
      sessionId,
      success: false,
      reasonCode: "CONCURRENT_REFRESH_CONFLICT",
      metadata: { familyId },
    });

    throw new UnauthorizedError(
      "Refresh token reuse detected. All sessions revoked. Please log in again.",
    );
  }

  await cacheDeleteKeys(redisKeys.sessionMeta(sessionId));

  logger.info("Refresh token rotated", {
    userId: user._id.toString(),
    sessionId,
    familyId,
    operation: "REFRESH_ROTATE",
  });
  logSecurityAudit({
    eventType: "REFRESH_SUCCESS",
    userId: user._id.toString(),
    sessionId,
    success: true,
    reasonCode: "REFRESH_ROTATED",
  });

  return {
    user: user as IUser,
    token: newTokens.accessToken,
    refreshToken: newTokens.refreshToken,
  };
};

/* =====================================================
   LOGOUT (SINGLE SESSION) & LOGOUT ALL
===================================================== */

export const logoutService = async (
  refreshToken: string,
  authenticatedUserId?: string | unknown,
  authContext?: RequestAuthContext,
): Promise<void> => {
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    throw new BadRequestError("Refresh token is required");
  }

  let decoded: ReturnType<typeof verifyRefreshToken>;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  const uid = authenticatedUserId ? String(authenticatedUserId) : decoded.id;
  if (authenticatedUserId && decoded.id !== uid) {
    logSecurityAudit({
      eventType: "SESSION_INVALID_ACCESS_ATTEMPT",
      userId: uid,
      sessionId: authContext?.sid,
      success: false,
      reasonCode: "LOGOUT_REFRESH_TOKEN_USER_MISMATCH",
    });
    throw new UnauthorizedError(
      "Refresh token does not belong to the authenticated user",
    );
  }

  if (authContext?.sid && decoded.sid && decoded.sid !== authContext.sid) {
    logSecurityAudit({
      eventType: "SESSION_INVALID_ACCESS_ATTEMPT",
      userId: uid,
      sessionId: authContext.sid,
      success: false,
      reasonCode: "LOGOUT_REFRESH_TOKEN_SESSION_MISMATCH",
    });
    throw new UnauthorizedError(
      "Refresh token does not match the current session",
    );
  }

  const tokenHash = hashToken(refreshToken);
  const existingToken = await RefreshToken.findOne({
    tokenHash,
    user: uid,
  })
    .select("familyId sessionId user status revokedReason")
    .lean();

  if (!existingToken) {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  if (authContext?.sid && existingToken.sessionId !== authContext.sid) {
    logSecurityAudit({
      eventType: "SESSION_INVALID_ACCESS_ATTEMPT",
      userId: uid,
      sessionId: authContext.sid,
      success: false,
      reasonCode: "LOGOUT_REFRESH_TOKEN_SESSION_MISMATCH",
    });
    throw new UnauthorizedError(
      "Refresh token does not match the current session",
    );
  }

  const targetSid = authContext?.sid ?? existingToken.sessionId;

  if (existingToken.status === "rotated") {
    throw new UnauthorizedError("Refresh token has already been rotated");
  }

  if (existingToken.status === "revoked") {
    const isIdempotentLogout =
      existingToken.revokedReason === "logout" ||
      existingToken.revokedReason === "device_logout";

    if (!isIdempotentLogout) {
      throw new UnauthorizedError("Refresh token has already been revoked");
    }

    await revokeSession(
      uid,
      targetSid,
      authContext?.jti,
      existingToken.revokedReason,
      authContext?.exp,
    );
    return;
  }

  await runWithOptionalTransaction(async (txSession) => {
    const sessionOpt = txSession ? { session: txSession } : {};
    await RefreshToken.updateMany(
      {
        user: uid,
        $or: [
          ...(existingToken.familyId
            ? [{ familyId: existingToken.familyId }]
            : []),
          ...(targetSid ? [{ sessionId: targetSid }] : []),
          { _id: existingToken._id },
        ],
        status: { $ne: "revoked" },
      },
      {
        $set: {
          status: "revoked",
          isRevoked: true,
          revokedAt: new Date(),
          revokedReason: "logout",
        },
      },
      sessionOpt,
    );

    if (targetSid) {
      await Session.updateOne(
        { sessionId: targetSid, user: uid, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revokedAt: new Date(),
            revokedReason: "logout",
          },
        },
        sessionOpt,
      );
    }
  });

  await revokeSession(
    uid,
    targetSid,
    authContext?.jti,
    "logout",
    authContext?.exp,
  );
  logSecurityAudit({
    eventType: "LOGOUT",
    userId: uid,
    sessionId: targetSid,
    success: true,
    reasonCode: "USER_LOGOUT",
  });
  logger.info("User session logged out", {
    userId: uid,
    sessionId: targetSid,
    operation: "LOGOUT",
  });
};

export const logoutAllService = async (
  authenticatedUserId: string | unknown,
  requestId?: string,
): Promise<{ revokedSessions: number }> => {
  if (!authenticatedUserId) {
    throw new BadRequestError("Authenticated user ID is required");
  }

  const uid = String(authenticatedUserId);
  const now = new Date();

  const { revokedSessions, newTokenVersion } = await runWithOptionalTransaction(
    async (txSession) => {
      const sessionOpt = txSession ? { session: txSession } : {};
      const sessionResult = await Session.updateMany(
        {
          user: uid,
          status: "ACTIVE",
        },
        {
          $set: {
            status: "REVOKED",
            revokedAt: now,
            revokedReason: "logout_all",
          },
        },
        sessionOpt,
      );

      await RefreshToken.updateMany(
        {
          user: uid,
          status: { $ne: "revoked" },
        },
        {
          $set: {
            status: "revoked",
            isRevoked: true,
            revokedAt: now,
            revokedReason: "logout_all",
          },
        },
        sessionOpt,
      );

      const nextVersion = await incrementUserTokenVersion(uid, txSession);

      return {
        revokedSessions: sessionResult.modifiedCount,
        newTokenVersion: nextVersion,
      };
    },
  );

  await broadcastUserRevocation(uid, newTokenVersion, "logout_all");

  logSecurityAudit({
    eventType: "LOGOUT_ALL",
    userId: uid,
    requestId,
    success: true,
    reasonCode: "USER_LOGOUT_ALL",
    metadata: { revokedSessions },
  });
  logger.info("All user sessions revoked", {
    userId: uid,
    revokedSessions,
    operation: "LOGOUT_ALL",
  });

  return { revokedSessions };
};

/* =====================================================
   MULTI-DEVICE SESSION MANAGEMENT APIS
===================================================== */

const formatSessionDto = (s: ISession, currentSessionId?: string) => ({
  sessionId: s.sessionId,
  deviceName: s.deviceName,
  deviceType: s.deviceType,
  browser: s.browser,
  os: s.os,
  ipMasked: maskIpAddress(s.ipAddress),
  status: s.status,
  loginAt: s.loginAt,
  lastActivityAt: s.lastActivityAt,
  lastRefreshAt: s.lastRefreshAt ?? null,
  expiresAt: s.expiresAt,
  isCurrent: Boolean(currentSessionId && s.sessionId === currentSessionId),
});

export const listActiveSessionsService = async (
  userId: string,
  currentSessionId?: string,
  query: Record<string, unknown> = {},
  requestId?: string,
) => {
  const pageRaw = Number(query.page ?? 1);
  const limitRaw = Number(query.limit ?? 20);
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const limit =
    Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, 50) : 20;
  const skip = (page - 1) * limit;
  const now = new Date();

  const filter = {
    user: userId,
    status: "ACTIVE" as const,
    expiresAt: { $gt: now },
    $or: [
      { idleExpiresAt: { $exists: false } },
      { idleExpiresAt: { $gt: now } },
    ],
  };

  const [sessions, total] = await Promise.all([
    Session.find(filter)
      .sort({ lastActivityAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<ISession[]>(),
    Session.countDocuments(filter),
  ]);

  logSecurityAudit({
    eventType: "SESSION_LIST_VIEWED",
    userId,
    sessionId: currentSessionId,
    requestId,
    success: true,
    reasonCode: "ACTIVE_SESSIONS_LISTED",
    metadata: { count: sessions.length },
  });

  return {
    sessions: sessions.map((s) => formatSessionDto(s, currentSessionId)),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};

export const getCurrentSessionService = async (
  userId: string,
  currentSessionId?: string,
) => {
  if (!currentSessionId) {
    throw new NotFoundError("Current session identifier is missing");
  }

  const session = await Session.findOne({
    sessionId: currentSessionId,
    user: userId,
  }).lean<ISession | null>();

  if (!session) {
    throw new NotFoundError("Active session not found");
  }

  const now = new Date();
  if (
    session.status === "ACTIVE" &&
    (session.expiresAt <= now ||
      (session.idleExpiresAt && session.idleExpiresAt <= now))
  ) {
    await Session.updateOne(
      { _id: session._id, status: "ACTIVE" },
      {
        $set: {
          status: "EXPIRED",
          revokedAt: now,
          revokedReason: "session_expired",
        },
      },
    );
    throw new UnauthorizedError("Session has expired. Please log in again.");
  }

  if (session.status !== "ACTIVE") {
    throw new UnauthorizedError(
      "Session has been revoked. Please log in again.",
    );
  }

  return formatSessionDto(session, currentSessionId);
};

export const revokeDeviceSessionService = async (
  userId: string,
  targetSessionId: string,
  currentSessionId?: string,
  currentJti?: string,
  requestId?: string,
  currentTokenExp?: number,
) => {
  const sid = typeof targetSessionId === "string" ? targetSessionId.trim() : "";
  if (!sid || sid.length > 128) {
    throw new BadRequestError("Valid sessionId is required");
  }

  const existing = await Session.findOne({
    sessionId: sid,
    user: userId,
  });

  if (!existing) {
    throw new NotFoundError("Session not found");
  }

  if (existing.status !== "ACTIVE") {
    return {
      sessionId: existing.sessionId,
      status: existing.status,
      alreadyRevoked: true,
    };
  }

  const now = new Date();
  await runWithOptionalTransaction(async (txSession) => {
    const sessionOpt = txSession ? { session: txSession } : {};
    await Session.updateOne(
      { _id: existing._id, user: userId, status: "ACTIVE" },
      {
        $set: {
          status: "REVOKED",
          revokedAt: now,
          revokedReason: "device_logout",
        },
      },
      sessionOpt,
    );

    await RefreshToken.updateMany(
      {
        user: userId,
        $or: [{ sessionId: sid }, { familyId: existing.familyId }],
        status: { $ne: "revoked" },
      },
      {
        $set: {
          status: "revoked",
          isRevoked: true,
          revokedAt: now,
          revokedReason: "device_logout",
        },
      },
      sessionOpt,
    );
  });

  const isCurrent = Boolean(currentSessionId && currentSessionId === sid);

  await revokeSession(
    userId,
    sid,
    isCurrent ? currentJti : undefined,
    "device_logout",
    isCurrent ? currentTokenExp : undefined,
  );

  logSecurityAudit({
    eventType: "DEVICE_LOGOUT",
    userId,
    sessionId: sid,
    requestId,
    success: true,
    reasonCode: "SPECIFIC_DEVICE_REVOKED",
    metadata: { revokedSelf: isCurrent },
  });

  return {
    sessionId: sid,
    status: "REVOKED" as const,
    alreadyRevoked: false,
  };
};

/* =====================================================
   FIREBASE TOKEN VERIFICATION 
===================================================== */
const FIREBASE_AUTH_ERROR_CODES = new Set([
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/user-disabled",
  "auth/argument-error",
  "auth/invalid-id-token",
  "auth/user-not-found",
]);

const FIREBASE_INFRA_ERROR_CODES = new Set([
  "app/invalid-credential",
  "auth/internal-error",
  "auth/project-not-found",
  "app/network-error",
  "app/network-timeout",
]);

export const verifyFirebaseToken = async (
  idToken: string,
  expectedProvider: SocialProvider,
  fullName?: string,
): Promise<SocialProfile> => {
  if (typeof idToken !== "string" || !idToken) {
    throw new BadRequestError("ID token is required");
  }

  const firebaseAuth = getFirebaseAuth();

  let decoded: DecodedIdToken;

  try {
    decoded = await firebaseAuth.verifyIdToken(idToken, true);
  } catch (err: unknown) {
    const errObj = err as { code?: string; message?: string } | null;
    const code = typeof errObj?.code === "string" ? errObj.code : "unknown";

    if (
      FIREBASE_INFRA_ERROR_CODES.has(code) ||
      /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch/i.test(
        errObj?.message || "",
      )
    ) {
      logger.error("Firebase verification infrastructure failure", { code });
      throw new ExternalServiceError(
        "Authentication provider temporarily unavailable",
        503,
      );
    }

    logSecurityAudit({
      eventType: "LOGIN_FAILURE",
      success: false,
      reasonCode: FIREBASE_AUTH_ERROR_CODES.has(code)
        ? code
        : "FIREBASE_TOKEN_INVALID",
      metadata: { provider: expectedProvider },
    });

    throw new UnauthorizedError("Invalid or revoked token");
  }

  const expectedIssuer = `https://securetoken.google.com/${serverConfig.FIREBASE_PROJECT_ID}`;
  if (
    !decoded.uid ||
    decoded.aud !== serverConfig.FIREBASE_PROJECT_ID ||
    decoded.iss !== expectedIssuer
  ) {
    logSecurityAudit({
      eventType: "SUSPICIOUS_AUTHENTICATION",
      success: false,
      reasonCode: "FIREBASE_CLAIMS_MISMATCH",
      metadata: { provider: expectedProvider },
    });
    throw new UnauthorizedError("Invalid token claims");
  }

  const firebaseProvider = decoded.firebase?.sign_in_provider;
  const expected = expectedProvider === "google" ? "google.com" : "apple.com";

  if (firebaseProvider !== expected) {
    logSecurityAudit({
      eventType: "SUSPICIOUS_AUTHENTICATION",
      success: false,
      reasonCode: "FIREBASE_PROVIDER_MISMATCH",
      metadata: { expectedProvider },
    });
    throw new UnauthorizedError("Token provider mismatch");
  }

  const identityIds = decoded.firebase?.identities?.[expected] as
    | string[]
    | undefined;

  const providerId = identityIds?.[0] ?? decoded.uid;

  return {
    provider: expectedProvider,
    providerId: String(providerId),
    email: decoded.email?.trim().toLowerCase(),
    emailVerified: decoded.email_verified === true,
    name: decoded.name || fullName?.trim() || undefined,
    picture: decoded.picture,
  };
};

/* =====================================================
   SOCIAL LOGIN VALIDATION
===================================================== */
const assertUserAllowed = (user: IUser, expectedRole: SocialRole): void => {
  if (user.role !== expectedRole) {
    throw new ForbiddenError("Please use the correct login for your account");
  }

  if (!user.isActive) {
    throw new ForbiddenError("Your account is deactivated");
  }
};

/* =====================================================
   COMMON SOCIAL LOGIN
===================================================== */
const socialLogin = async (
  profile: SocialProfile,
  expectedRole: SocialRole,
  metadata?: SessionClientMetadata,
): Promise<AuthResult> => {
  const normalizedEmail = profile.email?.trim().toLowerCase();

  let user = await User.findOne({
    authProvider: profile.provider,
    providerId: profile.providerId,
  });

  if (user) {
    assertUserAllowed(user as IUser, expectedRole);
  } else {
    const existingEmailUser =
      normalizedEmail && profile.emailVerified
        ? await User.findOne({
            email: normalizedEmail,
          })
        : null;

    if (existingEmailUser) {
      assertUserAllowed(existingEmailUser as IUser, expectedRole);

      const canLink =
        existingEmailUser.authProvider === profile.provider &&
        !existingEmailUser.providerId;

      if (!canLink) {
        throw new ConflictError(
          "An account already exists with this email. Please use your registered login method.",
        );
      }

      try {
        user = await User.findOneAndUpdate(
          {
            _id: existingEmailUser._id,
            authProvider: profile.provider,
            providerId: { $exists: false },
          },
          {
            $set: {
              providerId: profile.providerId,
              isVerified: true,

              ...(existingEmailUser.profileImage || !profile.picture
                ? {}
                : {
                    profileImage: profile.picture,
                  }),
            },
          },
          {
            new: true,
            runValidators: true,
          },
        );

        if (!user) {
          user = await User.findOneAndUpdate(
            {
              _id: existingEmailUser._id,
              authProvider: profile.provider,
              providerId: null,
            },
            {
              $set: {
                providerId: profile.providerId,
                isVerified: true,

                ...(existingEmailUser.profileImage || !profile.picture
                  ? {}
                  : {
                      profileImage: profile.picture,
                    }),
              },
            },
            {
              new: true,
              runValidators: true,
            },
          );
        }
      } catch (error: unknown) {
        throw toDuplicateKeyError(
          error,
          "This social account is already linked to another user.",
        );
      }

      if (!user) {
        throw new ConflictError(
          "Account is already linked. Please try logging in again.",
        );
      }
    } else {
      if (!normalizedEmail || !profile.emailVerified) {
        throw new BadRequestError(
          "A verified email address is required to create an account.",
        );
      }

      try {
        user = await User.create({
          name: profile.name?.trim() || normalizedEmail.split("@")[0],
          email: normalizedEmail,
          authProvider: profile.provider,
          providerId: profile.providerId,
          profileImage: profile.picture,
          isVerified: true,

          role: expectedRole,
        });
      } catch (error: unknown) {
        throw toDuplicateKeyError(
          error,
          "An account already exists with this email or social provider.",
        );
      }
    }
  }

  if (expectedRole === "student") {
    await Student.updateOne(
      { user: user._id },
      {
        $setOnInsert: {
          user: user._id,
          rollNumber: "",
          course: "",
          semester: "",
          deliveryAddresses: [],
          isActive: true,
        },
      },
      { upsert: true },
    );
  }

  const authResult = await buildAuthResult(user as IUser, metadata);

  logSecurityAudit({
    eventType: "LOGIN_SUCCESS",
    userId: user._id.toString(),
    success: true,
    reasonCode: `SOCIAL_${profile.provider.toUpperCase()}_LOGIN`,
    metadata: { role: expectedRole },
  });
  logger.info("Social login completed", {
    userId: user._id.toString(),
    role: expectedRole,
    provider: profile.provider,
    operation: "SOCIAL_LOGIN",
  });

  if (expectedRole === "cafeOwner") {
    const cafe = await Cafe.findOne({
      owner: user._id,
    }).select("isApproved approvalStatus");

    return {
      ...authResult,
      isApproved: cafe?.isApproved ?? false,
      approvalStatus: cafe ? cafe.approvalStatus : "not_registered",
    };
  }

  return authResult;
};

/* =====================================================
   STUDENT GOOGLE LOGIN
===================================================== */

export const googleStudentLoginService = async (
  idToken: string,
  metadata?: SessionClientMetadata,
): Promise<AuthResult> => {
  const profile = await verifyFirebaseToken(idToken, "google");

  return socialLogin(profile, "student", metadata);
};

/* =====================================================
   STUDENT APPLE LOGIN
===================================================== */

export const appleStudentLoginService = async (
  identityToken: string,
  fullName?: string,
  metadata?: SessionClientMetadata,
): Promise<AuthResult> => {
  const profile = await verifyFirebaseToken(identityToken, "apple", fullName);

  return socialLogin(profile, "student", metadata);
};

/* =====================================================
   CAFE OWNER GOOGLE LOGIN
===================================================== */

export const googleCafeOwnerLoginService = async (
  idToken: string,
  metadata?: SessionClientMetadata,
): Promise<AuthResult> => {
  const profile = await verifyFirebaseToken(idToken, "google");

  return socialLogin(profile, "cafeOwner", metadata);
};

/* =====================================================
   CAFE OWNER APPLE LOGIN
===================================================== */
export const appleCafeOwnerLoginService = async (
  identityToken: string,
  fullName?: string,
  metadata?: SessionClientMetadata,
): Promise<AuthResult> => {
  const profile = await verifyFirebaseToken(identityToken, "apple", fullName);

  return socialLogin(profile, "cafeOwner", metadata);
};
