import { Router } from "express";

import {
  adminRegister,
  adminLogin,
  refreshAccessToken,
  logout,
  googleLogin,
  appleLogin,
  cafeOwnerGoogleLogin,
  cafeOwnerAppleLogin,
} from "../../controllers/auth.controller";
import { authenticate } from "../../middlewares/authenticate.middleware";

const router = Router();

/**
 * @openapi
 * /auth/google:
 *   post:
 *     tags: [Authentication]
 *     summary: Student login / signup with Google
 *     description: New student gets an account automatically. Existing student just logs in.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Google ID token from the client app
 *     responses:
 *       200:
 *         description: Google login successful
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post("/google", googleLogin);

/**
 * @openapi
 * /auth/apple:
 *   post:
 *     tags: [Authentication]
 *     summary: Student login / signup with Apple
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identityToken]
 *             properties:
 *               identityToken:
 *                 type: string
 *                 description: Apple identity token from the client app
 *               fullName:
 *                 type: string
 *                 maxLength: 200
 *                 description: Optional. Apple sends the name only on the first login.
 *     responses:
 *       200:
 *         description: Apple login successful
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post("/apple", appleLogin);

/**
 * @openapi
 * /auth/cafe-owner/google:
 *   post:
 *     tags: [Authentication]
 *     summary: Cafe owner login / signup with Google
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Google ID token from the client app
 *     responses:
 *       200:
 *         description: Cafe Owner Google authentication successful
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post("/cafe-owner/google", cafeOwnerGoogleLogin);

/**
 * @openapi
 * /auth/cafe-owner/apple:
 *   post:
 *     tags: [Authentication]
 *     summary: Cafe owner login / signup with Apple
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identityToken]
 *             properties:
 *               identityToken:
 *                 type: string
 *               fullName:
 *                 type: string
 *                 maxLength: 200
 *     responses:
 *       200:
 *         description: Cafe Owner Apple authentication successful
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post("/cafe-owner/apple", cafeOwnerAppleLogin);

/**
 * @openapi
 * /auth/admin/register:
 *   post:
 *     tags: [Authentication]
 *     summary: Register the admin (needs secret key)
 *     description: Requires the server secret `ADMIN_REGISTER_SECRET`. Only one admin should exist.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password, secret]
 *             properties:
 *               name: { type: string, example: Super Admin }
 *               email: { type: string, format: email, example: admin@example.com }
 *               password: { type: string, minLength: 8 }
 *               secret: { type: string, description: Admin registration secret key }
 *     responses:
 *       201:
 *         description: Admin registered successfully
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post("/admin/register", adminRegister);

/**
 * @openapi
 * /auth/admin/login:
 *   post:
 *     tags: [Authentication]
 *     summary: Admin login with email and password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Admin login successful
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post("/admin/login", adminLogin);

/**
 * @openapi
 * /auth/refresh-token:
 *   post:
 *     tags: [Authentication]
 *     summary: Get a new access token using a refresh token
 *     description: Each refresh token works only once. Use the new refresh token from the response next time.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post("/refresh-token", refreshAccessToken);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Authentication]
 *     summary: Logout (revokes the refresh token)
 *     description: Requires a valid access token. Only the logged-in user's own refresh token can be revoked.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: Logout successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Logout successful }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post("/logout", authenticate, logout);

export default router;
