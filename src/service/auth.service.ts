import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { User, IUser } from "../models/user.model.js";
import { Student } from "../models/student.model.js";
import { RefreshToken } from "../models/refreshToken.model.js";

import {
  generateTokens,
  verifyRefreshToken,
  TokenPair,
} from "../utils/jwt/jwt.js";

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalServerError,
  UnauthorizedError,
} from "../utils/errors/app.error.js";

import { serverConfig } from "../config/index.js";

/* =====================================================
   GOOGLE & APPLE CONFIGURATION
===================================================== */

const googleClient = new OAuth2Client();

const APPLE_JWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
);

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
}

/* =====================================================
   ADMIN LOGIN TIMING PROTECTION
===================================================== */

const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing-protection", 12);

/* =====================================================
   COMMON HELPERS
===================================================== */

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
};

const parseIds = (
  value: string | undefined,
  errorMessage: string,
): string[] => {
  const ids = (value || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new InternalServerError(errorMessage);
  }

  return ids;
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

const issueTokens = async (user: IUser): Promise<TokenPair> => {
  const tokens = generateTokens({
    id: user._id.toString(),
    role: user.role,
  });

  const decoded = jwt.decode(tokens.refreshToken) as { exp?: number } | null;

  if (!decoded?.exp) {
    throw new InternalServerError("Failed to issue refresh token");
  }

  await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(tokens.refreshToken),
    expiresAt: new Date(decoded.exp * 1000),
  });

  return tokens;
};

const buildAuthResult = async (user: IUser): Promise<AuthResult> => {
  const { accessToken, refreshToken } = await issueTokens(user);

  return {
    user,
    token: accessToken,
    refreshToken,
  };
};

/* =====================================================
   ADMIN REGISTER
===================================================== */

export const adminRegisterService = async (
  name: string,
  email: string,
  password: string,
  secret: string,
): Promise<AuthResult> => {
  const expectedSecret = process.env.ADMIN_REGISTER_SECRET;

  if (!expectedSecret) {
    throw new InternalServerError("Admin registration not configured");
  }

  if (
    typeof secret !== "string" ||
    !secret ||
    !safeEqual(secret, expectedSecret)
  ) {
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

  if (typeof password !== "string" || password.length < 8) {
    throw new BadRequestError("Password must be at least 8 characters");
  }

  const existingUser = await User.findOne({
    email: normalizedEmail,
  });

  if (existingUser) {
    throw new ConflictError("An account already exists with this email");
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  let user: IUser;

  try {
    user = (await User.create({
      name: normalizedName,
      email: normalizedEmail,
      password: hashedPassword,
      authProvider: "password",
      role: "admin",
      isVerified: true,
    })) as IUser;
  } catch (error: unknown) {
    throw toDuplicateKeyError(
      error,
      "An account already exists with this email",
    );
  }

  return buildAuthResult(user);
};

/* =====================================================
   ADMIN LOGIN
===================================================== */

export const adminLoginService = async (
  email: string,
  password: string,
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

  const hashToCompare = user?.password ?? DUMMY_HASH;

  const passwordMatches = await bcrypt.compare(password, hashToCompare);

  if (
    !user ||
    user.role !== "admin" ||
    user.authProvider !== "password" ||
    !user.password ||
    !passwordMatches
  ) {
    throw new UnauthorizedError("Invalid email or password");
  }

  if (!user.isActive) {
    throw new ForbiddenError("Your account is deactivated");
  }

  return buildAuthResult(user as IUser);
};

/* =====================================================
   REFRESH TOKEN
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

  const stored = await RefreshToken.findOneAndDelete({
    tokenHash: hashToken(refreshToken),
  });

  if (!stored) {
    await RefreshToken.deleteMany({
      user: decoded.id,
    });

    throw new UnauthorizedError(
      "Refresh token is no longer valid. Please log in again.",
    );
  }

  const user = await User.findById(decoded.id);

  if (!user) {
    await RefreshToken.deleteMany({
      user: decoded.id,
    });

    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  if (!user.isActive) {
    await RefreshToken.deleteMany({
      user: user._id,
    });

    throw new ForbiddenError("Your account is deactivated");
  }

  return buildAuthResult(user as IUser);
};

/* =====================================================
   LOGOUT
===================================================== */

export const logoutService = async (refreshToken: string): Promise<void> => {
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new BadRequestError("Refresh token is required");
  }

  await RefreshToken.deleteOne({
    tokenHash: hashToken(refreshToken),
  });
};

/* =====================================================
   GOOGLE TOKEN VERIFICATION
===================================================== */

const verifyGoogleToken = async (idToken: string): Promise<SocialProfile> => {
  if (typeof idToken !== "string" || !idToken) {
    throw new BadRequestError("Google ID token is required");
  }

  const audiences = parseIds(
    serverConfig.GOOGLE_CLIENT_ID,
    "Google login not configured",
  );

  let payload;

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: audiences,
    });

    payload = ticket.getPayload();
  } catch {
    throw new UnauthorizedError("Invalid Google token");
  }

  if (!payload?.sub || !payload.email || !payload.email_verified) {
    throw new UnauthorizedError("Invalid Google account");
  }

  return {
    provider: "google",
    providerId: payload.sub,
    email: payload.email.trim().toLowerCase(),
    emailVerified: true,
    name: payload.name,
    picture: payload.picture,
  };
};

/* =====================================================
   APPLE TOKEN VERIFICATION
===================================================== */

const verifyAppleToken = async (
  identityToken: string,
  fullName?: string,
): Promise<SocialProfile> => {
  if (typeof identityToken !== "string" || !identityToken) {
    throw new BadRequestError("Apple identity token is required");
  }

  const audiences = parseIds(
    serverConfig.APPLE_CLIENT_ID,
    "Apple login not configured",
  );

  let payload;

  try {
    ({ payload } = await jwtVerify(identityToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: audiences,
    }));
  } catch {
    throw new UnauthorizedError("Invalid Apple token");
  }

  if (!payload.sub) {
    throw new UnauthorizedError("Invalid Apple account");
  }

  const email =
    typeof payload.email === "string"
      ? payload.email.trim().toLowerCase()
      : undefined;

  const emailVerified =
    payload.email_verified === true || payload.email_verified === "true";

  return {
    provider: "apple",
    providerId: payload.sub,
    email,
    emailVerified,
    name: fullName?.trim() || undefined,
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
        },
      },
      { upsert: true },
    );
  }

  return buildAuthResult(user as IUser);
};

/* =====================================================
   STUDENT GOOGLE LOGIN
===================================================== */

export const googleStudentLoginService = async (
  idToken: string,
): Promise<AuthResult> => {
  const profile = await verifyGoogleToken(idToken);

  return socialLogin(profile, "student");
};

/* =====================================================
   STUDENT APPLE LOGIN
===================================================== */

export const appleStudentLoginService = async (
  identityToken: string,
  fullName?: string,
): Promise<AuthResult> => {
  const profile = await verifyAppleToken(identityToken, fullName);

  return socialLogin(profile, "student");
};

/* =====================================================
   CAFE OWNER GOOGLE LOGIN
===================================================== */

export const googleCafeOwnerLoginService = async (
  idToken: string,
): Promise<AuthResult> => {
  const profile = await verifyGoogleToken(idToken);

  return socialLogin(profile, "cafeOwner");
};

/* =====================================================
   CAFE OWNER APPLE LOGIN
===================================================== */
export const appleCafeOwnerLoginService = async (
  identityToken: string,
  fullName?: string,
): Promise<AuthResult> => {
  const profile = await verifyAppleToken(identityToken, fullName);

  return socialLogin(profile, "cafeOwner");
};
