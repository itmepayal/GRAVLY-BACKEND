import { Request, Response, NextFunction } from "express";

import {
  adminRegisterService,
  adminLoginService,
  refreshTokenService,
  logoutService,
  logoutAllService,
  listActiveSessionsService,
  getCurrentSessionService,
  revokeDeviceSessionService,
  googleStudentLoginService,
  appleStudentLoginService,
  googleCafeOwnerLoginService,
  appleCafeOwnerLoginService,
} from "../service/auth.service.js";

import { BadRequestError } from "../utils/errors/app.error.js";
import { extractClientMetadata } from "../utils/session/device.util.js";

/* =====================================================
   TYPES
===================================================== */
interface AuthenticatedUser {
  _id: unknown;
  name: string;
  email: string;
  role: string;
  profileImage?: string;
  authProvider: string;
}

interface AuthResult {
  user: AuthenticatedUser;
  token: string;
  refreshToken: string;
  isApproved?: boolean;
  approvalStatus?: string;
}

/* =====================================================
   VALIDATION HELPERS
===================================================== */

const validateString = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${fieldName} is required`);
  }

  return value.trim();
};

/* =====================================================
   SAFE USER RESPONSE
===================================================== */

const getUserResponse = (user: AuthenticatedUser) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  role: user.role,
  profileImage: user.profileImage ?? null,
  authProvider: user.authProvider,
});

/* =====================================================
   COMMON AUTH SUCCESS RESPONSE
===================================================== */

const sendAuthSuccess = (
  res: Response,
  message: string,
  result: AuthResult,
): void => {
  res.status(200).json({
    success: true,
    message,
    data: {
      accessToken: result.token,
      refreshToken: result.refreshToken,
      tokenType: "Bearer",
      ...(result.isApproved !== undefined && { isApproved: result.isApproved }),
      ...(result.approvalStatus !== undefined && {
        approvalStatus: result.approvalStatus,
      }),
      user: getUserResponse(result.user),
    },
  });
};

/* =====================================================
   APPLE NAME VALIDATION
===================================================== */

const validateOptionalFullName = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length > 200) {
    throw new BadRequestError("Invalid fullName");
  }

  return value.trim() || undefined;
};

/* =====================================================
   STUDENT GOOGLE LOGIN
   POST /api/v1/auth/google
===================================================== */

export const googleLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const idToken = validateString(req.body?.idToken, "Google ID token");

    const result = await googleStudentLoginService(
      idToken,
      extractClientMetadata(req),
    );

    sendAuthSuccess(res, "Google login successful", result);
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   STUDENT APPLE LOGIN
   POST /api/v1/auth/apple
===================================================== */

export const appleLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const identityToken = validateString(
      req.body?.identityToken,
      "Apple identity token",
    );

    const fullName = validateOptionalFullName(req.body?.fullName);

    const result = await appleStudentLoginService(
      identityToken,
      fullName,
      extractClientMetadata(req),
    );

    sendAuthSuccess(res, "Apple login successful", result);
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   CAFE OWNER GOOGLE LOGIN / SIGNUP
   POST /api/v1/auth/cafe-owner/google
===================================================== */

export const cafeOwnerGoogleLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const idToken = validateString(req.body?.idToken, "Google ID token");

    const result = await googleCafeOwnerLoginService(
      idToken,
      extractClientMetadata(req),
    );

    sendAuthSuccess(res, "Cafe Owner Google authentication successful", result);
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   CAFE OWNER APPLE LOGIN / SIGNUP
   POST /api/v1/auth/cafe-owner/apple
===================================================== */

export const cafeOwnerAppleLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const identityToken = validateString(
      req.body?.identityToken,
      "Apple identity token",
    );

    const fullName = validateOptionalFullName(req.body?.fullName);

    const result = await appleCafeOwnerLoginService(
      identityToken,
      fullName,
      extractClientMetadata(req),
    );

    sendAuthSuccess(res, "Cafe Owner Apple authentication successful", result);
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   ADMIN REGISTER
   POST /api/v1/auth/admin/register
===================================================== */

export const adminRegister = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const name = validateString(req.body?.name, "Name");
    const email = validateString(req.body?.email, "Email");
    const password = req.body?.password;

    if (typeof password !== "string" || !password) {
      throw new BadRequestError("Password is required");
    }

    const secret = validateString(
      req.body?.secret,
      "Admin registration secret",
    );

    const result = await adminRegisterService(
      name,
      email,
      password,
      secret,
      extractClientMetadata(req),
    );

    res.status(201).json({
      success: true,
      message: "Admin registered successfully",
      data: {
        accessToken: result.token,
        refreshToken: result.refreshToken,
        tokenType: "Bearer",
        user: getUserResponse(result.user),
      },
    });
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   ADMIN LOGIN
   POST /api/v1/auth/admin/login
===================================================== */

export const adminLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const email = validateString(req.body?.email, "Email");
    const password = req.body?.password;

    if (typeof password !== "string" || !password) {
      throw new BadRequestError("Password is required");
    }

    const result = await adminLoginService(
      email,
      password,
      extractClientMetadata(req),
    );

    sendAuthSuccess(res, "Admin login successful", result);
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   REFRESH ACCESS TOKEN
   POST /api/v1/auth/refresh-token
===================================================== */

export const refreshAccessToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const refreshToken = validateString(
      req.body?.refreshToken,
      "Refresh token",
    );

    const result = await refreshTokenService(refreshToken);

    sendAuthSuccess(res, "Token refreshed successfully", result);
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   LOGOUT
   POST /api/v1/auth/logout
===================================================== */

export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const refreshToken = validateString(
      req.body?.refreshToken,
      "Refresh token",
    );

    await logoutService(refreshToken, req.user?._id, req.auth);

    res.status(200).json({
      success: true,
      message: "Logout successful",
    });
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   LOGOUT ALL SESSIONS
   POST /api/v1/auth/logout-all
===================================================== */

export const logoutAll = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const requestId = (req as Request & { requestId?: string }).requestId;
    const data = await logoutAllService(req.user?._id, requestId);

    res.status(200).json({
      success: true,
      message: "All sessions revoked successfully",
      data,
    });
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   LIST ACTIVE SESSIONS
   GET /api/v1/auth/sessions
===================================================== */

export const listActiveSessions = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const requestId = (req as Request & { requestId?: string }).requestId;
    const data = await listActiveSessionsService(
      String(req.user?._id),
      req.auth?.sid,
      req.query as Record<string, unknown>,
      requestId,
    );

    res.status(200).json({
      success: true,
      message: "Active sessions fetched successfully",
      data,
    });
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   GET CURRENT SESSION
   GET /api/v1/auth/sessions/current
===================================================== */

export const getCurrentSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await getCurrentSessionService(
      String(req.user?._id),
      req.auth?.sid,
    );

    res.status(200).json({
      success: true,
      message: "Current session fetched successfully",
      data,
    });
  } catch (error: unknown) {
    next(error);
  }
};

/* =====================================================
   REVOKE SPECIFIC DEVICE SESSION
   DELETE /api/v1/auth/sessions/:sessionId
===================================================== */

export const revokeDeviceSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const requestId = (req as Request & { requestId?: string }).requestId;
    const sessionId = validateString(req.params?.sessionId, "Session ID");

    const data = await revokeDeviceSessionService(
      String(req.user?._id),
      sessionId,
      req.auth?.sid,
      req.auth?.jti,
      requestId,
      req.auth?.exp,
    );

    res.status(200).json({
      success: true,
      message: data.alreadyRevoked
        ? "Session already revoked"
        : "Device session revoked successfully",
      data,
    });
  } catch (error: unknown) {
    next(error);
  }
};
