import type { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";

import {
  initiatePaymentService,
  getPaymentStatusService,
  handleCashfreeWebhookService,
} from "../service/payment.service";

import { BadRequestError } from "../utils/errors/app.error";

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

const validateObjectId = (id: string, fieldName = "order ID"): void => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError(`Invalid ${fieldName}`);
  }
};

const headerValue = (req: Request, name: string): string => {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
};

/* =====================================================
   STUDENT: START ONLINE PAYMENT
   POST /api/v1/payments/initiate
===================================================== */

export const initiatePayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const studentId = getUserId(req);

    const orderId =
      typeof req.body?.orderId === "string" ? req.body.orderId.trim() : "";

    if (!orderId) {
      throw new BadRequestError("orderId is required");
    }

    validateObjectId(orderId);

    const data = await initiatePaymentService(studentId, orderId);

    res.status(200).json({
      success: true,
      message: "Payment session created successfully",
      data,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   STUDENT: PAYMENT STATUS
   GET /api/v1/payments/status/:orderId
===================================================== */

export const getPaymentStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const studentId = getUserId(req);
    const orderId = String(req.params.orderId);

    validateObjectId(orderId);

    const data = await getPaymentStatusService(studentId, orderId);

    res.status(200).json({
      success: true,
      message: "Payment status fetched successfully",
      data,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   CASHFREE WEBHOOK
   POST /api/v1/payments/webhook.
===================================================== */
export const cashfreeWebhook = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const rawBody = (req as Request & { rawBody?: string }).rawBody;

    if (typeof rawBody !== "string" || rawBody.length === 0) {
      throw new BadRequestError("Missing raw request body");
    }

    await handleCashfreeWebhookService(
      rawBody,
      headerValue(req, "x-webhook-timestamp"),
      headerValue(req, "x-webhook-signature"),
    );

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};
