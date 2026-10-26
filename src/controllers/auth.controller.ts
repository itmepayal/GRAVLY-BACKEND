import { Request, Response } from "express";

import {
  adminRegisterService,
  adminLoginService,
  refreshTokenService,
  logoutService,
  googleStudentLoginService,
  appleStudentLoginService,
  googleCafeOwnerLoginService,
  appleCafeOwnerLoginService,
} from "../service/auth.service.js";

import { BadRequestError } from "../utils/errors/app.error.js";

/* =====================================================
   TYPES
===================================================== */

interface ControllerError {
  message?: string;
  status?: number;
  statusCode?: number;
}

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
}

/* =====================================================
   COMMON ERROR HANDLER
===================================================== */
const sendError = (
  res: Response,
  error: unknown,
  fallbackMessage: string,
): void => {
  const err = error as ControllerError;

  const statusCode =
    typeof err?.statusCode === "number"
      ? err.statusCode
      : typeof err?.status === "number"
        ? err.status
        : 500;

  if (statusCode >= 400 && statusCode < 600 && err?.message) {
    res.status(statusCode).json({
      success: false,
      message: err.message,
    });

    return;
  }

  console.error(fallbackMessage, error);

  res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
};

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
): Promise<void> => {
  try {
    const idToken = validateString(req.body?.idToken, "Google ID token");

    const result = await googleStudentLoginService(idToken);

    sendAuthSuccess(res, "Google login successful", result);
  } catch (error: unknown) {
    sendError(res, error, "Something went wrong during Google login");
  }
};

/* =====================================================
   STUDENT APPLE LOGIN
   POST /api/v1/auth/apple
===================================================== */

export const appleLogin = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const identityToken = validateString(
      req.body?.identityToken,
      "Apple identity token",
    );

    const fullName = validateOptionalFullName(req.body?.fullName);

    const result = await appleStudentLoginService(identityToken, fullName);

    sendAuthSuccess(res, "Apple login successful", result);
  } catch (error: unknown) {
    sendError(res, error, "Something went wrong during Apple login");
  }
};

/* =====================================================
   CAFE OWNER GOOGLE LOGIN / SIGNUP
   POST /api/v1/auth/cafe-owner/google
===================================================== */

export const cafeOwnerGoogleLogin = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const idToken = validateString(req.body?.idToken, "Google ID token");

    const result = await googleCafeOwnerLoginService(idToken);

    sendAuthSuccess(res, "Cafe Owner Google authentication successful", result);
  } catch (error: unknown) {
    sendError(
      res,
      error,
      "Something went wrong during Cafe Owner Google authentication",
    );
  }
};

/* =====================================================
   CAFE OWNER APPLE LOGIN / SIGNUP
   POST /api/v1/auth/cafe-owner/apple
===================================================== */

export const cafeOwnerAppleLogin = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const identityToken = validateString(
      req.body?.identityToken,
      "Apple identity token",
    );

    const fullName = validateOptionalFullName(req.body?.fullName);

    const result = await appleCafeOwnerLoginService(identityToken, fullName);

    sendAuthSuccess(res, "Cafe Owner Apple authentication successful", result);
  } catch (error: unknown) {
    sendError(
      res,
      error,
      "Something went wrong during Cafe Owner Apple authentication",
    );
  }
};

/* =====================================================
   ADMIN REGISTER
   POST /api/v1/auth/admin/register
===================================================== */

export const adminRegister = async (
  req: Request,
  res: Response,
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

    const result = await adminRegisterService(name, email, password, secret);

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
    sendError(res, error, "Something went wrong during admin registration");
  }
};

/* =====================================================
   ADMIN LOGIN
   POST /api/v1/auth/admin/login
===================================================== */

export const adminLogin = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const email = validateString(req.body?.email, "Email");
    const password = req.body?.password;

    if (typeof password !== "string" || !password) {
      throw new BadRequestError("Password is required");
    }

    const result = await adminLoginService(email, password);

    sendAuthSuccess(res, "Admin login successful", result);
  } catch (error: unknown) {
    sendError(res, error, "Something went wrong during admin login");
  }
};

/* =====================================================
   REFRESH ACCESS TOKEN
   POST /api/v1/auth/refresh-token
===================================================== */

export const refreshAccessToken = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const refreshToken = validateString(
      req.body?.refreshToken,
      "Refresh token",
    );

    const result = await refreshTokenService(refreshToken);

    sendAuthSuccess(res, "Token refreshed successfully", result);
  } catch (error: unknown) {
    sendError(res, error, "Unable to refresh token");
  }
};

/* =====================================================
   LOGOUT
   POST /api/v1/auth/logout
===================================================== */

export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    const refreshToken = validateString(
      req.body?.refreshToken,
      "Refresh token",
    );

    await logoutService(refreshToken);

    res.status(200).json({
      success: true,
      message: "Logout successful",
    });
  } catch (error: unknown) {
    sendError(res, error, "Something went wrong during logout");
  }
};
