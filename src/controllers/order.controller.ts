import type { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";

import {
  placeOrderService,
  getMyOrdersService,
  getMyOrderService,
  cancelMyOrderService,
  getCafeOrdersService,
  getCafeOrderService,
  getCafeOrderSummaryService,
  getCafeOrderHistoryService,
  acceptOrderService,
  rejectOrderService,
  updateOrderStatusService,
} from "../service/order.service";

import { BadRequestError } from "../utils/errors/app.error";
import { cafeIdOf } from "../utils/order/requestUser";

/* =====================================================
   HELPERS
===================================================== */

const getUserId = (req: Request): string => {
  const user = req.user;

  if (!user) {
    throw new BadRequestError("Authenticated user is missing");
  }

  const id = user._id;

  if (!id) {
    throw new BadRequestError("Authenticated user ID is missing");
  }

  return String(id);
};

const getCafeId = async (req: Request): Promise<string> => {
  const cafeId = String(await cafeIdOf(req));

  if (!Types.ObjectId.isValid(cafeId)) {
    throw new BadRequestError("Invalid cafe ID");
  }

  return cafeId;
};

const validateObjectId = (id: string, fieldName = "order ID"): void => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError(`Invalid ${fieldName}`);
  }
};

const parsePositiveInteger = (
  value: unknown,
  defaultValue: number,
  maxValue = 50,
): number => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new BadRequestError("Invalid pagination parameter");
  }

  return Math.min(parsed, maxValue);
};

const pagingQuery = (req: Request): Record<string, unknown> => {
  const query: Record<string, unknown> = { ...req.query };

  if (req.query.page !== undefined) {
    query.page = String(
      parsePositiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER),
    );
  }

  if (req.query.limit !== undefined) {
    query.limit = String(parsePositiveInteger(req.query.limit, 10, 50));
  }

  return query;
};

/* =====================================================
   STUDENT: PLACE ORDER
   POST /api/v1/orders
===================================================== */

export const placeOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const studentId = getUserId(req);

    const order = await placeOrderService(studentId);

    res.status(201).json({
      success: true,
      message: "Order placed successfully",
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   STUDENT: GET MY ORDERS
   GET /api/v1/orders
===================================================== */

export const getMyOrders = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const studentId = getUserId(req);

    const data = await getMyOrdersService(studentId, pagingQuery(req));

    res.status(200).json({
      success: true,
      message: "Orders fetched successfully",
      data,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   STUDENT: GET ORDER DETAILS
   GET /api/v1/orders/:orderId
===================================================== */

export const getMyOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const studentId = getUserId(req);
    const orderId = String(req.params.orderId);

    validateObjectId(orderId);

    const order = await getMyOrderService(studentId, orderId);

    res.status(200).json({
      success: true,
      message: "Order details fetched successfully",
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   STUDENT: CANCEL ORDER
   PATCH /api/v1/orders/:orderId/cancel
===================================================== */

export const cancelMyOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const studentId = getUserId(req);
    const orderId = String(req.params.orderId);

    validateObjectId(orderId);

    const order = await cancelMyOrderService(studentId, orderId);

    res.status(200).json({
      success: true,
      message: "Order cancelled successfully",
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   CAFE OWNER: GET CAFE ORDERS
   GET /api/v1/orders/cafe
===================================================== */
export const getCafeOrders = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const cafeId = await getCafeId(req);

    const data = await getCafeOrdersService(cafeId, pagingQuery(req));

    res.status(200).json({
      success: true,
      message: "Cafe orders fetched successfully",
      data,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   CAFE OWNER: HOME SUMMARY
   GET /api/v1/orders/cafe/summary
===================================================== */
export const getCafeOrderSummary = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const cafeId = await getCafeId(req);

    const data = await getCafeOrderSummaryService(cafeId);

    res.status(200).json({
      success: true,
      message: "Summary fetched successfully",
      data,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   CAFE OWNER: TRANSACTION HISTORY
   GET /api/v1/orders/cafe/history
===================================================== */
export const getCafeOrderHistory = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const cafeId = await getCafeId(req);

    const data = await getCafeOrderHistoryService(cafeId, pagingQuery(req));

    res.status(200).json({
      success: true,
      message: "Transaction history fetched successfully",
      data,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   CAFE OWNER: ORDER DETAILS
   GET /api/v1/orders/cafe/:orderId
===================================================== */
export const getCafeOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const cafeId = await getCafeId(req);
    const orderId = String(req.params.orderId);

    validateObjectId(orderId);

    const order = await getCafeOrderService(cafeId, orderId);

    res.status(200).json({
      success: true,
      message: "Order details fetched successfully",
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   CAFE OWNER: ACCEPT ORDER
   PATCH /api/v1/orders/cafe/:orderId/accept
===================================================== */
export const acceptOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const cafeId = await getCafeId(req);
    const orderId = String(req.params.orderId);

    validateObjectId(orderId);

    const order = await acceptOrderService(cafeId, orderId);

    res.status(200).json({
      success: true,
      message: "Order accepted successfully",
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   CAFE OWNER: REJECT ORDER
   PATCH /api/v1/orders/cafe/:orderId/reject
===================================================== */
export const rejectOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const cafeId = await getCafeId(req);
    const orderId = String(req.params.orderId);

    validateObjectId(orderId);

    const order = await rejectOrderService(cafeId, orderId, req.body);

    res.status(200).json({
      success: true,
      message: "Order rejected successfully",
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   CAFE OWNER: UPDATE ORDER STATUS
   PATCH /api/v1/orders/cafe/:orderId/status
===================================================== */
export const updateOrderStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const cafeId = await getCafeId(req);
    const orderId = String(req.params.orderId);

    validateObjectId(orderId);

    const order = await updateOrderStatusService(cafeId, orderId, req.body);

    res.status(200).json({
      success: true,
      message: "Order status updated successfully",
      data: order,
    });
  } catch (error) {
    next(error);
  }
};
