import { Router } from "express";

import {
  createCafe,
  getMyCafe,
  setCafeOpen,
  listPublicCafes,
  getPublicCafe,
  getPublicMenu,
  listCafesAdmin,
  listPendingCafes,
  getCafeAdmin,
  approveCafe,
  rejectCafe,
} from "../../controllers/cafe.controller";

import {
  authenticate,
  authorize,
} from "../../middlewares/authenticate.middleware";
import { upload } from "../../middlewares/upload.middleware";

const router = Router();

/**
 * @openapi
 * /cafes:
 *   get:
 *     tags: [Cafes - Public]
 *     summary: List approved cafes
 *     description: Returns only approved, visible and active cafes. Open cafes come first, then sorted by rating.
 *     parameters:
 *       - in: query
 *         name: city
 *         schema: { type: string }
 *         description: Exact city match (case-insensitive)
 *         example: Ahmedabad
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Text search on cafe name and description
 *         example: coffee
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *     responses:
 *       200:
 *         description: Public cafes fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Public cafes fetched successfully }
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/CafePublicSummary'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 */
router.get("/", listPublicCafes);

/**
 * @openapi
 * /cafes/admin:
 *   get:
 *     tags: [Cafes - Admin]
 *     summary: List cafe applications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           $ref: '#/components/schemas/ApprovalStatus'
 *         description: Filter by approval status
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *     responses:
 *       200:
 *         description: Cafe applications fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Cafe applications fetched successfully }
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/CafeAdminSummary'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get("/admin", authenticate, authorize("admin"), listCafesAdmin);

/**
 * @openapi
 * /cafes/admin/pending:
 *   get:
 *     tags: [Cafes - Admin]
 *     summary: List pending cafes with full details and documents
 *     description: |
 *       Returns all cafes waiting for approval, oldest first.
 *       Each item has owner details, cafe details, verification numbers
 *       (Aadhaar, PAN, GST, FSSAI, bank) and signed (temporary) links of the
 *       uploaded documents, so the admin can check that the documents match.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 10 }
 *     responses:
 *       200:
 *         description: Pending cafes fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Pending cafes fetched successfully }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       _id: { type: string }
 *                       status: { type: string, example: pending }
 *                       submittedAt: { type: string, format: date-time }
 *                       updatedAt: { type: string, format: date-time }
 *                       owner:
 *                         type: object
 *                         properties:
 *                           _id: { type: string }
 *                           name: { type: string }
 *                           email: { type: string }
 *                           phone: { type: string }
 *                       cafe:
 *                         type: object
 *                         description: Basic cafe details and address
 *                       verification:
 *                         type: object
 *                         description: Aadhaar, PAN, GST, FSSAI and bank details typed by the owner
 *                       documents:
 *                         type: object
 *                         description: Signed links of panCard, identityProof, foodLicense and cancelledCheque
 *                       documentsComplete: { type: boolean }
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get(
  "/admin/pending",
  authenticate,
  authorize("admin"),
  listPendingCafes,
);

/**
 * @openapi
 * /cafes/admin/{id}:
 *   get:
 *     tags: [Cafes - Admin]
 *     summary: Get cafe application details with documents
 *     description: Includes sensitive fields (Aadhaar, PAN, account number) and signed URLs for private documents.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Cafe ID
 *     responses:
 *       200:
 *         description: Cafe application details fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Cafe application details fetched successfully }
 *                 data:
 *                   $ref: '#/components/schemas/CafeAdminDetail'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get("/admin/:id", authenticate, authorize("admin"), getCafeAdmin);

/**
 * @openapi
 * /cafes/admin/{id}/approve:
 *   patch:
 *     tags: [Cafes - Admin]
 *     summary: Approve a pending cafe
 *     description: Only cafes with status "pending" can be approved. A unique cafe code is generated and the cafe becomes visible. The cafe stays closed until the admin opens it.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Cafe ID
 *     responses:
 *       200:
 *         description: Cafe approved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Cafe approved successfully }
 *                 data:
 *                   $ref: '#/components/schemas/CafeApproveResult'
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
 */
router.patch(
  "/admin/:id/approve",
  authenticate,
  authorize("admin"),
  approveCafe,
);

/**
 * @openapi
 * /cafes/admin/{id}/reject:
 *   patch:
 *     tags: [Cafes - Admin]
 *     summary: Reject a pending cafe
 *     description: Only cafes with status "pending" can be rejected. The owner can fix the issues and resubmit.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Cafe ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 example: PAN card image is blurry. Please upload a clear photo.
 *     responses:
 *       200:
 *         description: Cafe application rejected successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Cafe application rejected successfully }
 *                 data:
 *                   $ref: '#/components/schemas/CafeRejectResult'
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
 */
router.patch("/admin/:id/reject", authenticate, authorize("admin"), rejectCafe);

/**
 * @openapi
 * /cafes/admin/{id}/open-status:
 *   patch:
 *     tags: [Cafes - Admin]
 *     summary: Open or close a cafe
 *     description: Only the admin can open or close a cafe. Only approved cafes can be opened or closed.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Cafe ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isOpen]
 *             properties:
 *               isOpen:
 *                 type: boolean
 *                 example: true
 *     responses:
 *       200:
 *         description: Cafe open status updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Cafe is now open }
 *                 data:
 *                   $ref: '#/components/schemas/CafeOpenStatus'
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
 */
router.patch(
  "/admin/:id/open-status",
  authenticate,
  authorize("admin"),
  setCafeOpen,
);

/**
 * @openapi
 * /cafes/me:
 *   get:
 *     tags: [Cafes - Owner]
 *     summary: Get my cafe and application status
 *     description: Returns "not_registered" when the owner has not applied yet. Documents are not included. isOpen is true only for approved cafes.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cafe details fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Cafe details fetched successfully }
 *                 data:
 *                   $ref: '#/components/schemas/MyCafe'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get("/me", authenticate, authorize("cafeOwner"), getMyCafe);

/**
 * @openapi
 * /cafes:
 *   post:
 *     tags: [Cafes - Owner]
 *     summary: Submit or resubmit a cafe application
 *     description: |
 *       Send as `multipart/form-data`.
 *       - A new application is created with status "pending".
 *       - If the previous application was rejected, it is resubmitted (old documents are reused when no new file is sent).
 *       - Required files: panCardFront, identityFront, foodLicense, cancelledCheque.
 *       - Allowed file types: JPG, PNG, WEBP. Max 5 MB per file.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/CafeApplicationInput'
 *     responses:
 *       201:
 *         description: Cafe application submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Cafe application submitted successfully }
 *                 data:
 *                   $ref: '#/components/schemas/CafeOwnerView'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
router.post(
  "/",
  authenticate,
  authorize("cafeOwner"),
  upload.fields([
    { name: "logo", maxCount: 1 },
    { name: "coverImage", maxCount: 1 },
    { name: "galleryImages", maxCount: 10 },
    { name: "panCardFront", maxCount: 1 },
    { name: "panCardBack", maxCount: 1 },
    { name: "identityFront", maxCount: 1 },
    { name: "identityBack", maxCount: 1 },
    { name: "foodLicense", maxCount: 1 },
    { name: "cancelledCheque", maxCount: 1 },
  ]),
  createCafe,
);

/**
 * @openapi
 * /cafes/{cafeId}/menu:
 *   get:
 *     tags: [Menu - Public]
 *     summary: Get a cafe's menu grouped by category
 *     description: |
 *       No login needed. Only for approved, visible and active cafes.
 *       Items hidden by the owner are never returned.
 *       Out-of-stock items are returned with `orderable = false` so the app can grey them out.
 *       Use `onlyOrderable=true` to return only items that can be ordered right now.
 *       Exact stock numbers are not exposed.
 *     parameters:
 *       - in: path
 *         name: cafeId
 *         required: true
 *         schema: { type: string }
 *         description: Cafe ID
 *       - in: query
 *         name: onlyOrderable
 *         schema: { type: boolean, default: false }
 *         description: Hide out-of-stock items
 *     responses:
 *       200:
 *         description: Menu fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Menu fetched successfully }
 *                 data:
 *                   $ref: '#/components/schemas/PublicMenu'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get("/:cafeId/menu", getPublicMenu);

/**
 * @openapi
 * /cafes/{id}:
 *   get:
 *     tags: [Cafes - Public]
 *     summary: Get approved cafe details
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Cafe ID
 *     responses:
 *       200:
 *         description: Cafe details fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Cafe details fetched successfully }
 *                 data:
 *                   $ref: '#/components/schemas/CafePublicDetail'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get("/:id", getPublicCafe);

export default router;
