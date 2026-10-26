import { Router } from "express";

import {
  getMyCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  updateCartOptions,
} from "../../controllers/cart.controller.js";

import {
  authenticate,
  authorize,
} from "../../middlewares/authenticate.middleware.js";

const router = Router();

const studentOnly = [authenticate, authorize("student")];

/**
 * @openapi
 * components:
 *   schemas:
 *     CartAddInput:
 *       type: object
 *       required: [menuItemId]
 *       properties:
 *         menuItemId: { type: string, example: 665f1c2a9b1e8a0012345678 }
 *         quantity: { type: integer, minimum: 1, maximum: 20, default: 1 }
 *         replaceCart:
 *           type: boolean
 *           default: false
 *           description: Set true to throw away the current cart when the item is from a different cafe
 *     CartQuantityInput:
 *       type: object
 *       required: [quantity]
 *       properties:
 *         quantity:
 *           type: integer
 *           minimum: 0
 *           maximum: 20
 *           description: New quantity. 0 removes the item.
 *     CartAddress:
 *       type: object
 *       properties:
 *         hostel: { type: string, example: Hostel A }
 *         block: { type: string, example: B }
 *         roomNumber: { type: string, example: "204" }
 *         landmark: { type: string, example: Near main gate }
 *         phone: { type: string, example: "9876543210", description: 10 digit number starting with 6-9 }
 *     CartOptionsInput:
 *       type: object
 *       properties:
 *         orderMethod: { type: string, enum: [delivery, self_pickup] }
 *         paymentMethod: { type: string, enum: [online, cash] }
 *         orderNotes: { type: string, maxLength: 300, example: Less spicy please }
 *         deliveryAddress:
 *           $ref: '#/components/schemas/CartAddress'
 *     CartLine:
 *       type: object
 *       properties:
 *         menuItem: { type: string }
 *         name: { type: string, example: Cold Coffee }
 *         image: { type: object, nullable: true, properties: { url: { type: string } } }
 *         isVeg: { type: boolean }
 *         price: { type: number, example: 80 }
 *         quantity: { type: integer, example: 2 }
 *         lineTotal: { type: number, example: 160 }
 *         orderable: { type: boolean }
 *         reason: { type: string, nullable: true, example: Out of stock }
 *     CartView:
 *       type: object
 *       properties:
 *         _id: { type: string, nullable: true }
 *         cafe:
 *           type: object
 *           nullable: true
 *           properties:
 *             _id: { type: string }
 *             name: { type: string }
 *             isOpen: { type: boolean }
 *             deliveryEnabled: { type: boolean }
 *             pickupEnabled: { type: boolean }
 *         items:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/CartLine'
 *         orderMethod: { type: string, enum: [delivery, self_pickup] }
 *         paymentMethod: { type: string, enum: [online, cash] }
 *         deliveryAddress:
 *           type: object
 *           nullable: true
 *           description: null when no address field is filled
 *           properties:
 *             hostel: { type: string, nullable: true }
 *             block: { type: string, nullable: true }
 *             roomNumber: { type: string, nullable: true }
 *             landmark: { type: string, nullable: true }
 *             phone: { type: string, nullable: true }
 *         orderNotes: { type: string, nullable: true }
 *         summary:
 *           type: object
 *           properties:
 *             itemCount: { type: integer }
 *             subtotal: { type: number }
 *             deliveryFee: { type: number, description: Only charged for delivery }
 *             platformFee: { type: number }
 *             grandTotal: { type: number }
 *         canCheckout:
 *           type: boolean
 *           description: true only when issues is empty (all items orderable and cafe is open)
 *         issues:
 *           type: array
 *           items: { type: string, example: Cafe is currently closed }
 */

/**
 * @openapi
 * /cart:
 *   get:
 *     tags: [Cart]
 *     summary: Get my cart
 *     description: "Returns the active cart with live prices. Each line has `orderable` and `reason`. Works even when the cafe is closed; in that case `canCheckout` is false and `issues` explains why."
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cart fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Cart fetched successfully" }
 *                 data:
 *                   $ref: '#/components/schemas/CartView'
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
router.get("/", ...studentOnly, getMyCart);

/**
 * @openapi
 * /cart:
 *   delete:
 *     tags: [Cart]
 *     summary: Clear my cart
 *     description: Removes the whole cart. Allowed even when the cafe is closed.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cart cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Cart cleared" }
 *                 data:
 *                   $ref: '#/components/schemas/CartView'
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
router.delete("/", ...studentOnly, clearCart);

/**
 * @openapi
 * /cart/items:
 *   post:
 *     tags: [Cart]
 *     summary: Add item to cart
 *     description: |
 *       Rules:
 *       - The item must be available.
 *       - The cafe must be approved, visible, active **and open**. A closed cafe returns 409 `Cafe is currently closed`.
 *       - One cart holds items from **one cafe only**. If the item is from another cafe you get 409 unless `replaceCart=true` (old items are removed).
 *       - Adding the same item again increases its quantity (max 20 per item).
 *       - If stock is tracked, quantity cannot go above stock.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CartAddInput'
 *     responses:
 *       200:
 *         description: Item added to cart
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Item added to cart" }
 *                 data:
 *                   $ref: '#/components/schemas/CartView'
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
router.post("/items", ...studentOnly, addToCart);

/**
 * @openapi
 * /cart/items/{menuItemId}:
 *   patch:
 *     tags: [Cart]
 *     summary: Change item quantity
 *     description: Sets the quantity. Send `0` to remove the item. Allowed even when the cafe is closed.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: menuItemId
 *         required: true
 *         schema: { type: string }
 *         description: Menu item ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CartQuantityInput'
 *     responses:
 *       200:
 *         description: Cart updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Cart updated" }
 *                 data:
 *                   $ref: '#/components/schemas/CartView'
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
router.patch("/items/:menuItemId", ...studentOnly, updateCartItem);

/**
 * @openapi
 * /cart/items/{menuItemId}:
 *   delete:
 *     tags: [Cart]
 *     summary: Remove item from cart
 *     description: Removes one item from the cart. Allowed even when the cafe is closed.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: menuItemId
 *         required: true
 *         schema: { type: string }
 *         description: Menu item ID
 *     responses:
 *       200:
 *         description: Item removed from cart
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Item removed from cart" }
 *                 data:
 *                   $ref: '#/components/schemas/CartView'
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
router.delete("/items/:menuItemId", ...studentOnly, removeCartItem);

/**
 * @openapi
 * /cart/options:
 *   patch:
 *     tags: [Cart]
 *     summary: Set delivery / pickup, payment, address, notes
 *     description: |
 *       Send only the fields you want to change. The cart must have items and the cafe must be **open** (closed cafe returns 409 `Cafe is currently closed`).
 *
 *       - `delivery`: the cafe must have delivery enabled, and `deliveryAddress` needs `hostel`, `roomNumber` and `phone` (10 digits, starts with 6-9).
 *       - `self_pickup`: the cafe must have pickup enabled. No address needed.
 *       - `orderNotes`: max 300 characters.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CartOptionsInput'
 *           examples:
 *             pickup:
 *               summary: Self pickup
 *               value:
 *                 orderMethod: self_pickup
 *                 paymentMethod: cash
 *                 orderNotes: Less spicy please
 *             delivery:
 *               summary: Delivery
 *               value:
 *                 orderMethod: delivery
 *                 paymentMethod: online
 *                 orderNotes: Less spicy please
 *                 deliveryAddress:
 *                   hostel: Hostel A
 *                   block: B
 *                   roomNumber: "204"
 *                   landmark: Near main gate
 *                   phone: "9876543210"
 *     responses:
 *       200:
 *         description: Cart options updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Cart options updated" }
 *                 data:
 *                   $ref: '#/components/schemas/CartView'
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
router.patch("/options", ...studentOnly, updateCartOptions);

export default router;
