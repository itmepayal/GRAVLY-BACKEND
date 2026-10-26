import { Router } from "express";

import {
  initiatePayment,
  getPaymentStatus,
  cashfreeWebhook,
} from "../../controllers/payment.controller.js";

import {
  authenticate,
  authorize,
} from "../../middlewares/authenticate.middleware.js";

const STUDENT = "student";

const router = Router();

/**
 * The webhook is called by Cashfree and has no login,
 * so authentication is set per route, not for the whole router.
 */
const studentOnly = [authenticate, authorize(STUDENT)];

/**
 * @openapi
 * tags:
 *   - name: Payments
 *     description: Online payments with Cashfree
 */

/**
 * @openapi
 * /payments/initiate:
 *   post:
 *     tags:
 *       - Payments
 *     summary: Start online payment for an order
 *     description: |
 *       Creates a Cashfree payment session for a pending online order.
 *       The app passes paymentSessionId and environment to the Cashfree SDK to open the payment screen.
 *       If a pending payment already exists for this order, the same session is returned.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderId]
 *             properties:
 *               orderId:
 *                 type: string
 *                 pattern: '^[0-9a-fA-F]{24}$'
 *                 example: 507f1f77bcf86cd799439011
 *     responses:
 *       200:
 *         description: Payment session created successfully
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
 *                     paymentId: { type: string }
 *                     orderId: { type: string }
 *                     orderNumber: { type: string }
 *                     amount: { type: number }
 *                     currency: { type: string, example: INR }
 *                     cashfreeOrderId: { type: string }
 *                     paymentSessionId: { type: string }
 *                     environment: { type: string, enum: [SANDBOX, PRODUCTION] }
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
router.post("/initiate", ...studentOnly, initiatePayment);

/**
 * @openapi
 * /payments/status/{orderId}:
 *   get:
 *     tags:
 *       - Payments
 *     summary: Get payment status of my order
 *     description: |
 *       Checks the real payment status with Cashfree before answering.
 *       After the payment screen closes, poll this every 3 to 5 seconds
 *       until paymentStatus is paid, failed or refunded.
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
 *         description: Payment status fetched successfully
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
 *                     orderId: { type: string }
 *                     orderStatus: { type: string }
 *                     paymentMethod: { type: string, enum: [cash, online] }
 *                     paymentStatus: { type: string }
 *                     payment:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         paymentId: { type: string }
 *                         status: { type: string }
 *                         method: { type: string }
 *                         amount: { type: number }
 *                         transactionId: { type: string, nullable: true }
 *                         paidAt: { type: string, format: date-time, nullable: true }
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
router.get("/status/:orderId", ...studentOnly, getPaymentStatus);

/**
 * @openapi
 * /payments/webhook:
 *   post:
 *     tags:
 *       - Payments
 *     summary: Cashfree webhook
 *     description: |
 *       Called by Cashfree, not by the app. No login is needed.
 *       The request is verified with the x-webhook-timestamp and x-webhook-signature headers.
 *       Add this URL in the Cashfree dashboard under Webhooks.
 *     parameters:
 *       - in: header
 *         name: x-webhook-timestamp
 *         required: true
 *         schema:
 *           type: string
 *       - in: header
 *         name: x-webhook-signature
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Webhook handled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       500:
 *         description: Internal server error
 */
router.post("/webhook", cashfreeWebhook);

export default router;
