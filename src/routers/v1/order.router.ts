import { Router } from "express";

import {
  placeOrder,
  getMyOrders,
  getMyOrder,
  cancelMyOrder,
  getCafeOrders,
  getCafeOrder,
  getCafeOrderSummary,
  getCafeOrderHistory,
  acceptOrder,
  rejectOrder,
  updateOrderStatus,
} from "../../controllers/order.controller.js";

import {
  authenticate,
  authorize,
} from "../../middlewares/authenticate.middleware.js";
import {
  orderReadLimiter,
  orderWriteLimiter,
} from "../../middlewares/rateLimiter.middleware.js";

const STUDENT = "student";
const CAFE_OWNER = "cafeOwner";

const router = Router();

/**
 * Both roles share this router, so the role check is set per route.
 * Cafe owner routes are written FIRST so that "/cafe" is never
 * treated as an :orderId by the student routes.
 */
const cafeOnly = [authenticate, authorize(CAFE_OWNER)];
const studentOnly = [authenticate, authorize(STUDENT)];

/**
 * @openapi
 * tags:
 *   - name: Orders
 *     description: Student order management
 *   - name: Cafe Orders
 *     description: Order management for cafe owners
 */

/* =====================================================
   CAFE OWNER ROUTES
===================================================== */

/**
 * @openapi
 * /orders/cafe:
 *   get:
 *     tags:
 *       - Cafe Orders
 *     summary: Active orders of my cafe
 *     description: |
 *       Default returns all running orders (pending, confirmed, preparing, ready), newest first.
 *       Cash orders and paid online orders only. Unpaid online orders are hidden.
 *       Poll this every 10 to 15 seconds to show new orders.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         description: Show only one status
 *         schema:
 *           type: string
 *           enum: [pending, confirmed, preparing, ready, delivered, cancelled, rejected]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 10
 *     responses:
 *       200:
 *         description: Orders retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Cafe orders fetched successfully }
 *                 data: { $ref: '#/components/schemas/OrderListView' }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 */
router.get("/cafe", ...cafeOnly, orderReadLimiter, getCafeOrders);

/**
 * @openapi
 * /orders/cafe/summary:
 *   get:
 *     tags:
 *       - Cafe Orders
 *     summary: Home screen summary
 *     description: |
 *       Returns todayEarnings and todayOrders (delivered today, Indian time),
 *       newOrders (waiting for accept or reject) and inProgress (accepted, not delivered yet).
 *       Earnings = order total minus platform fee.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Summary retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Summary fetched successfully }
 *                 data: { $ref: '#/components/schemas/CafeOrderSummaryView' }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 */
router.get("/cafe/summary", ...cafeOnly, orderReadLimiter, getCafeOrderSummary);

/**
 * @openapi
 * /orders/cafe/history:
 *   get:
 *     tags:
 *       - Cafe Orders
 *     summary: Transaction history (all time)
 *     description: |
 *       Delivered orders with the cafe's earning for each, newest first.
 *       Also returns totalEarnings for all time.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 10
 *     responses:
 *       200:
 *         description: Transaction history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Transaction history fetched successfully }
 *                 data: { $ref: '#/components/schemas/CafeOrderHistoryView' }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 */
router.get("/cafe/history", ...cafeOnly, orderReadLimiter, getCafeOrderHistory);

/**
 * @openapi
 * /orders/cafe/{orderId}:
 *   get:
 *     tags:
 *       - Cafe Orders
 *     summary: Order details (cafe)
 *     description: Includes items, student name and the delivery address for delivery orders.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         description: MongoDB order ID
 *         schema:
 *           type: string
 *           pattern: '^[0-9a-fA-F]{24}$'
 *           example: 507f1f77bcf86cd799439011
 *     responses:
 *       200:
 *         description: Order details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Order details fetched successfully }
 *                 data: { $ref: '#/components/schemas/OrderView' }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 */
router.get("/cafe/:orderId", ...cafeOnly, orderReadLimiter, getCafeOrder);

/**
 * @openapi
 * /orders/cafe/{orderId}/accept:
 *   patch:
 *     tags:
 *       - Cafe Orders
 *     summary: Accept an order (pending to confirmed)
 *     description: No body needed. Only pending orders can be accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[0-9a-fA-F]{24}$'
 *     responses:
 *       200:
 *         description: Order accepted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Order accepted successfully }
 *                 data: { $ref: '#/components/schemas/OrderView' }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *       500:
 *         description: Internal server error
 */
router.patch("/cafe/:orderId/accept", ...cafeOnly, orderWriteLimiter, acceptOrder);

/**
 * @openapi
 * /orders/cafe/{orderId}/reject:
 *   patch:
 *     tags:
 *       - Cafe Orders
 *     summary: Reject an order (pending to rejected)
 *     description: |
 *       Stock is released. A paid online order is refunded automatically.
 *       The reason is optional. Without it, "Rejected by the cafe" is saved.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[0-9a-fA-F]{24}$'
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 200
 *                 example: Item not available today
 *     responses:
 *       200:
 *         description: Order rejected successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Order rejected successfully }
 *                 data: { $ref: '#/components/schemas/OrderView' }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *       500:
 *         description: Internal server error
 */
router.patch("/cafe/:orderId/reject", ...cafeOnly, orderWriteLimiter, rejectOrder);

/**
 * @openapi
 * /orders/cafe/{orderId}/status:
 *   patch:
 *     tags:
 *       - Cafe Orders
 *     summary: Move an order forward
 *     description: |
 *       Allowed moves:
 *       confirmed to preparing, confirmed or preparing to ready, ready to delivered.
 *       A cash order becomes paid when it is delivered.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[0-9a-fA-F]{24}$'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [preparing, ready, delivered]
 *     responses:
 *       200:
 *         description: Order status updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Order status updated successfully }
 *                 data: { $ref: '#/components/schemas/OrderView' }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *       500:
 *         description: Internal server error
 */
router.patch("/cafe/:orderId/status", ...cafeOnly, orderWriteLimiter, updateOrderStatus);

/* =====================================================
   STUDENT ROUTES
===================================================== */

/**
 * @openapi
 * /orders:
 *   post:
 *     tags:
 *       - Orders
 *     summary: Place an order from the active cart
 *     description: |
 *       Creates an order using the authenticated student's active cart.
 *       Product prices and totals are calculated on the server.
 *       No request body is required.
 *       For online payments, initiate payment using POST /payments/initiate.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema: { type: string }
 *         description: Optional idempotency key to avoid duplicate order placement on retries
 *     responses:
 *       201:
 *         description: Order placed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Order placed successfully }
 *                 data: { $ref: '#/components/schemas/OrderView' }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *       500:
 *         description: Internal server error
 */
router.post("/", ...studentOnly, orderWriteLimiter, placeOrder);

/**
 * @openapi
 * /orders:
 *   get:
 *     tags:
 *       - Orders
 *     summary: Get my orders
 *     description: Returns the authenticated student's orders with pagination.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         description: Filter orders by status category
 *         schema:
 *           type: string
 *           enum: [active, history]
 *           default: active
 *       - in: query
 *         name: page
 *         description: Page number
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: limit
 *         description: Number of orders per page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 10
 *     responses:
 *       200:
 *         description: Orders retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Cafe orders fetched successfully }
 *                 data: { $ref: '#/components/schemas/OrderListView' }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       500:
 *         description: Internal server error
 */
router.get("/", ...studentOnly, orderReadLimiter, getMyOrders);

/**
 * @openapi
 * /orders/{orderId}:
 *   get:
 *     tags:
 *       - Orders
 *     summary: Get my order details
 *     description: Retrieves an order belonging to the authenticated student.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         description: MongoDB order ID
 *         schema:
 *           type: string
 *           pattern: '^[0-9a-fA-F]{24}$'
 *           example: 507f1f77bcf86cd799439011
 *     responses:
 *       200:
 *         description: Order details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Order details fetched successfully }
 *                 data: { $ref: '#/components/schemas/OrderView' }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 */
router.get("/:orderId", ...studentOnly, orderReadLimiter, getMyOrder);

/**
 * @openapi
 * /orders/{orderId}/cancel:
 *   patch:
 *     tags:
 *       - Orders
 *     summary: Cancel my order
 *     description: |
 *       Cancels an order while it is still pending (before the cafe accepts it).
 *       Stock is released. If the order was already paid online, it is refunded.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         description: MongoDB order ID
 *         schema:
 *           type: string
 *           pattern: '^[0-9a-fA-F]{24}$'
 *           example: 507f1f77bcf86cd799439011
 *     responses:
 *       200:
 *         description: Order cancelled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Order cancelled successfully }
 *                 data: { $ref: '#/components/schemas/OrderView' }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *       500:
 *         description: Internal server error
 */
router.patch("/:orderId/cancel", ...studentOnly, orderWriteLimiter, cancelMyOrder);

export default router;
