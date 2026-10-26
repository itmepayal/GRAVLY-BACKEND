import type { Request, Response, NextFunction, RequestHandler } from "express";

import { BadRequestError } from "../utils/errors/app.error.js";

import {
  getDashboardOverviewService,
  getAllUsersService,
  getUserDetailService,
  setUserActiveService,
  getAllOrdersService,
  getOrderDetailService,
  getAllPaymentsService,
  getPaymentDetailService,
  getAdminProfileService,
  updateAdminProfileService,
  changeAdminPasswordService,
} from "../service/admin.service.js";

/* =========================================================
   TYPES
========================================================= */

type AsyncController = (req: Request, res: Response) => Promise<void>;

/* =========================================================
   HELPERS
========================================================= */

/**
 * Get authenticated admin ID from request.
 * Authentication middleware must populate req.user.
 */
const getAdminId = (req: Request): string => {
  const id = req.user?._id;

  if (!id) {
    throw new BadRequestError("Authenticated user ID is missing");
  }

  return String(id);
};

/**
 * Safely execute async controllers and forward errors
 * to the centralized Express error handler.
 */
const asyncHandler = (controller: AsyncController): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    void controller(req, res).catch(next);
  };
};

/**
 * Standard success response.
 */
const sendSuccess = (res: Response, message: string, data?: unknown): void => {
  res.status(200).json({
    success: true,
    message,
    ...(data !== undefined ? { data } : {}),
  });
};

/**
 * Validate a required route parameter.
 */
const getRequiredParam = (req: Request, paramName: string): string => {
  const value = req.params[paramName];

  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${paramName} is required`);
  }

  return value.trim();
};

/**
 * Ensure request body is a JSON object.
 */
const getRequestBody = (req: Request): Record<string, unknown> => {
  const body: unknown = req.body;

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Request body must be a valid JSON object");
  }

  return body as Record<string, unknown>;
};

/* =========================================================
   DASHBOARD
========================================================= */

/**
 * GET /admin/dashboard
 */
export const getDashboardOverview = asyncHandler(async (_req, res) => {
  const dashboard = await getDashboardOverviewService();

  sendSuccess(res, "Dashboard fetched successfully", dashboard);
});

/* =========================================================
   USERS
========================================================= */

/**
 * GET /admin/users
 */
export const getAllUsers = asyncHandler(async (req, res) => {
  const result = await getAllUsersService(req.query);

  sendSuccess(res, "Users fetched successfully", result);
});

/**
 * GET /admin/users/:userId
 */
export const getUserDetail = asyncHandler(async (req, res) => {
  const userId = getRequiredParam(req, "userId");

  const result = await getUserDetailService(userId);

  sendSuccess(res, "User details fetched successfully", result);
});

/**
 * PATCH /admin/users/:userId/status
 *
 * Body:
 * {
 *   "isActive": false
 * }
 */
export const setUserActive = asyncHandler(async (req, res) => {
  const userId = getRequiredParam(req, "userId");

  const body = getRequestBody(req);

  if (typeof body.isActive !== "boolean") {
    throw new BadRequestError("isActive must be a boolean");
  }

  const result = await setUserActiveService(
    userId,
    body.isActive,
    getAdminId(req),
  );

  sendSuccess(
    res,
    body.isActive
      ? "User activated successfully"
      : "User deactivated successfully",
    result,
  );
});

/* =========================================================
   ORDERS
========================================================= */

/**
 * GET /admin/orders
 */
export const getAllOrders = asyncHandler(async (req, res) => {
  const result = await getAllOrdersService(req.query);

  sendSuccess(res, "Orders fetched successfully", result);
});

/**
 * GET /admin/orders/:orderId
 */
export const getOrderDetail = asyncHandler(async (req, res) => {
  const orderId = getRequiredParam(req, "orderId");

  const result = await getOrderDetailService(orderId);

  sendSuccess(res, "Order details fetched successfully", result);
});

/* =========================================================
   PAYMENTS
========================================================= */

/**
 * GET /admin/payments
 */
export const getAllPayments = asyncHandler(async (req, res) => {
  const result = await getAllPaymentsService(req.query);

  sendSuccess(res, "Payments fetched successfully", result);
});

/**
 * GET /admin/payments/:paymentId
 *
 * The service accepts either a MongoDB ObjectId
 * or the payment's business paymentId.
 */
export const getPaymentDetail = asyncHandler(async (req, res) => {
  const paymentId = getRequiredParam(req, "paymentId");

  const result = await getPaymentDetailService(paymentId);

  sendSuccess(res, "Payment details fetched successfully", result);
});

/* =========================================================
   ADMIN PROFILE
========================================================= */

/**
 * GET /admin/profile
 */
export const getAdminProfile = asyncHandler(async (req, res) => {
  const result = await getAdminProfileService(getAdminId(req));

  sendSuccess(res, "Admin profile fetched successfully", result);
});

/**
 * PATCH /admin/profile
 *
 * Body example:
 * {
 *   "name": "Admin User",
 *   "phone": "9876543210",
 *   "profileImage": "https://example.com/profile.jpg"
 * }
 */
export const updateAdminProfile = asyncHandler(async (req, res) => {
  const body = getRequestBody(req);

  const result = await updateAdminProfileService(getAdminId(req), body);

  sendSuccess(res, "Admin profile updated successfully", result);
});

/* =========================================================
   CHANGE ADMIN PASSWORD
========================================================= */

/**
 * PATCH /admin/change-password
 *
 * Body:
 * {
 *   "currentPassword": "OldPassword123",
 *   "newPassword": "NewPassword456"
 * }
 */
export const changeAdminPassword = asyncHandler(async (req, res) => {
  const body = getRequestBody(req);

  const result = await changeAdminPasswordService(getAdminId(req), body);

  sendSuccess(res, result.message);
});
