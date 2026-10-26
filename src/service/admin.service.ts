import { Types } from "mongoose";
import bcrypt from "bcryptjs";

import { User } from "../models/user.model";
import { Student } from "../models/student.model";
import { Cafe } from "../models/cafe.model";
import { Order } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { RefreshToken } from "../models/refreshToken.model";

import { BadRequestError, NotFoundError } from "../utils/errors/app.error";

/* =========================================================
   CONSTANTS
========================================================= */
const ACTIVE_STATUSES = ["pending", "confirmed", "preparing", "ready"] as const;

const VALID_ROLES = ["student", "admin", "cafeOwner"] as const;

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
  const [
    revenueAgg,
    totalOrders,
    activeNow,
    openCafes,
    totalUsers,
    newCafeRequests,
    students,
    cafeOwners,
  ] = await Promise.all([
    Payment.aggregate([
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

    Order.countDocuments(),

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

    User.countDocuments(),

    Cafe.countDocuments({
      approvalStatus: "pending",
    }),

    User.countDocuments({
      role: "student",
    }),

    User.countDocuments({
      role: "cafeOwner",
    }),
  ]);

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

  if (isActive === "true" || isActive === "false") {
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

    if (profile) {
      const agg = await Order.aggregate([
        {
          $match: {
            student: profile._id,
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

  const user = await User.findByIdAndUpdate(
    id,
    {
      $set: {
        isActive,
      },
    },
    {
      new: true,
      runValidators: true,
    },
  ).select("-password -fcmTokens");

  if (!user) {
    throw new NotFoundError("User not found");
  }

  if (!isActive) {
    await RefreshToken.deleteMany({
      user: id,
    });
  }

  return user;
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

  if (status) filter.status = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  if (orderMethod) filter.orderMethod = orderMethod;

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

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate(orderPopulate)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    Order.countDocuments(filter),
  ]);

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
    base.method = method;
  }

  if (settlementStatus) {
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

    update.profileImage = body.profileImage.trim();
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

  if (newPassword.length < 8 || newPassword.length > 128) {
    throw new BadRequestError(
      "New password must be between 8 and 128 characters",
    );
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

  const passwordMatches = await bcrypt.compare(currentPassword, admin.password);

  if (!passwordMatches) {
    throw new BadRequestError("Current password is incorrect");
  }

  const samePassword = await bcrypt.compare(newPassword, admin.password);

  if (samePassword) {
    throw new BadRequestError(
      "New password must be different from the current password",
    );
  }

  admin.password = await bcrypt.hash(newPassword, 12);

  await admin.save();

  await RefreshToken.deleteMany({
    user: admin._id,
  });

  return {
    message: "Password changed successfully. Please log in again.",
  };
};
