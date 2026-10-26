import { Router } from "express";

import {
  createMenuItem,
  listMyMenu,
  updateMenuItem,
  setMenuAvailability,
  updateMenuStock,
  deleteMenuItem,
  setMenuStockStatus,
} from "../../controllers/menu.controller.js";

import {
  authenticate,
  authorize,
} from "../../middlewares/authenticate.middleware.js";
import { upload } from "../../middlewares/upload.middleware.js";

const router = Router();

export const publicMenuRouter = Router();

const imageUpload = upload.fields([{ name: "image", maxCount: 1 }]);

const ownerOnly = [authenticate, authorize("cafeOwner")];

/**
 * @openapi
 * /menu:
 *   post:
 *     tags: [Menu - Owner]
 *     summary: Create a menu item
 *     description: |
 *       Send as `multipart/form-data`. Only an owner whose cafe is **approved** can add items.
 *       - Item name must be unique inside the cafe (case-insensitive).
 *       - Set `trackStock=true` to enable stock counting. When false, the item has unlimited stock.
 *       - Allowed image types: JPG, PNG, WEBP.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/MenuItemInput'
 *     responses:
 *       201:
 *         description: Menu item created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Menu item created }
 *                 data:
 *                   $ref: '#/components/schemas/MenuItemOwnerView'
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
router.post("/", ...ownerOnly, imageUpload, createMenuItem);

/**
 * @openapi
 * /menu/me:
 *   get:
 *     tags: [Menu - Owner]
 *     summary: List my cafe menu (with stock)
 *     description: Returns every item of the owner's cafe including hidden and out-of-stock items, sorted by category then name.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         example: Beverages
 *       - in: query
 *         name: availability
 *         schema:
 *           type: string
 *           enum: [available, unavailable, out_of_stock]
 *         description: |
 *           - `available` – visible and in stock (orderable)
 *           - `unavailable` – hidden by owner (isAvailable = false)
 *           - `out_of_stock` – stock tracking on and stock is 0
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Partial, case-insensitive match on item name
 *         example: coffee
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
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/MenuItemOwnerView'
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
router.get("/me", ...ownerOnly, listMyMenu);

/**
 * @openapi
 * /menu/{id}:
 *   patch:
 *     tags: [Menu - Owner]
 *     summary: Update menu item details
 *     description: |
 *       Send as `multipart/form-data`. Only the fields you send are changed.
 *       To change stock use `PATCH /menu/{id}/stock`, to hide/show use `PATCH /menu/{id}/availability`.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Menu item ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/MenuItemUpdateInput'
 *     responses:
 *       200:
 *         description: Menu item updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Menu item updated }
 *                 data:
 *                   $ref: '#/components/schemas/MenuItemOwnerView'
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
router.patch("/:id", ...ownerOnly, imageUpload, updateMenuItem);

/**
 * @openapi
 * /menu/{id}/availability:
 *   patch:
 *     tags: [Menu - Owner]
 *     summary: Mark item available / unavailable
 *     description: Manual switch for items you are not serving today. Unavailable items are hidden from students completely.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Menu item ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isAvailable]
 *             properties:
 *               isAvailable:
 *                 type: boolean
 *                 example: false
 *     responses:
 *       200:
 *         description: Availability updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Item marked unavailable }
 *                 data:
 *                   $ref: '#/components/schemas/MenuItemOwnerView'
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
router.patch("/:id/availability", ...ownerOnly, setMenuAvailability);

/**
 * @openapi
 * /menu/{id}/stock:
 *   patch:
 *     tags: [Menu - Owner]
 *     summary: Update item stock
 *     description: |
 *       Send **either** `stock` (set an exact quantity) **or** `adjust` (add / remove a quantity atomically) — not both.
 *       - `adjust` can be negative, but stock can never go below 0 (returns 409).
 *       - You can also send `trackStock` in the same call to turn stock counting on or off.
 *       - When `trackStock` is true and stock reaches 0, the item shows as out of stock (`orderable = false`).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Menu item ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MenuStockInput'
 *           examples:
 *             setExact:
 *               summary: Set exact stock and start tracking
 *               value: { stock: 25, trackStock: true }
 *             addStock:
 *               summary: Received 10 more
 *               value: { adjust: 10 }
 *             removeStock:
 *               summary: 3 pieces wasted
 *               value: { adjust: -3 }
 *     responses:
 *       200:
 *         description: Stock updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Stock updated }
 *                 data:
 *                   $ref: '#/components/schemas/MenuItemOwnerView'
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
router.patch("/:id/stock", ...ownerOnly, updateMenuStock);

/**
 * @openapi
 * /menu/{id}/stock-status:
 *   patch:
 *     tags: [Menu - Owner]
 *     summary: Toggle item In Stock / Out of Stock
 *     description: |
 *       Quick switch for the owner.
 *       - `inStock: false` -> item becomes **out of stock** immediately (students see `orderable = false`).
 *       - `inStock: true` -> item is back **in stock**.
 *         - Send `stock` (quantity) if you want to count stock from now on.
 *         - Without `stock`, the item goes back on sale with unlimited quantity.
 *       - Calling it again with the same value changes nothing.
 *       - This does not change the hide/show switch (`PATCH /menu/{id}/availability`).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Menu item ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [inStock]
 *             properties:
 *               inStock:
 *                 type: boolean
 *                 example: false
 *               stock:
 *                 type: integer
 *                 minimum: 1
 *                 example: 20
 *                 description: Optional. Only with inStock = true. Sets quantity and turns stock counting on.
 *           examples:
 *             outOfStock:
 *               summary: Mark out of stock
 *               value: { inStock: false }
 *             backInStock:
 *               summary: Back in stock (unlimited)
 *               value: { inStock: true }
 *             restock:
 *               summary: Back in stock with quantity
 *               value: { inStock: true, stock: 20 }
 *     responses:
 *       200:
 *         description: Stock status updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Item marked out of stock }
 *                 data:
 *                   $ref: '#/components/schemas/MenuItemOwnerView'
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
router.patch("/:id/stock-status", ...ownerOnly, setMenuStockStatus);

/**
 * @openapi
 * /menu/{id}:
 *   delete:
 *     tags: [Menu - Owner]
 *     summary: Delete a menu item
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Menu item ID
 *     responses:
 *       200:
 *         description: Menu item deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Menu item deleted }
 *                 data:
 *                   type: object
 *                   properties:
 *                     _id: { type: string }
 *                     name: { type: string, example: Cold Coffee }
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
router.delete("/:id", ...ownerOnly, deleteMenuItem);

export default router;
