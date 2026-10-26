import { Router } from "express";
import {
  authenticate,
  authorize,
} from "../../middlewares/authenticate.middleware";

import {
  getDashboardOverview,
  getAllUsers,
  getUserDetail,
  setUserActive,
  getAllOrders,
  getOrderDetail,
  getAllPayments,
  getPaymentDetail,
  getAdminProfile,
  updateAdminProfile,
  changeAdminPassword,
} from "../../controllers/admin.controller";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Admin panel APIs (sirf admin role ke liye)
 *
 * components:
 *   parameters:
 *     PageParam:
 *       in: query
 *       name: page
 *       schema: { type: integer, minimum: 1, default: 1 }
 *       description: Page number
 *     LimitParam:
 *       in: query
 *       name: limit
 *       schema: { type: integer, minimum: 1, maximum: 50, default: 10 }
 *       description: Items per page (max 50)
 *     FromParam:
 *       in: query
 *       name: from
 *       schema: { type: string, format: date, example: "2026-10-01" }
 *       description: Start date (inclusive)
 *     ToParam:
 *       in: query
 *       name: to
 *       schema: { type: string, format: date, example: "2026-10-31" }
 *       description: End date (inclusive)
 *   schemas:
 *     Pagination:
 *       type: object
 *       properties:
 *         total: { type: integer, example: 120 }
 *         page: { type: integer, example: 1 }
 *         limit: { type: integer, example: 10 }
 *         totalPages: { type: integer, example: 12 }
 *     AdminUser:
 *       type: object
 *       properties:
 *         _id: { type: string, example: "665f1c2e8b3a4c0012a3b4c5" }
 *         name: { type: string, example: "Admin User" }
 *         email: { type: string, example: "admin@gravly.com" }
 *         role: { type: string, enum: [student, admin, cafeOwner] }
 *         authProvider: { type: string, enum: [google, apple, password] }
 *         phone: { type: string, example: "9876543210" }
 *         profileImage: { type: string }
 *         isVerified: { type: boolean }
 *         isActive: { type: boolean }
 *         createdAt: { type: string, format: date-time }
 *         updatedAt: { type: string, format: date-time }
 *     SuccessResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean, example: true }
 *         message: { type: string }
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean, example: false }
 *         message: { type: string }
 */

// Sab admin routes: pehle login, phir admin role check
router.use(authenticate, authorize("admin"));

/* =========================================================
   DASHBOARD
========================================================= */

/**
 * @swagger
 * /admin/dashboard:
 *   get:
 *     summary: Dashboard overview (revenue, orders, cafes, users)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalRevenue: { type: number, example: 3 }
 *                     totalOrders: { type: integer, example: 3 }
 *                     activeNow: { type: integer, example: 0 }
 *                     openCafes: { type: integer, example: 8 }
 *                     allUsers: { type: integer, example: 120 }
 *                     usersBreakdown:
 *                       type: object
 *                       properties:
 *                         students: { type: integer, example: 110 }
 *                         cafeOwners: { type: integer, example: 9 }
 *                     newCafeRequests: { type: integer, example: 5 }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden (admin only) }
 */
router.get("/dashboard", getDashboardOverview);

/* =========================================================
   USERS
========================================================= */

/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: Saare users ki list (filters ke saath)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - $ref: '#/components/parameters/LimitParam'
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [student, admin, cafeOwner] }
 *       - in: query
 *         name: isActive
 *         schema: { type: string, enum: ["true", "false"] }
 *       - in: query
 *         name: search
 *         schema: { type: string, maxLength: 100 }
 *         description: Name, email ya phone se search
 *     responses:
 *       200:
 *         description: Users fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     users:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/AdminUser' }
 *                     pagination: { $ref: '#/components/schemas/Pagination' }
 *       400: { description: Invalid query parameter }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get("/users", getAllUsers);

/**
 * @swagger
 * /admin/users/{userId}:
 *   get:
 *     summary: Ek user ki poori detail (profile + stats)
 *     description: Student ke liye student profile aur totalSpent, cafeOwner ke liye cafe profile aur totalSales milta hai.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: User details fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user: { $ref: '#/components/schemas/AdminUser' }
 *                     profile:
 *                       type: object
 *                       nullable: true
 *                       description: Student ya Cafe document
 *                     stats:
 *                       type: object
 *                       properties:
 *                         totalOrders: { type: integer }
 *                         totalSpent: { type: number }
 *                         totalSales: { type: number }
 *       400: { description: Invalid user ID }
 *       404: { description: User not found }
 */
router.get("/users/:userId", getUserDetail);

/**
 * @swagger
 * /admin/users/{userId}/status:
 *   patch:
 *     summary: User ko activate ya deactivate karo
 *     description: Deactivate karne par user ke refresh tokens delete ho jaate hain. Admin apna khud ka status change nahi kar sakta.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isActive]
 *             properties:
 *               isActive: { type: boolean, example: false }
 *     responses:
 *       200:
 *         description: User status updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data: { $ref: '#/components/schemas/AdminUser' }
 *       400: { description: Validation error }
 *       404: { description: User not found }
 */
router.patch("/users/:userId/status", setUserActive);

/* =========================================================
   ORDERS
========================================================= */

/**
 * @swagger
 * /admin/orders:
 *   get:
 *     summary: Saare orders ki list (student, cafe aur payment ke saath)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - $ref: '#/components/parameters/LimitParam'
 *       - $ref: '#/components/parameters/FromParam'
 *       - $ref: '#/components/parameters/ToParam'
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, confirmed, preparing, ready, delivered, cancelled, rejected]
 *       - in: query
 *         name: paymentStatus
 *         schema: { type: string, enum: [pending, paid, failed, refunded] }
 *       - in: query
 *         name: paymentMethod
 *         schema: { type: string, enum: [online, cash] }
 *       - in: query
 *         name: orderMethod
 *         schema: { type: string, enum: [delivery, self_pickup] }
 *       - in: query
 *         name: cafe
 *         schema: { type: string }
 *         description: Cafe ID
 *       - in: query
 *         name: student
 *         schema: { type: string }
 *         description: Student ID (User ID nahi, Student document ID)
 *       - in: query
 *         name: search
 *         schema: { type: string, maxLength: 100 }
 *         description: Order number se search (e.g. 1868)
 *     responses:
 *       200:
 *         description: Orders fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     orders:
 *                       type: array
 *                       items: { type: object }
 *                     pagination: { $ref: '#/components/schemas/Pagination' }
 *       400: { description: Invalid query parameter }
 */
router.get("/orders", getAllOrders);

/**
 * @swagger
 * /admin/orders/{orderId}:
 *   get:
 *     summary: Ek order ki poori detail
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Order details fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   description: Order with populated student, cafe and payment
 *       400: { description: Invalid order ID }
 *       404: { description: Order not found }
 */
router.get("/orders/:orderId", getOrderDetail);

/* =========================================================
   PAYMENTS
========================================================= */

/**
 * @swagger
 * /admin/payments:
 *   get:
 *     summary: Saare payments ki list aur summary
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - $ref: '#/components/parameters/LimitParam'
 *       - $ref: '#/components/parameters/FromParam'
 *       - $ref: '#/components/parameters/ToParam'
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, success, failed, refunded] }
 *       - in: query
 *         name: method
 *         schema: { type: string, enum: [card, upi, wallet, cashfree, cash] }
 *       - in: query
 *         name: settlementStatus
 *         schema: { type: string, enum: [unsettled, settled] }
 *       - in: query
 *         name: cafe
 *         schema: { type: string }
 *       - in: query
 *         name: student
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string, maxLength: 100 }
 *         description: paymentId (pay_1868) ya transactionId se search
 *     responses:
 *       200:
 *         description: Payments fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     summary:
 *                       type: object
 *                       description: Status filter ko chhodkar baaki filters follow karta hai
 *                       properties:
 *                         totalCollection: { type: number, example: 4 }
 *                         successful: { type: integer, example: 2 }
 *                         pending: { type: integer, example: 1 }
 *                         failed: { type: integer, example: 0 }
 *                         refunded: { type: integer, example: 0 }
 *                     payments:
 *                       type: array
 *                       items: { type: object }
 *                     pagination: { $ref: '#/components/schemas/Pagination' }
 *       400: { description: Invalid query parameter }
 */
router.get("/payments", getAllPayments);

/**
 * @swagger
 * /admin/payments/{paymentId}:
 *   get:
 *     summary: Ek payment ki poori detail
 *     description: Mongo _id ya paymentId (jaise pay_1868), dono chalte hain. gatewayResponse bhi milta hai.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema: { type: string, example: "pay_1868" }
 *     responses:
 *       200:
 *         description: Payment details fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data: { type: object }
 *       404: { description: Payment not found }
 */
router.get("/payments/:paymentId", getPaymentDetail);

/* =========================================================
   ADMIN PROFILE
========================================================= */

/**
 * @swagger
 * /admin/profile:
 *   get:
 *     summary: Admin ki apni profile
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Admin profile fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data: { $ref: '#/components/schemas/AdminUser' }
 *       404: { description: Admin not found }
 *   patch:
 *     summary: Admin apni details update kare (name, phone, profileImage)
 *     description: Kam se kam ek field bhejna zaroori hai.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 100, example: "Admin User" }
 *               phone: { type: string, example: "9876543210" }
 *               profileImage: { type: string, example: "https://example.com/profile.jpg" }
 *     responses:
 *       200:
 *         description: Admin profile updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data: { $ref: '#/components/schemas/AdminUser' }
 *       400: { description: Validation error / Nothing to update }
 *       404: { description: Admin not found }
 */
router.get("/profile", getAdminProfile);
router.patch("/profile", updateAdminProfile);

/**
 * @swagger
 * /admin/change-password:
 *   patch:
 *     summary: Admin apna password change kare
 *     description: Password change hone par admin ke saare refresh tokens delete ho jaate hain, isliye dobara login karna padega.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string, format: password, example: "OldPassword123" }
 *               newPassword: { type: string, format: password, minLength: 8, maxLength: 128, example: "NewPassword456" }
 *     responses:
 *       200:
 *         description: Password changed successfully
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SuccessResponse' }
 *       400: { description: Validation error / Current password galat hai }
 *       404: { description: Admin not found }
 */
router.patch("/change-password", changeAdminPassword);

export default router;
