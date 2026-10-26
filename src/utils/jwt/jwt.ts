import jwt, { SignOptions } from "jsonwebtoken";
import type { UserRole } from "../../models/user.model";
import { serverConfig } from "../../config";

export type Role = UserRole;

export interface AuthPayload {
  id: string;
  role: Role;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface VerifiedTokenPayload extends AuthPayload {
  tokenType: "access" | "refresh";
}

// =========================================================
// GENERATE ACCESS TOKEN
// =========================================================
export const signAccessToken = (payload: AuthPayload): string => {
  return jwt.sign(
    {
      id: payload.id,
      role: payload.role,
      tokenType: "access",
    },
    serverConfig.JWT_ACCESS_SECRET,
    {
      expiresIn: serverConfig.JWT_ACCESS_EXPIRES as SignOptions["expiresIn"],
    },
  );
};

// =========================================================
// GENERATE REFRESH TOKEN
// =========================================================
export const signRefreshToken = (payload: AuthPayload): string => {
  return jwt.sign(
    {
      id: payload.id,
      role: payload.role,
      tokenType: "refresh",
    },
    serverConfig.JWT_REFRESH_SECRET,
    {
      expiresIn: serverConfig.JWT_REFRESH_EXPIRES as SignOptions["expiresIn"],
    },
  );
};

// =========================================================
// GENERATE BOTH TOKENS
// =========================================================
export const generateTokens = (payload: AuthPayload): TokenPair => {
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  return {
    accessToken,
    refreshToken,
  };
};

// =========================================================
// VERIFY ACCESS TOKEN
// =========================================================
export const verifyAccessToken = (token: string): VerifiedTokenPayload => {
  const decoded = jwt.verify(
    token,
    serverConfig.JWT_ACCESS_SECRET,
  ) as VerifiedTokenPayload;

  if (decoded.tokenType !== "access") {
    throw new Error("Invalid token type: Access token required");
  }

  return decoded;
};

// =========================================================
// VERIFY REFRESH TOKEN
// =========================================================
export const verifyRefreshToken = (token: string): VerifiedTokenPayload => {
  const decoded = jwt.verify(
    token,
    serverConfig.JWT_REFRESH_SECRET,
  ) as VerifiedTokenPayload;

  if (decoded.tokenType !== "refresh") {
    throw new Error("Invalid token type: Refresh token required");
  }

  return decoded;
};
