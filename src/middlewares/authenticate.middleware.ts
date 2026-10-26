import { Request, Response, NextFunction, RequestHandler } from "express";

import { User, IUser, UserRole } from "../models/user.model.js";
import { verifyAccessToken } from "../utils/jwt/jwt.js";

export const ROLE_RANK: Record<UserRole, number> = {
  student: 1,
  cafeOwner: 2,
  admin: 3,
};

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      targetUser?: IUser;
    }
  }
}

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

  try {
    const decoded = verifyAccessToken(token);

    const user = await User.findById(decoded.id);

    if (!user || !user.isActive) {
      res.status(401).json({
        success: false,
        message: "Unauthorized. User not found or account deactivated.",
      });
      return;
    }

    // Attach authenticated user to the request.
    req.user = user;

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: "Invalid or expired access token",
    });
  }
};

/**
 * Authorize users by role.
 *
 * Example:
 * router.get("/admin/dashboard", authenticate, authorize("admin", "superAdmin"), handler);
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
 *
 * Example:
 * router.patch(
 *   "/users/:id",
 *   authenticate,
 *   authorize("admin", "superAdmin"),
 *   requireHigherRank,
 *   updateUser,
 * );
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

    const targetId = req.params.id;

    if (!targetId) {
      res.status(400).json({
        success: false,
        message: "Target user ID is required",
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
    console.error("requireHigherRank error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to verify user permissions",
    });
  }
};
