import { randomBytes } from "crypto";
import { ClientSession, HydratedDocument, Types } from "mongoose";

import { Cart } from "../models/cart.model.js";
import { MenuItem, IMenuItem } from "../models/menuItem.model.js";
import { Order, IOrder, OrderStatus } from "../models/order.model.js";
import { Payment } from "../models/payment.model.js";
import { runWithOptionalTransaction } from "../config/db.config.js";
import {
  refundOrderPayment,
  recordCashPayment,
  emitPaymentLifecycleEvent,
  syncLatestPayment,
} from "./payment.service.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/errors/app.error.js";
import logger from "../config/logger.config.js";
import { emitOrderEvent } from "../socket/index.js";
import {
  getOrderableCafeMeta,
  invalidatePublicMenuCaches,
  type OrderableCafeMeta,
} from "./cafe.service.js";

const extractObjectIdString = (val: unknown): string => {
  if (val && typeof val === "object" && "_id" in val) {
    return String((val as { _id: Types.ObjectId })._id);
  }
  return String(val);
};

const emitOrderLifecycleEvent = (order: HydratedDocument<IOrder>): void => {
  emitOrderEvent({
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    cafeId: extractObjectIdString(order.cafe),
    studentId: extractObjectIdString(order.student),
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    totalAmount: order.totalAmount,
    rejectionReason: order.rejectionReason ?? null,
    updatedAt: order.updatedAt?.toISOString(),
  });
};

/* =====================================================
   TYPES + CONSTANTS
===================================================== */
type OrderDoc = HydratedDocument<IOrder>;

type MenuLean = Pick<
  IMenuItem,
  "name" | "price" | "isAvailable" | "trackStock" | "stock"
> & { _id: Types.ObjectId };

type StatusTarget = "preparing" | "ready" | "delivered";

const ACTIVE_STATUSES: OrderStatus[] = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
];
const HISTORY_STATUSES: OrderStatus[] = ["delivered", "cancelled", "rejected"];
const ALL_STATUSES: OrderStatus[] = [...ACTIVE_STATUSES, ...HISTORY_STATUSES];

const PREVIOUS_STATUS: Record<StatusTarget, OrderStatus[]> = {
  preparing: ["confirmed"],
  ready: ["confirmed", "preparing"],
  delivered: ["ready"],
};

const VISIBLE_TO_CAFE = {
  $or: [{ paymentMethod: "cash" as const }, { paymentStatus: "paid" as const }],
};

const PHONE = /^[6-9]\d{9}$/;

/* flat platform fee added to every order (in rupees) */
const PLATFORM_FEE = 10;

/* =====================================================
   HELPERS
===================================================== */
const oid = (id: string) => new Types.ObjectId(id);

const assertObjectId = (id: string, label: string) => {
  if (!Types.ObjectId.isValid(id))
    throw new BadRequestError(`Invalid ${label}`);
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

const isStatus = (s: string): s is OrderStatus =>
  (ALL_STATUSES as string[]).includes(s);

const isTarget = (s: string): s is StatusTarget =>
  Object.prototype.hasOwnProperty.call(PREVIOUS_STATUS, s);

const makeOrderNumber = () =>
  `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`.toUpperCase();

const parsePaging = (q: Record<string, unknown>) => {
  const page = Math.max(1, Number.parseInt(str(q.page), 10) || 1);
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(str(q.limit), 10) || 10),
  );
  return { page, limit, skip: (page - 1) * limit };
};

const pagination = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

export const releaseStock = async (
  items: { menuItem: Types.ObjectId | IMenuItem; quantity: number }[],
  txSession?: ClientSession,
) => {
  if (items.length === 0) return;
  await MenuItem.bulkWrite(
    items.map((i) => ({
      updateOne: {
        filter: { _id: i.menuItem as Types.ObjectId, trackStock: true },
        update: { $inc: { stock: i.quantity } },
      },
    })),
    txSession ? { session: txSession } : undefined,
  );
};

const safeRelease = (items: Parameters<typeof releaseStock>[0]) =>
  releaseStock(items).catch((e) =>
    logger.error("[order] stock release failed", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );

const refundIfPaid = async (order: OrderDoc) => {
  if (order.paymentMethod !== "online" || order.paymentStatus !== "paid") {
    return;
  }
  try {
    const refunded = await refundOrderPayment(order._id);
    if (refunded) order.paymentStatus = "refunded";
  } catch (e) {
    logger.error("[order] refund failed", {
      orderId: String(order._id),
      error: e instanceof Error ? e.message : String(e),
    });
  }
};

const failTransition = async (
  orderId: string,
  owner: Record<string, unknown>,
  message: string,
): Promise<never> => {
  const exists = await Order.exists({ _id: oid(orderId), ...owner });
  throw exists
    ? new ConflictError(message)
    : new NotFoundError("Order not found");
};

const studentOwnerFilter = (studentId: string, legacyUserId?: string) =>
  legacyUserId && legacyUserId !== studentId
    ? { $in: [oid(studentId), oid(legacyUserId)] }
    : oid(studentId);

const STUDENT_POPULATE = {
  path: "student",
  select: "user rollNumber",
  populate: {
    path: "user",
    select: "name",
  },
};

const findOrderableCafe = async (
  cafeId: Types.ObjectId | string,
): Promise<OrderableCafeMeta> => {
  const cafe = await getOrderableCafeMeta(cafeId);

  if (
    !cafe ||
    !cafe.isApproved ||
    cafe.approvalStatus !== "approved" ||
    !cafe.isVisible ||
    !cafe.isActive
  ) {
    throw new NotFoundError("Cafe is not available");
  }
  if (!cafe.isOpen) throw new ConflictError("Cafe is currently closed");
  return cafe;
};

/* =====================================================
   VIEW 
===================================================== */
type OrderViewInput = Pick<
  IOrder,
  | "orderNumber"
  | "cafe"
  | "student"
  | "orderMethod"
  | "deliveryAddress"
  | "notes"
  | "items"
  | "subtotal"
  | "deliveryFee"
  | "platformFee"
  | "totalAmount"
  | "status"
  | "paymentMethod"
  | "paymentStatus"
  | "rejectionReason"
  | "completedAt"
  | "createdAt"
  | "updatedAt"
> & { _id: Types.ObjectId };

const orderView = (
  o: OrderViewInput,
  cafeOverride?: { _id: Types.ObjectId | string; name?: string | null },
) => {
  const cafeRef =
    cafeOverride ??
    (o.cafe as unknown as { _id?: Types.ObjectId; name?: string });
  const studentRef = o.student as unknown as {
    _id?: Types.ObjectId;
    name?: string;
    user?: { _id?: Types.ObjectId; name?: string };
  } | null;

  return {
    _id: o._id,
    orderNumber: o.orderNumber,
    status: o.status,
    cafe: {
      _id: cafeRef?._id ?? (o.cafe as Types.ObjectId),
      name: cafeRef?.name ?? null,
    },
    student: {
      _id: studentRef?._id ?? (o.student as Types.ObjectId),
      name: studentRef?.user?.name ?? studentRef?.name ?? null,
    },
    orderMethod: o.orderMethod,
    deliveryAddress:
      o.orderMethod === "delivery" ? (o.deliveryAddress ?? null) : null,
    notes: o.notes ?? null,
    items: o.items.map((i) => ({
      menuItem: i.menuItem,
      name: i.name,
      quantity: i.quantity,
      price: i.price,
      lineTotal: i.price * i.quantity,
    })),
    summary: {
      subtotal: o.subtotal,
      deliveryFee: o.deliveryFee,
      platformFee: o.platformFee,
      totalAmount: o.totalAmount,
    },
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    rejectionReason: o.rejectionReason ?? null,
    completedAt: o.completedAt ?? null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
};

/* =====================================================
   STUDENT: PLACE ORDER
===================================================== */
export const placeOrderService = async (
  studentId: string,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");

  const cart = await Cart.findOne({
    student: studentOwnerFilter(studentId, legacyUserId),
    status: "active",
  });
  if (!cart || cart.items.length === 0) {
    throw new BadRequestError("Your cart is empty");
  }

  const cafe = await findOrderableCafe(cart.cafe as Types.ObjectId);

  if (cart.orderMethod === "delivery") {
    if (!cafe.deliveryEnabled) {
      throw new ConflictError("This cafe does not offer delivery");
    }
    const a = cart.deliveryAddress;
    if (!a?.hostel || !a?.roomNumber || !a?.phone) {
      throw new BadRequestError(
        "Delivery needs deliveryAddress with hostel, roomNumber and phone",
      );
    }
    if (!PHONE.test(a.phone)) {
      throw new BadRequestError("Valid 10 digit phone is required");
    }
  } else if (!cafe.pickupEnabled) {
    throw new ConflictError("This cafe does not offer self pickup");
  }

  const menu = await MenuItem.find({
    _id: { $in: cart.items.map((i) => i.menuItem as Types.ObjectId) },
  })
    .select("name price isAvailable trackStock stock")
    .lean<MenuLean[]>();

  const byId = new Map<string, MenuLean>(menu.map((m) => [String(m._id), m]));
  const problems: string[] = [];

  const orderItems = cart.items.flatMap((line) => {
    const m = byId.get(String(line.menuItem));
    const name = m?.name ?? line.name ?? "Item";

    if (!m || !m.isAvailable) {
      problems.push(`${name}: No longer available`);
      return [];
    }
    if (m.trackStock && m.stock < line.quantity) {
      problems.push(
        `${name}: ${m.stock === 0 ? "Out of stock" : `Only ${m.stock} left`}`,
      );
      return [];
    }
    return [
      {
        menuItem: m._id,
        name: m.name,
        quantity: line.quantity,
        price: m.price,
      },
    ];
  });

  if (problems.length > 0) {
    throw new ConflictError(`Cannot place order. ${problems.join(", ")}`);
  }

  const subtotal = orderItems.reduce((s, i) => s + i.price * i.quantity, 0);
  const deliveryFee =
    cart.orderMethod === "delivery" ? (cafe.deliveryFee ?? 0) : 0;
  const platformFee = PLATFORM_FEE;
  const totalAmount = subtotal + deliveryFee + platformFee;

  const { order, reservedCount } = await runWithOptionalTransaction(
    async (txSession) => {
      const sessionOpt = txSession ? { session: txSession } : {};
      const claimed = await Cart.findOneAndUpdate(
        { _id: cart._id, status: "active" },
        { $set: { status: "ordered" } },
        sessionOpt,
      );
      if (!claimed) throw new ConflictError("This cart was already ordered");

      const reserved: typeof orderItems = [];
      const sortedReserveItems = [...orderItems].sort((a, b) =>
        String(a.menuItem).localeCompare(String(b.menuItem)),
      );
      try {
        for (const item of sortedReserveItems) {
          if (!byId.get(String(item.menuItem))?.trackStock) continue;

          const r = await MenuItem.updateOne(
            {
              _id: item.menuItem,
              trackStock: true,
              stock: { $gte: item.quantity },
            },
            { $inc: { stock: -item.quantity } },
            sessionOpt,
          );
          if (r.modifiedCount !== 1) {
            throw new ConflictError(`${item.name}: not enough stock`);
          }
          reserved.push(item);
        }

        const orderDoc = {
          orderNumber: makeOrderNumber(),
          student: oid(studentId),
          cafe: new Types.ObjectId(String(cafe._id)),
          items: orderItems,
          orderMethod: cart.orderMethod,
          deliveryAddress:
            cart.orderMethod === "delivery" ? cart.deliveryAddress : undefined,
          notes: cart.orderNotes,
          subtotal,
          deliveryFee,
          platformFee,
          totalAmount,
          status: "pending" as const,
          paymentMethod: cart.paymentMethod,
          paymentStatus: "pending" as const,
        };

        const created = txSession
          ? (await Order.create([orderDoc], { session: txSession }))[0]
          : await Order.create(orderDoc);

        return { order: created, reservedCount: reserved.length };
      } catch (err) {
        if (!txSession) {
          await safeRelease(reserved);
          await Cart.updateOne(
            { _id: cart._id, status: "ordered" },
            { $set: { status: "active" } },
          ).catch((restoreErr) =>
            logger.error("[order] cart rollback failed", {
              cartId: String(cart._id),
              error:
                restoreErr instanceof Error
                  ? restoreErr.message
                  : String(restoreErr),
            }),
          );
        }
        throw err;
      }
    },
  );

  if (reservedCount > 0) {
    await invalidatePublicMenuCaches(String(cafe._id));
  }
  emitOrderLifecycleEvent(order);
  return orderView(order, { _id: cafe._id, name: cafe.name });
};

/* =====================================================
   STUDENT: MY ORDERS
===================================================== */
export const getMyOrdersService = async (
  studentId: string,
  query: unknown,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");

  const q = asObject(query);
  const type = str(q.type) || "active";
  if (type !== "active" && type !== "history") {
    throw new BadRequestError("type must be active or history");
  }

  const { page, limit, skip } = parsePaging(q);
  const filter = {
    student: studentOwnerFilter(studentId, legacyUserId),
    status: { $in: type === "active" ? ACTIVE_STATUSES : HISTORY_STATUSES },
  };

  const orders = await Order.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean<OrderViewInput[]>();

  const uniqueCafeIds = Array.from(new Set(orders.map((o) => String(o.cafe))));
  const cafeMetaList = await Promise.all(
    uniqueCafeIds.map((id) => getOrderableCafeMeta(id)),
  );
  const cafeMap = new Map(
    uniqueCafeIds.map((id, idx) => [
      id,
      cafeMetaList[idx]
        ? { _id: cafeMetaList[idx]!._id, name: cafeMetaList[idx]!.name }
        : { _id: id, name: null },
    ]),
  );

  const total =
    skip === 0 && orders.length < limit
      ? orders.length
      : await Order.countDocuments(filter);

  return {
    orders: orders.map((o) => orderView(o, cafeMap.get(String(o.cafe)))),
    pagination: pagination(page, limit, total),
  };
};

/* =====================================================
   STUDENT: ORDER DETAILS
===================================================== */
export const getMyOrderService = async (
  studentId: string,
  orderId: string,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");
  assertObjectId(orderId, "order ID");

  const order = await Order.findOne({
    _id: oid(orderId),
    student: studentOwnerFilter(studentId, legacyUserId),
  }).lean<OrderViewInput | null>();

  if (!order) throw new NotFoundError("Order not found");
  const cafeMeta = await getOrderableCafeMeta(String(order.cafe));
  return orderView(
    order,
    cafeMeta ? { _id: cafeMeta._id, name: cafeMeta.name } : undefined,
  );
};

/* =====================================================
   STUDENT: CANCEL ORDER 
===================================================== */
export const cancelMyOrderService = async (
  studentId: string,
  orderId: string,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");
  assertObjectId(orderId, "order ID");

  const ownerFilter = studentOwnerFilter(studentId, legacyUserId);

  const order = await Order.findOneAndUpdate(
    { _id: oid(orderId), student: ownerFilter, status: "pending" },
    { $set: { status: "cancelled", completedAt: new Date() } },
    { new: true },
  ).populate("cafe", "name");

  if (!order) {
    return failTransition(
      orderId,
      { student: ownerFilter },
      "Order can only be cancelled before the cafe accepts it",
    );
  }

  await safeRelease(order.items);
  await invalidatePublicMenuCaches(extractObjectIdString(order.cafe));

  if (order.paymentMethod === "online" && order.paymentStatus === "pending") {
    let gatewaySynced = false;
    try {
      await syncLatestPayment(order._id);
      gatewaySynced = true;
    } catch (e) {
      logger.error("[order] syncing payment before cancel cleanup failed", {
        orderId: String(order._id),
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const refreshed = await Order.findById(order._id)
      .select("paymentStatus")
      .lean();
    if (refreshed) {
      order.paymentStatus = refreshed.paymentStatus;
    }

    if (gatewaySynced && order.paymentStatus === "pending") {
      try {
        await Order.updateOne(
          { _id: order._id, paymentStatus: "pending" },
          { $set: { paymentStatus: "failed" } },
        );
        await Payment.updateMany(
          { order: order._id, status: "pending" },
          { $set: { status: "failed" } },
        );
        order.paymentStatus = "failed";
      } catch (e) {
        logger.error("[order] closing pending payment failed", {
          orderId: String(order._id),
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  await refundIfPaid(order);

  emitOrderLifecycleEvent(order);

  return orderView(order);
};

/* =====================================================
   CAFE: LIST ORDERS
===================================================== */
export const getCafeOrdersService = async (cafeId: string, query: unknown) => {
  assertObjectId(cafeId, "cafe ID");

  const q = asObject(query);
  const statusParam = str(q.status);

  let statusFilter: OrderStatus | { $in: OrderStatus[] } = {
    $in: ACTIVE_STATUSES,
  };
  if (statusParam) {
    if (!isStatus(statusParam)) {
      throw new BadRequestError(
        `status must be one of ${ALL_STATUSES.join(", ")}`,
      );
    }
    statusFilter = statusParam;
  }

  const { page, limit, skip } = parsePaging(q);
  const filter = {
    cafe: oid(cafeId),
    ...VISIBLE_TO_CAFE,
    status: statusFilter,
  };

  const orders = await Order.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("cafe", "name")
    .populate(STUDENT_POPULATE)
    .lean<OrderViewInput[]>();

  const total =
    skip === 0 && orders.length < limit
      ? orders.length
      : await Order.countDocuments(filter);

  return {
    orders: orders.map((o) => orderView(o)),
    pagination: pagination(page, limit, total),
  };
};

/* =====================================================
   CAFE: ORDER DETAILS
===================================================== */
export const getCafeOrderService = async (cafeId: string, orderId: string) => {
  assertObjectId(cafeId, "cafe ID");
  assertObjectId(orderId, "order ID");

  const order = await Order.findOne({
    _id: oid(orderId),
    cafe: oid(cafeId),
    ...VISIBLE_TO_CAFE,
  })
    .populate("cafe", "name")
    .populate(STUDENT_POPULATE)
    .lean<OrderViewInput | null>();

  if (!order) throw new NotFoundError("Order not found");
  return orderView(order);
};

/* =====================================================
   CAFE: ACCEPT  (pending -> confirmed)
===================================================== */
export const acceptOrderService = async (cafeId: string, orderId: string) => {
  assertObjectId(cafeId, "cafe ID");
  assertObjectId(orderId, "order ID");

  const order = await Order.findOneAndUpdate(
    {
      _id: oid(orderId),
      cafe: oid(cafeId),
      status: "pending",
      ...VISIBLE_TO_CAFE,
    },
    { $set: { status: "confirmed" } },
    { new: true },
  )
    .populate("cafe", "name")
    .populate(STUDENT_POPULATE);

  if (!order) {
    return failTransition(
      orderId,
      { cafe: oid(cafeId) },
      "Only pending (and paid, if online) orders can be accepted",
    );
  }
  emitOrderLifecycleEvent(order);
  return orderView(order);
};

/* =====================================================
   CAFE: REJECT  (pending -> rejected, reason optional)
===================================================== */
export const rejectOrderService = async (
  cafeId: string,
  orderId: string,
  body: unknown,
) => {
  assertObjectId(cafeId, "cafe ID");
  assertObjectId(orderId, "order ID");

  // reason optional: the app has a plain Reject button
  const given = str(asObject(body).reason);
  if (given && (given.length < 3 || given.length > 200)) {
    throw new BadRequestError("reason must be 3 to 200 characters");
  }
  const reason = given || "Rejected by the cafe";

  const order = await Order.findOneAndUpdate(
    {
      _id: oid(orderId),
      cafe: oid(cafeId),
      status: "pending",
      ...VISIBLE_TO_CAFE,
    },
    {
      $set: {
        status: "rejected",
        rejectionReason: reason,
        completedAt: new Date(),
      },
    },
    { new: true },
  )
    .populate("cafe", "name")
    .populate(STUDENT_POPULATE);

  if (!order) {
    return failTransition(
      orderId,
      { cafe: oid(cafeId) },
      "Only pending orders can be rejected",
    );
  }

  await safeRelease(order.items);
  await invalidatePublicMenuCaches(extractObjectIdString(order.cafe));

  await refundIfPaid(order);

  emitOrderLifecycleEvent(order);
  return orderView(order);
};

/* =====================================================
   CAFE: MOVE ORDER FORWARD
===================================================== */
export const updateOrderStatusService = async (
  cafeId: string,
  orderId: string,
  body: unknown,
) => {
  assertObjectId(cafeId, "cafe ID");
  assertObjectId(orderId, "order ID");

  const target = str(asObject(body).status);
  if (!isTarget(target)) {
    throw new BadRequestError("status must be preparing, ready or delivered");
  }

  const { order, cashPaymentCreated } = await runWithOptionalTransaction(
    async (txSession) => {
      const sessionOpt = txSession ? { session: txSession } : {};
      const doc = await Order.findOneAndUpdate(
        {
          _id: oid(orderId),
          cafe: oid(cafeId),
          status: { $in: PREVIOUS_STATUS[target] },
          ...VISIBLE_TO_CAFE,
        },
        {
          $set: {
            status: target,
            ...(target === "delivered" ? { completedAt: new Date() } : {}),
          },
        },
        { new: true, ...sessionOpt },
      )
        .populate("cafe", "name")
        .populate(STUDENT_POPULATE);

      if (!doc) {
        return { order: null, cashPaymentCreated: null };
      }

      let recordedCash: Awaited<ReturnType<typeof recordCashPayment>> | null =
        null;
      if (target === "delivered" && doc.paymentMethod === "cash") {
        await Order.updateOne(
          { _id: doc._id, paymentStatus: { $ne: "paid" } },
          { $set: { paymentStatus: "paid" } },
          sessionOpt,
        );
        doc.paymentStatus = "paid";

        try {
          recordedCash = await recordCashPayment(doc._id, {
            txSession,
            deferEmit: true,
          });
        } catch (e) {
          logger.error("[order] cash payment record failed", {
            orderId: String(doc._id),
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      return { order: doc, cashPaymentCreated: recordedCash };
    },
  );

  if (!order) {
    return failTransition(
      orderId,
      { cafe: oid(cafeId) },
      `Order cannot move to ${target} from its current status`,
    );
  }

  if (cashPaymentCreated) {
    emitPaymentLifecycleEvent(cashPaymentCreated, "paid");
  }

  emitOrderLifecycleEvent(order);
  return orderView(order);
};

/* =====================================================
   CAFE: HOME SUMMARY (header earnings + counters)
   "today" is calculated in Indian time (IST, UTC+5:30)
===================================================== */
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const startOfTodayIST = () =>
  new Date(
    Math.floor((Date.now() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS,
  );

/* what the cafe earns from one order: total minus our platform fee
   (same formula as splitAmount in payment.service) */
const EARNING = {
  $subtract: ["$totalAmount", { $ifNull: ["$platformFee", 0] }],
};

export const getCafeOrderSummaryService = async (cafeId: string) => {
  assertObjectId(cafeId, "cafe ID");
  const cafe = oid(cafeId);

  const [today, newOrders, inProgress] = await Promise.all([
    Order.aggregate<{ earnings: number; orders: number }>([
      {
        $match: {
          cafe,
          status: "delivered",
          completedAt: { $gte: startOfTodayIST() },
        },
      },
      {
        $group: { _id: null, earnings: { $sum: EARNING }, orders: { $sum: 1 } },
      },
    ]),
    Order.countDocuments({ cafe, status: "pending", ...VISIBLE_TO_CAFE }),
    Order.countDocuments({
      cafe,
      status: { $in: ["confirmed", "preparing", "ready"] },
    }),
  ]);

  return {
    todayEarnings: today[0]?.earnings ?? 0,
    todayOrders: today[0]?.orders ?? 0,
    newOrders,
    inProgress,
  };
};

/* =====================================================
   CAFE: TRANSACTION HISTORY (delivered orders + earnings)
===================================================== */
const transactionView = (o: OrderViewInput) => {
  const v = orderView(o);
  return {
    _id: v._id,
    orderNumber: v.orderNumber,
    earning: o.totalAmount - (o.platformFee ?? 0),
    totalAmount: o.totalAmount,
    paymentMethod: o.paymentMethod,
    student: v.student,
    itemsText: v.items.map((i) => `${i.name} (x${i.quantity})`).join(", "),
    completedAt: o.completedAt ?? null,
    createdAt: o.createdAt,
  };
};

export const getCafeOrderHistoryService = async (
  cafeId: string,
  query: unknown,
) => {
  assertObjectId(cafeId, "cafe ID");

  const { page, limit, skip } = parsePaging(asObject(query));
  const filter = { cafe: oid(cafeId), status: "delivered" as const };

  const [orders, all] = await Promise.all([
    Order.find(filter)
      .sort({ completedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("cafe", "name")
      .populate(STUDENT_POPULATE)
      .lean<OrderViewInput[]>(),
    Order.aggregate<{ earnings: number }>([
      { $match: filter },
      { $group: { _id: null, earnings: { $sum: EARNING } } },
    ]),
  ]);

  const total =
    skip === 0 && orders.length < limit
      ? orders.length
      : await Order.countDocuments(filter);

  return {
    totalEarnings: all[0]?.earnings ?? 0,
    transactions: orders.map(transactionView),
    pagination: pagination(page, limit, total),
  };
};
