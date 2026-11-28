import { Types } from "mongoose";

import { User } from "../models/user.model.js";
import { Student } from "../models/student.model.js";
import { Cafe } from "../models/cafe.model.js";
import { Order } from "../models/order.model.js";
import { Payment } from "../models/payment.model.js";
import { RefreshToken } from "../models/refreshToken.model.js";
import { Session } from "../models/session.model.js";

import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors/app.error.js";
import {
  clearUserCache,
  incrementUserTokenVersion,
  broadcastUserRevocation,
  ROLE_RANK,
} from "../middlewares/authenticate.middleware.js";
import { runWithOptionalTransaction } from "../config/db.config.js";
import { hashPassword, verifyPassword } from "../utils/password/password.js";
import logger, { logSecurityAudit } from "../config/logger.config.js";
import {
  REDIS_TTLS,
  getOrLoadCachedJson,
  redisKeys,
} from "../infrastructure/redis/index.js";

/* =========================================================
   CONSTANTS
========================================================= */
const ACTIVE_STATUSES = ["pending", "confirmed", "preparing", "ready"] as const;

const VALID_ROLES = ["student", "admin", "cafeOwner"] as const;
const VALID_ORDER_STATUSES = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "delivered",
  "cancelled",
  "rejected",
] as const;
const VALID_ORDER_PAYMENT_STATUSES = [
  "pending",
  "paid",
  "failed",
  "refunded",
] as const;
const VALID_ORDER_PAYMENT_METHODS = ["online", "cash"] as const;
const VALID_ORDER_METHODS = ["delivery", "self_pickup"] as const;
const VALID_PAYMENT_STATUSES = [
  "pending",
  "success",
  "failed",
  "refunded",
] as const;
const VALID_PAYMENT_METHODS = [
  "card",
  "upi",
  "wallet",
  "cashfree",
  "cash",
] as const;
const VALID_SETTLEMENT_STATUSES = ["unsettled", "settled"] as const;

type QueryInput = Record<string, unknown>;
type MongoFilter = Record<string, any>;

/* =========================================================
   HELPERS
========================================================= */

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const oid = (id: unknown, name: string): Types.ObjectId => {
  if (typeof id !== "string" || !/^[a-fA-F0-9]{24}$/.test(id)) {
    throw new BadRequestError(`Invalid ${name}`);
  }

  return new Types.ObjectId(id);
};

const getPaging = (query: QueryInput) => {
  const parsePositiveInteger = (value: unknown, fallback: number): number => {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new BadRequestError("Page and limit must be positive integers");
    }

    return parsed;
  };

  const page = parsePositiveInteger(query.page, 1);
  const requestedLimit = parsePositiveInteger(query.limit, 10);
  const limit = Math.min(requestedLimit, 50);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

const pageMeta = (total: number, page: number, limit: number) => ({
  total,
  page,
  limit,
  totalPages: Math.ceil(total / limit),
});

const dateRange = (query: QueryInput, field = "createdAt"): MongoFilter => {
  const from = getString(query.from);
  const to = getString(query.to);

  if (!from && !to) {
    return {};
  }

  const range: {
    $gte?: Date;
    $lte?: Date;
  } = {};

  if (from) {
    const fromDate = new Date(from);

    if (Number.isNaN(fromDate.getTime())) {
      throw new BadRequestError("Invalid from date");
    }

    range.$gte = fromDate;
  }

  if (to) {
    const toDate = new Date(to);

    if (Number.isNaN(toDate.getTime())) {
      throw new BadRequestError("Invalid to date");
    }

    toDate.setHours(23, 59, 59, 999);
    range.$lte = toDate;
  }

  if (range.$gte && range.$lte && range.$gte.getTime() > range.$lte.getTime()) {
    throw new BadRequestError(
      "The from date must not be later than the to date",
    );
  }

  return {
    [field]: range,
  };
};

const searchRegex = (value: unknown): RegExp | undefined => {
  const search = getString(value);

  if (!search) {
    return undefined;
  }

  if (search.length > 100) {
    throw new BadRequestError("Search query cannot exceed 100 characters");
  }

  return new RegExp(escapeRegex(search), "i");
};

/* =========================================================
   DASHBOARD
========================================================= */

export const getDashboardOverviewService = async () => {
  return getOrLoadCachedJson(
    redisKeys.adminDashboard(),
    REDIS_TTLS.ADMIN_DASHBOARD_CACHE_SEC,
    async () => {
      const [
        revenueAgg,
        totalOrders,
        activeNow,
        openCafes,
        newCafeRequests,
        userCountsByRole,
      ] = await Promise.all([
        Payment.aggregate<{ total: number }>([
          {
            $match: {
              status: "success",
            },
          },
          {
            $group: {
              _id: null,
              total: {
                $sum: "$amount",
              },
            },
          },
        ]),

        Order.estimatedDocumentCount(),

        Order.countDocuments({
          status: {
            $in: [...ACTIVE_STATUSES],
          },
        }),

        Cafe.countDocuments({
          isApproved: true,
          isActive: true,
          isOpen: true,
        }),

        Cafe.countDocuments({
          approvalStatus: "pending",
        }),

        User.aggregate<{ _id: string; count: number }>([
          {
            $group: {
              _id: "$role",
              count: { $sum: 1 },
            },
          },
        ]),
      ]);

      let totalUsers = 0;
      let students = 0;
      let cafeOwners = 0;
      for (const row of userCountsByRole) {
        totalUsers += row.count;
        if (row._id === "student") students = row.count;
        else if (row._id === "cafeOwner") cafeOwners = row.count;
      }

      return {
        totalRevenue: revenueAgg[0]?.total ?? 0,
        totalOrders,
        activeNow,
        openCafes,
        allUsers: totalUsers,

        usersBreakdown: {
          students,
          cafeOwners,
        },

        newCafeRequests,
      };
    },
  );
};

/* =========================================================
   USERS
========================================================= */

export const getAllUsersService = async (query: QueryInput) => {
  const { page, limit, skip } = getPaging(query);

  const filter: MongoFilter = {};

  const role = getString(query.role);

  if (role) {
    if (!(VALID_ROLES as readonly string[]).includes(role)) {
      throw new BadRequestError("Invalid role");
    }

    filter.role = role;
  }

  const isActive = getString(query.isActive);

  if (isActive) {
    if (isActive !== "true" && isActive !== "false") {
      throw new BadRequestError("Invalid isActive filter");
    }
    filter.isActive = isActive === "true";
  }

  const regex = searchRegex(query.search);

  if (regex) {
    filter.$or = [{ name: regex }, { email: regex }, { phone: regex }];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("-password -fcmTokens")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    User.countDocuments(filter),
  ]);

  return {
    users,
    pagination: pageMeta(total, page, limit),
  };
};

export const getUserDetailService = async (userId: string) => {
  const id = oid(userId, "user ID");

  const user = await User.findById(id).select("-password -fcmTokens").lean();

  if (!user) {
    throw new NotFoundError("User not found");
  }

  let profile: any = null;

  let stats = {
    totalOrders: 0,
    totalSpent: 0,
    totalSales: 0,
  };

  if (user.role === "student") {
    profile = await Student.findOne({
      user: id,
    }).lean();

    const studentMatchIds = profile ? [profile._id, id] : [id];

    const agg = await Order.aggregate([
      {
        $match: {
          student: { $in: studentMatchIds },
        },
      },
      {
        $group: {
          _id: null,

          totalOrders: {
            $sum: 1,
          },

          totalSpent: {
            $sum: {
              $cond: [
                {
                  $eq: ["$paymentStatus", "paid"],
                },
                "$totalAmount",
                0,
              ],
            },
          },
        },
      },
    ]);

    stats.totalOrders = agg[0]?.totalOrders ?? 0;
    stats.totalSpent = agg[0]?.totalSpent ?? 0;
  }

  if (user.role === "cafeOwner") {
    profile = await Cafe.findOne({
      owner: id,
    }).lean();

    if (profile) {
      const agg = await Order.aggregate([
        {
          $match: {
            cafe: profile._id,
          },
        },
        {
          $group: {
            _id: null,

            totalOrders: {
              $sum: 1,
            },

            totalSales: {
              $sum: {
                $cond: [
                  {
                    $eq: ["$paymentStatus", "paid"],
                  },
                  "$totalAmount",
                  0,
                ],
              },
            },
          },
        },
      ]);

      stats.totalOrders = agg[0]?.totalOrders ?? 0;
      stats.totalSales = agg[0]?.totalSales ?? 0;
    }
  }

  return {
    user,
    profile,
    stats,
  };
};

export const setUserActiveService = async (
  userId: string,
  isActive: boolean,
  adminId: string,
) => {
  if (typeof isActive !== "boolean") {
    throw new BadRequestError("isActive must be a boolean");
  }

  const id = oid(userId, "user ID");
  const currentAdminId = oid(adminId, "admin ID");

  if (id.equals(currentAdminId)) {
    throw new BadRequestError("You cannot change your own active status");
  }

  const targetUser = await User.findById(id).select("role");
  if (!targetUser) {
    throw new NotFoundError("User not found");
  }

  if (ROLE_RANK[targetUser.role] >= ROLE_RANK.admin) {
    logSecurityAudit({
      eventType: "PRIVILEGE_ESCALATION_ATTEMPT",
      userId: id.toString(),
      actorId: currentAdminId.toString(),
      success: false,
      reasonCode: "CANNOT_MODIFY_ADMIN_STATUS",
    });
    throw new ForbiddenError("Insufficient privileges to manage this user");
  }

  let newTokenVersion: number | undefined;
  const user = await runWithOptionalTransaction(async (txSession) => {
    const sessionOpt = txSession ? { session: txSession } : {};
    const updatedUser = await User.findByIdAndUpdate(
      id,
      {
        $set: {
          isActive,
        },
      },
      {
        returnDocument: "after",
        runValidators: true,
        ...sessionOpt,
      },
    ).select("-password -fcmTokens");

    if (!updatedUser) {
      throw new NotFoundError("User not found");
    }

    if (!isActive) {
      const now = new Date();
      await Session.updateMany(
        { user: id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revokedAt: now,
            revokedReason: "account_deactivated",
          },
        },
        sessionOpt,
      );
      await RefreshToken.updateMany(
        {
          user: id,
          status: { $ne: "revoked" },
        },
        {
          $set: {
            status: "revoked",
            isRevoked: true,
            revokedAt: now,
            revokedReason: "account_deactivated",
          },
        },
        sessionOpt,
      );
      newTokenVersion = await incrementUserTokenVersion(id.toString(), txSession);
    }

    return updatedUser;
  });

  if (!isActive && newTokenVersion !== undefined) {
    await broadcastUserRevocation(
      id.toString(),
      newTokenVersion,
      "account_deactivated",
    );
  } else {
    await clearUserCache(id.toString());
  }

  logSecurityAudit({
    eventType: isActive ? "ACCOUNT_REACTIVATED" : "ACCOUNT_DEACTIVATED",
    userId: id.toString(),
    actorId: currentAdminId.toString(),
    success: true,
    reasonCode: isActive ? "ADMIN_ACTIVATED_USER" : "ADMIN_DEACTIVATED_USER",
  });
  logger.info("Admin updated user active status", {
    targetUserId: id.toString(),
    adminId: currentAdminId.toString(),
    isActive,
    operation: "ADMIN_SET_USER_ACTIVE",
  });

  return user;
};

export const adminForceLogoutService = async (
  targetUserId: string,
  adminId: string,
  requestId?: string,
): Promise<{ revokedSessions: number }> => {
  const id = oid(targetUserId, "user ID");
  const currentAdminId = oid(adminId, "admin ID");

  if (id.equals(currentAdminId)) {
    throw new BadRequestError(
      "Use /auth/logout-all to revoke your own sessions",
    );
  }

  const targetUser = await User.findById(id).select("role");
  if (!targetUser) {
    throw new NotFoundError("User not found");
  }

  if (ROLE_RANK[targetUser.role] >= ROLE_RANK.admin) {
    logSecurityAudit({
      eventType: "PRIVILEGE_ESCALATION_ATTEMPT",
      userId: id.toString(),
      actorId: currentAdminId.toString(),
      requestId,
      success: false,
      reasonCode: "CANNOT_FORCE_LOGOUT_ADMIN",
    });
    throw new ForbiddenError(
      "Insufficient privileges to revoke sessions for this user",
    );
  }

  const { revokedSessions, newTokenVersion } = await runWithOptionalTransaction(
    async (txSession) => {
      const sessionOpt = txSession ? { session: txSession } : {};
      const now = new Date();
      const sessionResult = await Session.updateMany(
        { user: id, status: "ACTIVE" },
        {
          $set: {
            status: "REVOKED",
            revokedAt: now,
            revokedReason: "admin_forced_revocation",
          },
        },
        sessionOpt,
      );

      await RefreshToken.updateMany(
        { user: id, status: { $ne: "revoked" } },
        {
          $set: {
            status: "revoked",
            isRevoked: true,
            revokedAt: now,
            revokedReason: "admin_forced_revocation",
          },
        },
        sessionOpt,
      );

      const nextVersion = await incrementUserTokenVersion(
        id.toString(),
        txSession,
      );

      return {
        revokedSessions: sessionResult.modifiedCount,
        newTokenVersion: nextVersion,
      };
    },
  );

  await broadcastUserRevocation(
    id.toString(),
    newTokenVersion,
    "admin_forced_revocation",
  );

  logSecurityAudit({
    eventType: "ADMIN_FORCED_SESSION_REVOCATION",
    userId: id.toString(),
    actorId: currentAdminId.toString(),
    requestId,
    success: true,
    reasonCode: "ADMIN_REVOKED_USER_SESSIONS",
    metadata: { revokedSessions },
  });

  return { revokedSessions };
};

/* =========================================================
   ORDERS
========================================================= */
const orderPopulate = [
  {
    path: "student",
    select: "rollNumber course semester collegeName user",
    populate: {
      path: "user",
      select: "name email phone profileImage",
    },
  },
  {
    path: "cafe",
    select: "name code contactNumber email city logo",
  },
  {
    path: "paymentId",
    select:
      "paymentId method status amount transactionId paidAt commission cafeEarning settlementStatus",
  },
];

export const getAllOrdersService = async (query: QueryInput) => {
  const { page, limit, skip } = getPaging(query);

  const filter: MongoFilter = {
    ...dateRange(query),
  };

  const status = getString(query.status);
  const paymentStatus = getString(query.paymentStatus);
  const paymentMethod = getString(query.paymentMethod);
  const orderMethod = getString(query.orderMethod);

  if (status) {
    if (!(VALID_ORDER_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestError("Invalid order status filter");
    }
    filter.status = status;
  }
  if (paymentStatus) {
    if (
      !(VALID_ORDER_PAYMENT_STATUSES as readonly string[]).includes(
        paymentStatus,
      )
    ) {
      throw new BadRequestError("Invalid paymentStatus filter");
    }
    filter.paymentStatus = paymentStatus;
  }
  if (paymentMethod) {
    if (
      !(VALID_ORDER_PAYMENT_METHODS as readonly string[]).includes(
        paymentMethod,
      )
    ) {
      throw new BadRequestError("Invalid paymentMethod filter");
    }
    filter.paymentMethod = paymentMethod;
  }
  if (orderMethod) {
    if (!(VALID_ORDER_METHODS as readonly string[]).includes(orderMethod)) {
      throw new BadRequestError("Invalid orderMethod filter");
    }
    filter.orderMethod = orderMethod;
  }

  const cafe = getString(query.cafe);
  const student = getString(query.student);

  if (cafe) {
    filter.cafe = oid(cafe, "cafe ID");
  }

  if (student) {
    filter.student = oid(student, "student ID");
  }

  const regex = searchRegex(query.search);

  if (regex) {
    filter.orderNumber = regex;
  }

  const isUnfiltered = Object.keys(filter).length === 0;

  const rawOrders = await Order.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const studentIds = Array.from(new Set(rawOrders.map((o) => String(o.student))));
  const cafeIds = Array.from(new Set(rawOrders.map((o) => String(o.cafe))));
  const paymentIds = Array.from(
    new Set(rawOrders.map((o) => o.paymentId).filter(Boolean).map((id) => String(id))),
  );

  const [students, cafes, payments, total] = await Promise.all([
    studentIds.length
      ? Student.find({ _id: { $in: studentIds } })
          .select("rollNumber course semester collegeName user")
          .lean()
      : Promise.resolve([]),
    cafeIds.length
      ? Cafe.find({ _id: { $in: cafeIds } })
          .select("name code contactNumber email city logo")
          .lean()
      : Promise.resolve([]),
    paymentIds.length
      ? Payment.find({ _id: { $in: paymentIds } })
          .select(
            "paymentId method status amount transactionId paidAt commission cafeEarning settlementStatus",
          )
          .lean()
      : Promise.resolve([]),
    skip === 0 && rawOrders.length < limit
      ? Promise.resolve(rawOrders.length)
      : isUnfiltered
        ? Order.estimatedDocumentCount()
        : Order.countDocuments(filter),
  ]);

  const userIds = Array.from(
    new Set(students.map((s) => s.user).filter(Boolean).map((id) => String(id))),
  );
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } })
        .select("name email phone profileImage")
        .lean()
    : [];

  const userById = new Map(users.map((u) => [String(u._id), u]));
  const studentById = new Map(
    students.map((s) => [
      String(s._id),
      { ...s, user: userById.get(String(s.user)) ?? s.user },
    ]),
  );
  const cafeById = new Map(cafes.map((c) => [String(c._id), c]));
  const paymentById = new Map(payments.map((p) => [String(p._id), p]));

  const orders = rawOrders.map((o) => ({
    ...o,
    student: studentById.get(String(o.student)) ?? o.student,
    cafe: cafeById.get(String(o.cafe)) ?? o.cafe,
    ...(o.paymentId
      ? { paymentId: paymentById.get(String(o.paymentId)) ?? o.paymentId }
      : {}),
  }));

  return {
    orders,
    pagination: pageMeta(total, page, limit),
  };
};

export const getOrderDetailService = async (orderId: string) => {
  const id = oid(orderId, "order ID");

  const order = await Order.findById(id).populate(orderPopulate).lean();

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  return order;
};

/* =========================================================
   PAYMENTS
========================================================= */

const paymentPopulate = [
  {
    path: "order",
    select: "orderNumber status orderMethod totalAmount items createdAt",
  },
  {
    path: "student",
    select: "rollNumber user",
    populate: {
      path: "user",
      select: "name email phone",
    },
  },
  {
    path: "cafe",
    select: "name code city",
  },
];

export const getAllPaymentsService = async (query: QueryInput) => {
  const { page, limit, skip } = getPaging(query);

  const base: MongoFilter = {
    ...dateRange(query),
  };

  const method = getString(query.method);
  const settlementStatus = getString(query.settlementStatus);

  if (method) {
    if (!(VALID_PAYMENT_METHODS as readonly string[]).includes(method)) {
      throw new BadRequestError("Invalid payment method filter");
    }
    base.method = method;
  }

  if (settlementStatus) {
    if (
      !(VALID_SETTLEMENT_STATUSES as readonly string[]).includes(
        settlementStatus,
      )
    ) {
      throw new BadRequestError("Invalid settlementStatus filter");
    }
    base.settlementStatus = settlementStatus;
  }

  const cafe = getString(query.cafe);
  const student = getString(query.student);

  if (cafe) {
    base.cafe = oid(cafe, "cafe ID");
  }

  if (student) {
    base.student = oid(student, "student ID");
  }

  const regex = searchRegex(query.search);

  if (regex) {
    base.$or = [{ paymentId: regex }, { transactionId: regex }];
  }

  const filter: MongoFilter = {
    ...base,
  };

  const status = getString(query.status);

  if (status) {
    if (!(VALID_PAYMENT_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestError("Invalid payment status filter");
    }
    filter.status = status;
  }

  const [payments, total, summaryAgg] = await Promise.all([
    Payment.find(filter)
      .populate(paymentPopulate)
      .select("-gatewayResponse")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    Payment.countDocuments(filter),

    Payment.aggregate([
      {
        $match: base,
      },
      {
        $group: {
          _id: "$status",
          count: {
            $sum: 1,
          },
          amount: {
            $sum: "$amount",
          },
        },
      },
    ]),
  ]);

  const pick = (statusValue: string) =>
    summaryAgg.find((item) => item._id === statusValue);

  return {
    summary: {
      totalCollection: pick("success")?.amount ?? 0,
      successful: pick("success")?.count ?? 0,
      pending: pick("pending")?.count ?? 0,
      failed: pick("failed")?.count ?? 0,
      refunded: pick("refunded")?.count ?? 0,
    },

    payments,

    pagination: pageMeta(total, page, limit),
  };
};

export const getPaymentDetailService = async (idOrPaymentId: string) => {
  const value = getString(idOrPaymentId);

  if (!value) {
    throw new BadRequestError("Payment ID is required");
  }

  const filter = /^[a-fA-F0-9]{24}$/.test(value)
    ? { _id: new Types.ObjectId(value) }
    : { paymentId: value };

  const payment = await Payment.findOne(filter)
    .populate(paymentPopulate)
    .lean();

  if (!payment) {
    throw new NotFoundError("Payment not found");
  }

  return payment;
};

/* =========================================================
   ADMIN PROFILE
========================================================= */

export const getAdminProfileService = async (adminId: string) => {
  const id = oid(adminId, "admin ID");

  const admin = await User.findOne({
    _id: id,
    role: "admin",
  })
    .select("-password -fcmTokens")
    .lean();

  if (!admin) {
    throw new NotFoundError("Admin not found");
  }

  return admin;
};

export const updateAdminProfileService = async (
  adminId: string,
  body: QueryInput,
) => {
  const id = oid(adminId, "admin ID");

  const update: {
    name?: string;
    phone?: string;
    profileImage?: string;
  } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      throw new BadRequestError("Invalid name");
    }

    const name = body.name.trim();

    if (name.length < 2 || name.length > 100) {
      throw new BadRequestError("Name must be between 2 and 100 characters");
    }

    update.name = name;
  }

  if (body.phone !== undefined) {
    if (typeof body.phone !== "string") {
      throw new BadRequestError("Invalid phone number");
    }

    const phone = body.phone.trim();

    if (!/^[0-9+\-\s]{7,15}$/.test(phone)) {
      throw new BadRequestError("Invalid phone number");
    }

    update.phone = phone;
  }

  if (body.profileImage !== undefined) {
    if (typeof body.profileImage !== "string") {
      throw new BadRequestError("Invalid profile image");
    }

    const trimmedImg = body.profileImage.trim();
    if (trimmedImg.length > 500) {
      throw new BadRequestError("Profile image URL must not exceed 500 characters");
    }
    if (trimmedImg) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(trimmedImg);
      } catch {
        throw new BadRequestError("Invalid profile image URL");
      }
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        throw new BadRequestError("Profile image URL must use http or https");
      }
    }

    update.profileImage = trimmedImg;
  }

  if (Object.keys(update).length === 0) {
    throw new BadRequestError("Nothing to update");
  }

  const admin = await User.findOneAndUpdate(
    {
      _id: id,
      role: "admin",
    },
    {
      $set: update,
    },
    {
      new: true,
      runValidators: true,
    },
  ).select("-password -fcmTokens");

  if (!admin) {
    throw new NotFoundError("Admin not found");
  }

  await clearUserCache(id.toString());

  logger.info("Admin profile updated", {
    adminId: id.toString(),
    updatedFields: Object.keys(update),
    operation: "ADMIN_UPDATE_PROFILE",
  });

  return admin;
};

/* =========================================================
   CHANGE ADMIN PASSWORD
========================================================= */
export const changeAdminPasswordService = async (
  adminId: string,
  body: QueryInput,
): Promise<{ message: string }> => {
  const id = oid(adminId, "admin ID");

  const currentPassword = body.currentPassword;
  const newPassword = body.newPassword;

  if (
    typeof currentPassword !== "string" ||
    typeof newPassword !== "string" ||
    !currentPassword ||
    !newPassword
  ) {
    throw new BadRequestError("currentPassword and newPassword are required");
  }

  const admin = await User.findOne({
    _id: id,
    role: "admin",
  }).select("+password");

  if (!admin) {
    throw new NotFoundError("Admin not found");
  }

  if (!admin.password) {
    throw new BadRequestError("Password login is not enabled for this account");
  }

  const passwordMatches = await verifyPassword(currentPassword, admin.password);

  if (!passwordMatches) {
    logSecurityAudit({
      eventType: "ADMIN_LOGIN_FAILURE",
      userId: admin._id.toString(),
      success: false,
      reasonCode: "CHANGE_PASSWORD_WRONG_CURRENT",
    });
    throw new BadRequestError("Current password is incorrect");
  }

  const samePassword = await verifyPassword(newPassword, admin.password);

  if (samePassword) {
    throw new BadRequestError(
      "New password must be different from the current password",
    );
  }

  admin.password = await hashPassword(newPassword);

  const newTokenVersion = await runWithOptionalTransaction(async (txSession) => {
    const sessionOpt = txSession ? { session: txSession } : {};
    await admin.save(sessionOpt);

    const now = new Date();
    await Session.updateMany(
      {
        user: admin._id,
        status: "ACTIVE",
      },
      {
        $set: {
          status: "REVOKED",
          revokedAt: now,
          revokedReason: "password_changed",
        },
      },
      sessionOpt,
    );

    await RefreshToken.updateMany(
      {
        user: admin._id,
        status: { $ne: "revoked" },
      },
      {
        $set: {
          status: "revoked",
          isRevoked: true,
          revokedAt: now,
          revokedReason: "password_changed",
        },
      },
      sessionOpt,
    );

    return incrementUserTokenVersion(admin._id.toString(), txSession);
  });

  await broadcastUserRevocation(
    admin._id.toString(),
    newTokenVersion,
    "password_changed",
  );

  logSecurityAudit({
    eventType: "ADMIN_PASSWORD_CHANGED",
    userId: admin._id.toString(),
    actorId: admin._id.toString(),
    success: true,
    reasonCode: "ADMIN_PASSWORD_ROTATED",
  });
  logger.info("Admin password updated and sessions revoked", {
    adminId: admin._id.toString(),
    operation: "ADMIN_CHANGE_PASSWORD",
  });

  return {
    message: "Password changed successfully. Please log in again.",
  };
};
