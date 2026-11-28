import crypto from "crypto";
import jwt, { SignOptions } from "jsonwebtoken";
import type { UserRole } from "../../models/user.model.js";
import { serverConfig } from "../../config/index.js";

export type Role = UserRole;

export interface AuthPayload {
  id: string;
  role: Role;
  tokenVersion?: number;
  sessionId?: string;
  familyId?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessJti: string;
  refreshJti: string;
  sessionId: string;
  familyId: string;
}

export interface VerifiedTokenPayload extends AuthPayload {
  tokenType: "access" | "refresh";
  jti: string;
  sub?: string;
  iss?: string;
  aud?: string;
  sid?: string;
  fid?: string;
  tv?: number;
  iat?: number;
  exp?: number;
}

// =========================================================
// GENERATE ACCESS TOKEN
// =========================================================
export const signAccessToken = (
  payload: AuthPayload,
  jti = crypto.randomUUID(),
): string => {
  return jwt.sign(
    {
      id: payload.id,
      role: payload.role,
      tokenType: "access",
      jti,
      ...(payload.sessionId ? { sid: payload.sessionId } : {}),
      tv: payload.tokenVersion ?? 0,
    },
    serverConfig.JWT_ACCESS_SECRET,
    {
      expiresIn: serverConfig.JWT_ACCESS_EXPIRES as SignOptions["expiresIn"],
      issuer: serverConfig.JWT_ISSUER,
      audience: serverConfig.JWT_AUDIENCE,
      subject: payload.id,
    },
  );
};

// =========================================================
// GENERATE REFRESH TOKEN
// =========================================================
export const signRefreshToken = (
  payload: AuthPayload,
  jti = crypto.randomUUID(),
): string => {
  return jwt.sign(
    {
      id: payload.id,
      role: payload.role,
      tokenType: "refresh",
      jti,
      ...(payload.sessionId ? { sid: payload.sessionId } : {}),
      ...(payload.familyId ? { fid: payload.familyId } : {}),
      tv: payload.tokenVersion ?? 0,
    },
    serverConfig.JWT_REFRESH_SECRET,
    {
      expiresIn: serverConfig.JWT_REFRESH_EXPIRES as SignOptions["expiresIn"],
      issuer: serverConfig.JWT_ISSUER,
      audience: serverConfig.JWT_AUDIENCE,
      subject: payload.id,
    },
  );
};

// =========================================================
// GENERATE BOTH TOKENS
// =========================================================
export const generateTokens = (payload: AuthPayload): TokenPair => {
  const sessionId = payload.sessionId || crypto.randomUUID();
  const familyId = payload.familyId || crypto.randomUUID();
  const accessJti = crypto.randomUUID();
  const refreshJti = crypto.randomUUID();

  const scopedPayload: AuthPayload = {
    ...payload,
    sessionId,
    familyId,
  };

  const accessToken = signAccessToken(scopedPayload, accessJti);
  const refreshToken = signRefreshToken(scopedPayload, refreshJti);

  return {
    accessToken,
    refreshToken,
    accessJti,
    refreshJti,
    sessionId,
    familyId,
  };
};

// =========================================================
// VERIFY ACCESS TOKEN
// =========================================================
export const verifyAccessToken = (token: string): VerifiedTokenPayload => {
  const decoded = jwt.verify(token, serverConfig.JWT_ACCESS_SECRET, {
    algorithms: ["HS256"],
    issuer: serverConfig.JWT_ISSUER,
    audience: serverConfig.JWT_AUDIENCE,
    clockTolerance: 5,
  }) as VerifiedTokenPayload;

  if (
    decoded.tokenType !== "access" ||
    !decoded.jti ||
    typeof decoded.jti !== "string" ||
    !decoded.id ||
    decoded.sub !== decoded.id
  ) {
    throw new Error("Invalid access token claims");
  }

  return decoded;
};

// =========================================================
// VERIFY REFRESH TOKEN
// =========================================================
export const verifyRefreshToken = (token: string): VerifiedTokenPayload => {
  const decoded = jwt.verify(token, serverConfig.JWT_REFRESH_SECRET, {
    algorithms: ["HS256"],
    issuer: serverConfig.JWT_ISSUER,
    audience: serverConfig.JWT_AUDIENCE,
    clockTolerance: 5,
  }) as VerifiedTokenPayload;

  if (
    decoded.tokenType !== "refresh" ||
    !decoded.jti ||
    typeof decoded.jti !== "string" ||
    !decoded.id ||
    decoded.sub !== decoded.id
  ) {
    throw new Error("Invalid refresh token claims");
  }

  return decoded;
};
