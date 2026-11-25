import { randomBytes } from "crypto";
import { ClientSession, HydratedDocument, Types } from "mongoose";

import { Payment, IPayment } from "../models/payment.model.js";
import { Order, IOrder } from "../models/order.model.js";
import { Student } from "../models/student.model.js";
import { User } from "../models/user.model.js";
import { serverConfig } from "../config/index.js";
import {
  createCashfreeOrder,
  verifyCashfreeOrder,
  verifyCashfreeWebhookSignature,
  createCashfreeRefund,
} from "../config/cashfree.config.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/errors/app.error.js";
import logger from "../config/logger.config.js";
import { emitOrderCreatedToCafe, emitPaymentEvent } from "../socket/index.js";
import {
  acquireDistributedLock,
  isRedisAvailable,
  redisKeys,
  releaseDistributedLock,
  type DistributedLockHandle,
} from "../infrastructure/redis/index.js";

export const emitPaymentLifecycleEvent = (
  payment: Pick<
    IPayment,
    "paymentId" | "order" | "cafe" | "student" | "status" | "method" | "amount"
  >,
  orderPaymentStatus: "pending" | "paid" | "failed" | "refunded",
): void => {
  emitPaymentEvent({
    paymentId: payment.paymentId,
    orderId: String(payment.order),
    cafeId: String(payment.cafe),
    studentId: String(payment.student),
    status: payment.status,
    orderPaymentStatus,
    method: payment.method,
    amount: payment.amount,
  });
};

/* =====================================================
   TYPES + HELPERS
===================================================== */
type PaymentDoc = HydratedDocument<IPayment>;

type StudentLite = {
  _id?: Types.ObjectId;
  user?: {
    _id?: Types.ObjectId;
    name?: string;
    email?: string;
    phone?: string;
  };
};

type UserLite = {
  _id?: Types.ObjectId;
  name?: string;
  email?: string;
  phone?: string;
};

const studentOwnerFilter = (studentId: string, legacyUserId?: string) =>
  legacyUserId && legacyUserId !== studentId
    ? { $in: [oid(studentId), oid(legacyUserId)] }
    : oid(studentId);

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

type PaymentViewInput = Pick<
  IPayment,
  "paymentId" | "status" | "method" | "amount" | "transactionId" | "paidAt"
>;

const paymentView = (p: PaymentViewInput) => ({
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
    logger.error("[payment] refund failed", {
      paymentId: payment.paymentId,
      error: err instanceof Error ? err.message : String(err),
    });
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
    emitPaymentLifecycleEvent(
      {
        paymentId: payment.paymentId,
        order: payment.order,
        cafe: payment.cafe,
        student: payment.student,
        status: "refunded",
        method: payment.method,
        amount: payment.amount,
      },
      updateOrder ? "refunded" : "paid",
    );
  } catch (err) {
    logger.error("[payment] refunded at gateway but DB update failed", {
      paymentId: payment.paymentId,
      error: err instanceof Error ? err.message : String(err),
    });
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

  const updated = await Payment.findOneAndUpdate(
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

  const paid = updated ?? (await Payment.findById(payment._id));
  if (!paid || paid.status !== "success") {
    return paid ?? payment;
  }

  const claim = await Order.updateOne(
    { _id: orderId, paymentStatus: { $in: ["pending", "failed"] } },
    { $set: { paymentStatus: "paid", paymentId: paid._id } },
  );

  if (claim.modifiedCount !== 1) {
    const current = await Order.findById(orderId).select(
      "paymentId paymentStatus",
    );
    const holder = current?.paymentId ? String(current.paymentId) : null;

    if (holder && holder !== String(paid._id)) {
      await refundPayment(paid, { updateOrder: false });
      return (await Payment.findById(paid._id)) ?? paid;
    }
    return paid;
  }

  const fresh = await Order.findById(orderId);
  if (fresh && (fresh.status === "cancelled" || fresh.status === "rejected")) {
    await refundPayment(paid);
    return (await Payment.findById(paid._id)) ?? paid;
  }

  emitPaymentLifecycleEvent(paid, "paid");
  if (fresh && fresh.status === "pending") {
    emitOrderCreatedToCafe({
      orderId: String(fresh._id),
      orderNumber: fresh.orderNumber,
      cafeId: String(fresh.cafe),
      studentId: String(fresh.student),
      status: fresh.status,
      paymentStatus: fresh.paymentStatus,
      paymentMethod: fresh.paymentMethod,
      totalAmount: fresh.totalAmount,
      rejectionReason: fresh.rejectionReason ?? null,
      updatedAt: fresh.updatedAt?.toISOString(),
    });
  }
  return paid;
};

const markFailed = async (
  payment: PaymentDoc,
  gateway: unknown,
): Promise<PaymentDoc> => {
  const updated = await Payment.findOneAndUpdate(
    { _id: payment._id, status: "pending" },
    { $set: { status: "failed", gatewayResponse: gateway } },
    { new: true },
  );
  if (!updated) return payment;

  const order = await Order.findById(updated.order)
    .select("paymentStatus")
    .lean();
  emitPaymentLifecycleEvent(updated, order?.paymentStatus ?? "pending");
  return updated;
};

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
      logger.error("[payment] amount mismatch", {
        paymentId: payment.paymentId,
        expected: payment.amount,
        received: cf.order_amount,
      });
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
  const candidates = await Payment.find({
    order: orderId,
    method: "cashfree",
    status: { $in: ["success", "pending"] },
  })
    .sort({ createdAt: -1 })
    .limit(5);

  const succeeded = candidates.find((p) => p.status === "success");
  if (succeeded) {
    const order = await Order.findById(orderId).select("paymentStatus status").lean();
    if (
      order &&
      (order.paymentStatus === "pending" || order.paymentStatus === "failed")
    ) {
      await markPaid(
        succeeded,
        succeeded.gatewayResponse,
        succeeded.transactionId,
      );
    }
    return;
  }

  const pending = candidates.find((p) => p.status === "pending");
  if (pending) await syncPayment(pending);
};

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const acquireInitiateLockWithWait = async (
  lockKey: string,
): Promise<DistributedLockHandle | null> => {
  const first = await acquireDistributedLock(lockKey, 15);
  if (first || !isRedisAvailable()) {
    return first;
  }

  for (let i = 0; i < 30; i++) {
    await sleepMs(100);
    const next = await acquireDistributedLock(lockKey, 15);
    if (next || !isRedisAvailable()) {
      return next;
    }
  }

  return null;
};

/* =====================================================
   STUDENT: START ONLINE PAYMENT
===================================================== */
export const initiatePaymentService = async (
  studentId: string,
  orderId: string,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");
  assertObjectId(orderId, "order ID");

  const order = await Order.findOne({
    _id: oid(orderId),
    student: studentOwnerFilter(studentId, legacyUserId),
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

  const lockKey = redisKeys.paymentInitiateLock(orderId);
  const lock = await acquireInitiateLockWithWait(lockKey);
  if (!lock && isRedisAvailable()) {
    throw new ConflictError(
      "Payment initiation already in progress. Please try again.",
    );
  }

  try {
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

    const studentDoc = await Student.findById(order.student)
      .select("user")
      .populate("user", "name email phone")
      .lean<StudentLite>();

    const resolvedUser: UserLite | null =
      studentDoc?.user ??
      (await User.findById(legacyUserId ?? order.student)
        .select("name email phone")
        .lean<UserLite>());

    const phone = [resolvedUser?.phone, order.deliveryAddress?.phone].find(
      (p): p is string => typeof p === "string" && PHONE.test(p),
    );

    let payment: PaymentDoc;
    try {
      payment = await Payment.create({
        paymentId: makePaymentId(),
        order: order._id,
        student: oid(studentId),
        cafe: order.cafe,
        amount: order.totalAmount,
        method: "cashfree",
        status: "pending",
      });
    } catch (createErr: unknown) {
      if ((createErr as { code?: number })?.code === 11000) {
        for (let i = 0; i < 15; i++) {
          const concurrent = await Payment.findOne({
            order: order._id,
            method: "cashfree",
            status: "pending",
          }).sort({ createdAt: -1 });
          const concurrentSid = concurrent
            ? sessionIdOf(concurrent)
            : undefined;
          if (concurrent && concurrentSid) {
            return view(concurrent, concurrentSid);
          }
          await sleepMs(100);
        }
        throw new ConflictError(
          "Payment initiation already in progress. Please try again.",
        );
      }
      throw createErr;
    }

    try {
      const cf = await createCashfreeOrder({
        orderId: payment.paymentId,
        amount: Number(order.totalAmount.toFixed(2)),
        customerId: String(resolvedUser?._id ?? legacyUserId ?? studentId),
        customerName: resolvedUser?.name || "Student",
        customerPhone: phone ?? "9999999999",
        customerEmail: resolvedUser?.email || "student@example.com",
      });

      payment.gatewayResponse = cf;
      await payment.save();

      if (!cf.payment_session_id) throw new Error("No payment session id");
      emitPaymentLifecycleEvent(payment, order.paymentStatus);
      return view(payment, cf.payment_session_id as string);
    } catch (err) {
      logger.error("[payment] cashfree order failed", {
        paymentId: payment.paymentId,
        error: err instanceof Error ? err.message : String(err),
      });
      await Payment.updateOne(
        { _id: payment._id, status: "pending" },
        { $set: { status: "failed" } },
      );
      throw new ConflictError("Payment could not be started. Please try again");
    }
  } finally {
    await releaseDistributedLock(lock);
  }
};

/* =====================================================
   STUDENT: PAYMENT STATUS
===================================================== */
export const getPaymentStatusService = async (
  studentId: string,
  orderId: string,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");
  assertObjectId(orderId, "order ID");

  const order = await Order.findOne({
    _id: oid(orderId),
    student: studentOwnerFilter(studentId, legacyUserId),
  })
    .select("_id status paymentMethod paymentStatus")
    .lean();
  if (!order) throw new NotFoundError("Order not found");

  const shouldSync =
    order.paymentMethod === "online" && order.paymentStatus === "pending";
  if (shouldSync) {
    await syncLatestPayment(order._id);
  }

  const [payments, fresh] = await Promise.all([
    Payment.find({ order: order._id })
      .select("paymentId status method amount transactionId paidAt")
      .sort({ createdAt: -1 })
      .lean<PaymentViewInput[]>(),
    shouldSync
      ? Order.findById(order._id)
          .select("_id status paymentMethod paymentStatus")
          .lean()
      : Promise.resolve(order),
  ]);

  const payment =
    payments.find((p) => p.status === "success") ??
    payments.find((p) => p.status === "refunded") ??
    payments[0] ??
    null;

  const currentOrder = fresh ?? order;

  return {
    orderId: currentOrder._id,
    orderStatus: currentOrder.status,
    paymentMethod: currentOrder.paymentMethod,
    paymentStatus: currentOrder.paymentStatus,
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

  const lock = await acquireDistributedLock(
    redisKeys.webhookSyncLock(cfOrderId),
    10,
  );
  try {
    const payment = await Payment.findOne({ paymentId: cfOrderId });
    if (!payment) return;

    const cfPaymentId = payload.data?.payment?.cf_payment_id;
    await syncPayment(
      payment,
      cfPaymentId !== undefined ? String(cfPaymentId) : undefined,
    );
  } finally {
    await releaseDistributedLock(lock);
  }
};

/* =====================================================
   CASH PAYMENT RECORD
===================================================== */
export const recordCashPayment = async (
  orderId: Types.ObjectId | string,
  options: { txSession?: ClientSession; deferEmit?: boolean } = {},
) => {
  const { txSession, deferEmit = false } = options;
  const sessionOpt = txSession ? { session: txSession } : undefined;

  const order = await Order.findById(orderId, undefined, sessionOpt);
  if (!order) throw new NotFoundError("Order not found");

  const existing = await Payment.findOne(
    { order: order._id, method: "cash" },
    undefined,
    sessionOpt,
  );
  if (existing) return existing;

  const doc = {
    paymentId: makePaymentId(),
    order: order._id,
    student: order.student,
    cafe: order.cafe,
    amount: order.totalAmount,
    method: "cash" as const,
    status: "success" as const,
    paidAt: new Date(),
    ...splitAmount(order),
  };

  try {
    const created = txSession
      ? (await Payment.create([doc], { session: txSession }))[0]
      : await Payment.create(doc);

    if (!deferEmit) {
      emitPaymentLifecycleEvent(created, "paid");
    }
    return created;
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 11000) {
      const winner = await Payment.findOne(
        { order: order._id, method: "cash" },
        undefined,
        sessionOpt,
      );
      if (winner) return winner;
    }
    throw err;
  }
};
