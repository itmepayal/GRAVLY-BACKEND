import { randomBytes } from "crypto";
import { HydratedDocument, Types } from "mongoose";

import { Payment, IPayment } from "../models/payment.model";
import { Order, IOrder } from "../models/order.model";
import { Student } from "../models/student.model";
import { serverConfig } from "../config";
import {
  createCashfreeOrder,
  verifyCashfreeOrder,
  verifyCashfreeWebhookSignature,
  createCashfreeRefund,
} from "../config/cashfree.config";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/errors/app.error";

/* =====================================================
   TYPES + HELPERS
===================================================== */
type PaymentDoc = HydratedDocument<IPayment>;

type StudentLite = { name?: string; email?: string; phone?: string };

const PHONE = /^[6-9]\d{9}$/;

const oid = (id: string) => new Types.ObjectId(id);

const assertObjectId = (id: string, label: string) => {
  if (!Types.ObjectId.isValid(id))
    throw new BadRequestError(`Invalid ${label}`);
};

const makePaymentId = () =>
  `pay_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

const splitAmount = (o: { totalAmount: number; platformFee: number }) => {
  const commission = o.platformFee ?? 0;
  return { commission, cafeEarning: o.totalAmount - commission };
};

const sessionIdOf = (p: PaymentDoc): string | undefined =>
  (p.gatewayResponse as { payment_session_id?: string } | undefined)
    ?.payment_session_id;

const paymentView = (p: PaymentDoc) => ({
  paymentId: p.paymentId,
  status: p.status,
  method: p.method,
  amount: p.amount,
  transactionId: p.transactionId ?? null,
  paidAt: p.paidAt ?? null,
});

/* =====================================================
   REFUND
===================================================== */
export const refundPayment = async (
  payment: PaymentDoc,
  { updateOrder = true }: { updateOrder?: boolean } = {},
): Promise<boolean> => {
  if (payment.status !== "success" || payment.method !== "cashfree") {
    return false;
  }

  try {
    await createCashfreeRefund({
      orderId: payment.paymentId,
      refundAmount: payment.amount,
      refundId: `rf_${payment.paymentId}`,
      refundNote: "Order cancelled",
    });
  } catch (err) {
    console.error("[payment] REFUND FAILED", payment.paymentId, err);
    return false;
  }

  try {
    await Payment.updateOne(
      { _id: payment._id, status: "success" },
      { $set: { status: "refunded" } },
    );
    if (updateOrder) {
      await Order.updateOne(
        { _id: payment.order as Types.ObjectId, paymentStatus: "paid" },
        { $set: { paymentStatus: "refunded" } },
      );
    }
  } catch (err) {
    console.error(
      "[payment] REFUNDED AT GATEWAY BUT DB UPDATE FAILED",
      payment.paymentId,
      err,
    );
  }
  return true;
};

export const refundOrderPayment = async (
  orderId: Types.ObjectId | string,
): Promise<boolean> => {
  const payment = await Payment.findOne({
    order: orderId,
    method: "cashfree",
    status: "success",
  });
  return payment ? refundPayment(payment) : false;
};

/* =====================================================
   MARK PAID / FAILED
===================================================== */
const markPaid = async (
  payment: PaymentDoc,
  gateway: unknown,
  cfPaymentId?: string,
): Promise<PaymentDoc> => {
  const orderId = payment.order as Types.ObjectId;
  const order = await Order.findById(orderId);
  if (!order) return payment;

  const paid = await Payment.findOneAndUpdate(
    { _id: payment._id, status: { $in: ["pending", "failed"] } },
    {
      $set: {
        status: "success",
        ...(cfPaymentId ? { transactionId: cfPaymentId } : {}),
        gatewayResponse: gateway,
        paidAt: new Date(),
        ...splitAmount(order),
      },
    },
    { new: true },
  );
  if (!paid) return (await Payment.findById(payment._id)) ?? payment;

  const claim = await Order.updateOne(
    { _id: orderId, paymentStatus: { $in: ["pending", "failed"] } },
    { $set: { paymentStatus: "paid", paymentId: paid._id } },
  );

  if (claim.modifiedCount !== 1) {
    const current = await Order.findById(orderId).select("paymentId");
    const holder = current?.paymentId ? String(current.paymentId) : null;

    if (holder && holder !== String(paid._id)) {
      await refundPayment(paid, { updateOrder: false });
      return (await Payment.findById(paid._id)) ?? paid;
    }
    return paid;
  }

  const fresh = await Order.findById(orderId).select("status");
  if (fresh && (fresh.status === "cancelled" || fresh.status === "rejected")) {
    await refundPayment(paid);
    return (await Payment.findById(paid._id)) ?? paid;
  }

  return paid;
};

const markFailed = async (
  payment: PaymentDoc,
  gateway: unknown,
): Promise<PaymentDoc> =>
  (await Payment.findOneAndUpdate(
    { _id: payment._id, status: "pending" },
    { $set: { status: "failed", gatewayResponse: gateway } },
    { new: true },
  )) ?? payment;

/* =====================================================
   SYNC WITH CASHFREE
   Cashfree order_status: ACTIVE | PAID | EXPIRED | TERMINATED
===================================================== */
const syncPayment = async (
  payment: PaymentDoc,
  cfPaymentId?: string,
): Promise<PaymentDoc> => {
  if (payment.method !== "cashfree") return payment;

  if (payment.status === "success" || payment.status === "refunded") {
    if (cfPaymentId && !payment.transactionId) {
      await Payment.updateOne(
        { _id: payment._id, transactionId: null },
        { $set: { transactionId: cfPaymentId } },
      );
      payment.transactionId = cfPaymentId;
    }
    return payment;
  }

  if (payment.status !== "pending" && payment.status !== "failed") {
    return payment;
  }

  const cf = await verifyCashfreeOrder(payment.paymentId);
  const orderStatus = String(cf?.order_status ?? "");

  if (orderStatus === "PAID") {
    if (Math.abs(Number(cf.order_amount) - payment.amount) > 0.01) {
      console.error("[payment] amount mismatch", payment.paymentId, cf);
      return payment;
    }
    return markPaid(payment, cf, cfPaymentId);
  }

  if (
    payment.status === "pending" &&
    (orderStatus === "EXPIRED" || orderStatus === "TERMINATED")
  ) {
    return markFailed(payment, cf);
  }

  return payment;
};

export const syncLatestPayment = async (orderId: Types.ObjectId | string) => {
  const payment = await Payment.findOne({
    order: orderId,
    method: "cashfree",
    status: "pending",
  }).sort({ createdAt: -1 });

  if (payment) await syncPayment(payment);
};

/* =====================================================
   STUDENT: START ONLINE PAYMENT
===================================================== */
export const initiatePaymentService = async (
  studentId: string,
  orderId: string,
) => {
  assertObjectId(studentId, "user ID");
  assertObjectId(orderId, "order ID");

  const order = await Order.findOne({
    _id: oid(orderId),
    student: oid(studentId),
  });
  if (!order) throw new NotFoundError("Order not found");

  if (order.paymentMethod !== "online") {
    throw new ConflictError("This order is paid in cash");
  }
  if (order.status !== "pending") {
    throw new ConflictError("This order can no longer be paid");
  }
  if (order.paymentStatus === "paid" || order.paymentStatus === "refunded") {
    throw new ConflictError("This order is already paid");
  }

  const environment =
    serverConfig.CASHFREE_ENV === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";

  const view = (p: PaymentDoc, sessionId: string) => ({
    paymentId: p.paymentId,
    orderId: order._id,
    orderNumber: order.orderNumber,
    amount: order.totalAmount,
    currency: "INR",
    cashfreeOrderId: p.paymentId,
    paymentSessionId: sessionId,
    environment,
  });

  const existing = await Payment.findOne({
    order: order._id,
    method: "cashfree",
    status: "pending",
  }).sort({ createdAt: -1 });

  if (existing) {
    const synced = await syncPayment(existing);
    if (synced.status === "success" || synced.status === "refunded") {
      throw new ConflictError("This order is already paid");
    }
    const sessionId = sessionIdOf(synced);
    if (synced.status === "pending" && sessionId) {
      return view(synced, sessionId);
    }
  }

  const student = await Student.findById(order.student)
    .select("name email phone")
    .lean<StudentLite>();

  const phone = [student?.phone, order.deliveryAddress?.phone].find(
    (p): p is string => typeof p === "string" && PHONE.test(p),
  );

  const payment = await Payment.create({
    paymentId: makePaymentId(),
    order: order._id,
    student: order.student,
    cafe: order.cafe,
    amount: order.totalAmount,
    method: "cashfree",
    status: "pending",
  });

  try {
    const cf = await createCashfreeOrder({
      orderId: payment.paymentId,
      amount: Number(order.totalAmount.toFixed(2)),
      customerId: String(studentId),
      customerName: student?.name || "Student",
      customerPhone: phone ?? "9999999999",
      customerEmail: student?.email || "student@example.com",
    });

    payment.gatewayResponse = cf;
    await payment.save();

    if (!cf.payment_session_id) throw new Error("No payment session id");
    return view(payment, cf.payment_session_id as string);
  } catch (err) {
    console.error("[payment] cashfree order failed", err);
    await Payment.updateOne(
      { _id: payment._id, status: "pending" },
      { $set: { status: "failed" } },
    );
    throw new ConflictError("Payment could not be started. Please try again");
  }
};

/* =====================================================
   STUDENT: PAYMENT STATUS
===================================================== */
export const getPaymentStatusService = async (
  studentId: string,
  orderId: string,
) => {
  assertObjectId(studentId, "user ID");
  assertObjectId(orderId, "order ID");

  const order = await Order.findOne({
    _id: oid(orderId),
    student: oid(studentId),
  });
  if (!order) throw new NotFoundError("Order not found");

  await syncLatestPayment(order._id);

  const payments = await Payment.find({ order: order._id }).sort({
    createdAt: -1,
  });
  const payment =
    payments.find((p) => p.status === "success") ??
    payments.find((p) => p.status === "refunded") ??
    payments[0] ??
    null;

  const fresh = (await Order.findById(order._id)) as HydratedDocument<IOrder>;

  return {
    orderId: fresh._id,
    orderStatus: fresh.status,
    paymentMethod: fresh.paymentMethod,
    paymentStatus: fresh.paymentStatus,
    payment: payment ? paymentView(payment) : null,
  };
};

/* =====================================================
   CASHFREE WEBHOOK
   POST /payments/webhook
===================================================== */
export const handleCashfreeWebhookService = async (
  rawBody: string,
  timestamp: string,
  signature: string,
) => {
  if (
    !timestamp ||
    !signature ||
    !verifyCashfreeWebhookSignature(rawBody, timestamp, signature)
  ) {
    throw new BadRequestError("Invalid webhook signature");
  }

  let payload: {
    data?: {
      order?: { order_id?: string };
      payment?: { cf_payment_id?: string | number };
    };
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new BadRequestError("Invalid webhook body");
  }

  const cfOrderId = payload.data?.order?.order_id;
  if (typeof cfOrderId !== "string") return;

  const payment = await Payment.findOne({ paymentId: cfOrderId });
  if (!payment) return;

  const cfPaymentId = payload.data?.payment?.cf_payment_id;
  await syncPayment(
    payment,
    cfPaymentId !== undefined ? String(cfPaymentId) : undefined,
  );
};

/* =====================================================
   CASH PAYMENT RECORD
===================================================== */
export const recordCashPayment = async (orderId: Types.ObjectId | string) => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError("Order not found");

  const existing = await Payment.findOne({ order: order._id, method: "cash" });
  if (existing) return existing;

  return Payment.create({
    paymentId: makePaymentId(),
    order: order._id,
    student: order.student,
    cafe: order.cafe,
    amount: order.totalAmount,
    method: "cash",
    status: "success",
    paidAt: new Date(),
    ...splitAmount(order),
  });
};
