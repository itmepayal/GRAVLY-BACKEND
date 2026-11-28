import { HydratedDocument, Types } from "mongoose";

import logger from "../config/logger.config.js";
import { Cart, ICart } from "../models/cart.model.js";
import { MenuItem, IMenuItem } from "../models/menuItem.model.js";
import {
  getOrderableCafeMeta,
  type OrderableCafeMeta,
} from "./cafe.service.js";
import { emitCartEvent } from "../socket/index.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/errors/app.error.js";

/* =====================================================
   TYPES
===================================================== */
type CartDoc = HydratedDocument<ICart>;

type MenuLean = Pick<
  IMenuItem,
  | "name"
  | "price"
  | "image"
  | "isAvailable"
  | "trackStock"
  | "stock"
  | "isVeg"
  | "cafe"
> & { _id: Types.ObjectId };

/* =====================================================
   HELPERS
===================================================== */
const MAX_QTY = 20;
const MAX_CART_CONCURRENCY_RETRIES = 6;

const isCartConcurrencyError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: number }).code;
  const name = (err as { name?: string }).name;
  return code === 11000 || name === "VersionError";
};

const withCartConcurrencyRetry = async <T>(
  work: () => Promise<T>,
): Promise<T> => {
  for (let attempt = 0; attempt <= MAX_CART_CONCURRENCY_RETRIES; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (isCartConcurrencyError(err) && attempt < MAX_CART_CONCURRENCY_RETRIES) {
        logger.warn("[cart] Concurrent update conflict; retrying", {
          attempt: attempt + 1,
          operation: "CART_CONCURRENCY_RETRY",
        });
        const delayMs = 8 + Math.floor(Math.random() * 20) * (attempt + 1);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (isCartConcurrencyError(err)) {
        logger.warn("[cart] Concurrent update conflict retries exhausted", {
          attempts: attempt,
          operation: "CART_CONCURRENCY_FAILED",
        });
        throw new ConflictError(
          "Your cart is being updated concurrently. Please try again.",
        );
      }
      throw err;
    }
  }
  throw new ConflictError("Could not update cart due to concurrent edits");
};

const roundMoney = (v: number): number => Math.round(v * 100) / 100;

const resolvePlatformFee = (
  cafe?: Pick<OrderableCafeMeta, "platformFee"> | null,
): number => roundMoney(Math.max(0, Number(cafe?.platformFee ?? 0)));

const computeCartTotalAmount = (
  items: ReadonlyArray<{ price: number; quantity: number }>,
): number =>
  roundMoney(items.reduce((sum, item) => sum + item.price * item.quantity, 0));

const oid = (id: string) => new Types.ObjectId(id);

const assertObjectId = (id: string, label: string) => {
  if (!Types.ObjectId.isValid(id))
    throw new BadRequestError(`Invalid ${label}`);
};

const toQuantity = (v: unknown, min: number): number => {
  if (typeof v !== "number" && typeof v !== "string") {
    throw new BadRequestError(
      `quantity must be a whole number between ${min} and ${MAX_QTY}`,
    );
  }
  if (typeof v === "string" && !v.trim()) {
    throw new BadRequestError(
      `quantity must be a whole number between ${min} and ${MAX_QTY}`,
    );
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > MAX_QTY) {
    throw new BadRequestError(
      `quantity must be a whole number between ${min} and ${MAX_QTY}`,
    );
  }
  return n;
};

const toBool = (v: unknown, field: string): boolean => {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new BadRequestError(`${field} must be true or false`);
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/* 10 digit Indian mobile number, starts with 6-9 */
const PHONE = /^[6-9]\d{9}$/;

/* Returns the address only if at least one field is filled, else null */
const addressView = (cart: Pick<ICart, "deliveryAddress"> | null) => {
  const a = cart?.deliveryAddress;
  if (!a) return null;
  const address = {
    hostel: a.hostel ?? null,
    block: a.block ?? null,
    roomNumber: a.roomNumber ?? null,
    landmark: a.landmark ?? null,
    phone: a.phone ?? null,
  };
  return Object.values(address).some(Boolean) ? address : null;
};

/*
  A cafe is usable for ordering only when approved, visible and active.
  requireOpen = true also rejects a cafe that is currently closed.
*/
const findOrderableCafe = async (
  cafeId: Types.ObjectId | string,
  { requireOpen = false }: { requireOpen?: boolean } = {},
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
  if (requireOpen && !cafe.isOpen) {
    throw new ConflictError("Cafe is currently closed");
  }
  return cafe;
};

const studentIdsFilter = (studentId: string, legacyUserId?: string) =>
  legacyUserId && legacyUserId !== studentId
    ? { $in: [oid(studentId), oid(legacyUserId)] }
    : oid(studentId);

const findActiveCart = (studentId: string, legacyUserId?: string) =>
  Cart.findOne({
    student: studentIdsFilter(studentId, legacyUserId),
    status: "active",
  });

/* =====================================================
   BUILD CART VIEW
===================================================== */
type CartViewInput = Pick<
  ICart,
  | "cafe"
  | "items"
  | "orderMethod"
  | "paymentMethod"
  | "deliveryAddress"
  | "orderNotes"
  | "totalAmount"
> & { _id: Types.ObjectId };

const buildView = async (
  cart: CartViewInput | null,
  preloaded?: {
    cafe?: OrderableCafeMeta | null;
    menuById?: Map<string, MenuLean>;
  },
) => {
  if (!cart || cart.items.length === 0) {
    if (cart && cart.totalAmount !== 0) {
      if ("save" in cart && typeof (cart as CartDoc).save === "function") {
        cart.totalAmount = 0;
        await (cart as CartDoc).save();
      } else {
        await Cart.updateOne(
          { _id: cart._id, items: { $size: 0 }, totalAmount: { $ne: 0 } },
          { $set: { totalAmount: 0 } },
        );
      }
    }
    return {
      _id: cart?._id ?? null,
      cafe: null,
      items: [],
      orderMethod: cart?.orderMethod ?? "self_pickup",
      paymentMethod: cart?.paymentMethod ?? "online",
      deliveryAddress: addressView(cart),
      orderNotes: cart?.orderNotes ?? null,
      summary: {
        itemCount: 0,
        subtotal: 0,
        deliveryFee: 0,
        platformFee: 0,
        grandTotal: 0,
      },
      canCheckout: false,
      issues: [] as string[],
    };
  }

  const missingMenuIds = preloaded?.menuById
    ? cart.items
        .map((i) => i.menuItem as Types.ObjectId)
        .filter((id) => !preloaded.menuById!.has(String(id)))
    : cart.items.map((i) => i.menuItem as Types.ObjectId);

  const [fetchedMenu, cafe] = await Promise.all([
    missingMenuIds.length > 0
      ? MenuItem.find({
          _id: { $in: missingMenuIds },
        })
          .select("name price image isAvailable trackStock stock isVeg")
          .lean<MenuLean[]>()
      : Promise.resolve([] as MenuLean[]),
    preloaded?.cafe !== undefined
      ? Promise.resolve(preloaded.cafe)
      : getOrderableCafeMeta(cart.cafe as Types.ObjectId),
  ]);

  const byId = new Map<string, MenuLean>(preloaded?.menuById ?? []);
  for (const m of fetchedMenu) {
    byId.set(String(m._id), m);
  }
  const issues: string[] = [];
  let subtotal = 0;
  let itemCount = 0;
  let changed = false as boolean;

  const items = cart.items.map((line) => {
    const m = byId.get(String(line.menuItem));
    let orderable = true;
    let reason: string | null = null;

    if (!m || !m.isAvailable) {
      orderable = false;
      reason = "No longer available";
    } else if (m.trackStock && m.stock < line.quantity) {
      orderable = false;
      reason = m.stock === 0 ? "Out of stock" : `Only ${m.stock} left`;
    }

    const price = m?.price ?? line.price;
    const name = m?.name ?? line.name ?? "Item";

    if (m && (line.price !== m.price || line.name !== m.name)) {
      line.price = m.price;
      line.name = m.name;
      changed = true;
    }

    if (!orderable) issues.push(`${name}: ${reason}`);

    subtotal += price * line.quantity;
    itemCount += line.quantity;

    return {
      menuItem: line.menuItem,
      name,
      image: m?.image ?? null,
      isVeg: m?.isVeg ?? true,
      price,
      quantity: line.quantity,
      lineTotal: roundMoney(price * line.quantity),
      orderable,
      reason,
    };
  });

  subtotal = roundMoney(subtotal);

  if (cart.totalAmount !== subtotal) {
    cart.totalAmount = subtotal;
    changed = true;
  }
  if (changed) {
    if ("save" in cart && typeof (cart as CartDoc).save === "function") {
      await (cart as CartDoc).save();
    } else {
      await Cart.updateOne(
        { _id: cart._id },
        { $set: { items: cart.items, totalAmount: cart.totalAmount } },
      );
    }
  }

  if (
    !cafe ||
    !cafe.isApproved ||
    cafe.approvalStatus !== "approved" ||
    !cafe.isVisible ||
    !cafe.isActive
  ) {
    issues.push("This cafe is not available right now");
  } else if (!cafe.isOpen) {
    issues.push("Cafe is currently closed");
  }

  const deliveryFee =
    cart.orderMethod === "delivery"
      ? roundMoney(Math.max(0, Number(cafe?.deliveryFee ?? 0)))
      : 0;
  const platformFee = resolvePlatformFee(cafe);

  return {
    _id: cart._id,
    cafe: cafe
      ? {
          _id: cafe._id,
          name: cafe.name,
          isOpen: cafe.isOpen,
          deliveryEnabled: cafe.deliveryEnabled,
          pickupEnabled: cafe.pickupEnabled,
        }
      : null,
    items,
    orderMethod: cart.orderMethod,
    paymentMethod: cart.paymentMethod,
    deliveryAddress: addressView(cart),
    orderNotes: cart.orderNotes ?? null,
    summary: {
      itemCount,
      subtotal,
      deliveryFee,
      platformFee,
      grandTotal: roundMoney(subtotal + deliveryFee + platformFee),
    },
    canCheckout: issues.length === 0,
    issues,
  };
};

/* =====================================================
   STUDENT: GET MY CART
===================================================== */
export const getMyCartService = async (
  studentId: string,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");
  const cart = await Cart.findOne({
    student: studentIdsFilter(studentId, legacyUserId),
    status: "active",
  })
    .select(
      "_id cafe items orderMethod paymentMethod deliveryAddress orderNotes totalAmount",
    )
    .lean<CartViewInput | null>();
  return buildView(cart);
};

/* =====================================================
   STUDENT: ADD ITEM
===================================================== */
export const addToCartService = async (
  studentId: string,
  body: unknown,
  legacyUserId?: string,
): Promise<Awaited<ReturnType<typeof buildView>>> => {
  assertObjectId(studentId, "student ID");

  const b = asObject(body);

  const menuItemId = str(b.menuItemId);
  assertObjectId(menuItemId, "menu item ID");

  const qty = b.quantity === undefined ? 1 : toQuantity(b.quantity, 1);
  const replaceCart =
    b.replaceCart === undefined ? false : toBool(b.replaceCart, "replaceCart");

  const menu = await MenuItem.findById(menuItemId).lean<MenuLean>();

  if (!menu) throw new NotFoundError("Menu item not found");
  if (!menu.isAvailable) throw new ConflictError("This item is not available");

  const menuCafeId = menu.cafe as Types.ObjectId;

  return withCartConcurrencyRetry(async () => {
    const [cafe, existingCart] = await Promise.all([
      findOrderableCafe(menuCafeId, { requireOpen: true }),
      findActiveCart(studentId, legacyUserId),
    ]);
    let cart = existingCart;

    if (
      cart &&
      cart.items.length > 0 &&
      String(cart.cafe) !== String(menuCafeId)
    ) {
      if (!replaceCart) {
        throw new ConflictError(
          "Your cart has items from another cafe. Clear it first or send replaceCart=true",
        );
      }
      cart.items.splice(0, cart.items.length);
    }

    if (!cart) {
      cart = new Cart({ student: oid(studentId), cafe: menuCafeId, items: [] });
    } else {
      cart.student = oid(studentId);
    }
    cart.cafe = menuCafeId;

    const line = cart.items.find((i) => String(i.menuItem) === menuItemId);
    const newQty = (line?.quantity ?? 0) + qty;

    if (newQty > MAX_QTY) {
      throw new BadRequestError(`You can order at most ${MAX_QTY} of one item`);
    }

    if (menu.trackStock && newQty > menu.stock) {
      throw new ConflictError(
        menu.stock === 0
          ? "Item is out of stock"
          : `Only ${menu.stock} left in stock`,
      );
    }

    if (line) {
      line.quantity = newQty;
      line.price = menu.price;
      line.name = menu.name;
    } else {
      cart.items.push({
        menuItem: menu._id,
        name: menu.name,
        quantity: newQty,
        price: menu.price,
      });
    }

    cart.totalAmount = computeCartTotalAmount(cart.items);
    await cart.save();

    emitCartEvent(
      {
        studentId,
        cartId: String(cart._id),
        cafeId: String(menuCafeId),
        itemCount: cart.items.length,
        totalAmount: cart.totalAmount,
        action: "item_added",
      },
      legacyUserId,
    );

    logger.debug("[cart] Item added to cart", {
      studentId,
      cafeId: String(menuCafeId),
      menuItemId,
      quantity: newQty,
      cartTotal: cart.totalAmount,
      operation: "CART_ADD_ITEM",
    });

    return buildView(cart, {
      cafe,
      menuById: new Map([[String(menu._id), menu]]),
    });
  });
};

/* =====================================================
   STUDENT: SET ITEM QUANTITY (0 removes the item)
   - Allowed even if the cafe is closed
===================================================== */
export const updateCartItemService = async (
  studentId: string,
  menuItemId: string,
  body: unknown,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");
  assertObjectId(menuItemId, "menu item ID");

  const b = asObject(body);
  const qty = toQuantity(b.quantity, 0);

  return withCartConcurrencyRetry(async () => {
    const cart = await findActiveCart(studentId, legacyUserId);
    const line = cart?.items.find((i) => String(i.menuItem) === menuItemId);
    if (!cart || !line) throw new NotFoundError("Item not found in your cart");

    cart.student = oid(studentId);

    if (qty === 0) {
      cart.items = cart.items.filter((i) => String(i.menuItem) !== menuItemId);
    } else {
      const menu = await MenuItem.findById(menuItemId).lean<MenuLean>();
      if (!menu || !menu.isAvailable) {
        throw new ConflictError("This item is no longer available");
      }
      if (menu.trackStock && qty > menu.stock) {
        throw new ConflictError(
          menu.stock === 0
            ? "Item is out of stock"
            : `Only ${menu.stock} left in stock`,
        );
      }
      line.quantity = qty;
      line.price = menu.price;
      line.name = menu.name;
    }

    cart.totalAmount = computeCartTotalAmount(cart.items);
    await cart.save();
    emitCartEvent(
      {
        studentId,
        cartId: String(cart._id),
        cafeId: cart.cafe ? String(cart.cafe) : null,
        itemCount: cart.items.length,
        totalAmount: cart.totalAmount,
        action: qty === 0 ? "item_removed" : "item_updated",
      },
      legacyUserId,
    );
    logger.debug("[cart] Item quantity updated", {
      studentId,
      menuItemId,
      quantity: qty,
      cartTotal: cart.totalAmount,
      operation: "CART_UPDATE_ITEM",
    });
    return buildView(cart);
  });
};

/* =====================================================
   STUDENT: REMOVE ONE ITEM
   - Allowed even if the cafe is closed
===================================================== */
export const removeCartItemService = async (
  studentId: string,
  menuItemId: string,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");
  assertObjectId(menuItemId, "menu item ID");

  return withCartConcurrencyRetry(async () => {
    const cart = await findActiveCart(studentId, legacyUserId);
    const exists = cart?.items.some((i) => String(i.menuItem) === menuItemId);
    if (!cart || !exists) throw new NotFoundError("Item not found in your cart");

    cart.student = oid(studentId);
    cart.items = cart.items.filter((i) => String(i.menuItem) !== menuItemId);
    cart.totalAmount = computeCartTotalAmount(cart.items);
    await cart.save();
    emitCartEvent(
      {
        studentId,
        cartId: String(cart._id),
        cafeId: cart.cafe ? String(cart.cafe) : null,
        itemCount: cart.items.length,
        totalAmount: cart.totalAmount,
        action: "item_removed",
      },
      legacyUserId,
    );
    logger.debug("[cart] Item removed from cart", {
      studentId,
      menuItemId,
      cartTotal: cart.totalAmount,
      operation: "CART_REMOVE_ITEM",
    });
    return buildView(cart);
  });
};

/* =====================================================
   STUDENT: CLEAR CART
   - Allowed even if the cafe is closed
===================================================== */
export const clearCartService = async (
  studentId: string,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");
  await Cart.deleteMany({
    student: studentIdsFilter(studentId, legacyUserId),
    status: "active",
  });
  emitCartEvent(
    {
      studentId,
      cafeId: null,
      itemCount: 0,
      totalAmount: 0,
      action: "cleared",
    },
    legacyUserId,
  );
  return buildView(null);
};

/* =====================================================
   STUDENT: UPDATE ORDER OPTIONS
===================================================== */
export const updateCartOptionsService = async (
  studentId: string,
  body: unknown,
  legacyUserId?: string,
) => {
  assertObjectId(studentId, "student ID");

  const b = asObject(body);

  return withCartConcurrencyRetry(async () => {
    const cart = await findActiveCart(studentId, legacyUserId);
    if (!cart || cart.items.length === 0) {
      throw new NotFoundError("Your cart is empty");
    }

    cart.student = oid(studentId);

    const cafe = await findOrderableCafe(cart.cafe as Types.ObjectId, {
      requireOpen: true,
    });

    if (b.orderMethod !== undefined) {
      const method = b.orderMethod;
      if (method !== "delivery" && method !== "self_pickup") {
        throw new BadRequestError("orderMethod must be delivery or self_pickup");
      }
      if (method === "delivery" && !cafe.deliveryEnabled) {
        throw new ConflictError("This cafe does not offer delivery");
      }
      if (method === "self_pickup" && !cafe.pickupEnabled) {
        throw new ConflictError("This cafe does not offer self pickup");
      }
      cart.orderMethod = method;
    }

    if (b.paymentMethod !== undefined) {
      const pm = b.paymentMethod;
      if (pm !== "online" && pm !== "cash") {
        throw new BadRequestError("paymentMethod must be online or cash");
      }
      cart.paymentMethod = pm;
    }

    if (b.orderNotes !== undefined) {
      const notes = str(b.orderNotes);
      if (notes.length > 300)
        throw new BadRequestError("orderNotes max 300 characters");
      cart.orderNotes = notes || undefined;
    }

    if (b.deliveryAddress !== undefined) {
      const a = asObject(b.deliveryAddress);

      const address = {
        hostel: str(a.hostel) || undefined,
        block: str(a.block) || undefined,
        roomNumber: str(a.roomNumber) || undefined,
        landmark: str(a.landmark) || undefined,
        phone: str(a.phone) || undefined,
      };

      for (const [k, val] of [
        ["hostel", address.hostel],
        ["block", address.block],
        ["roomNumber", address.roomNumber],
        ["landmark", address.landmark],
      ] as const) {
        if (val && val.length > 120) {
          throw new BadRequestError(`${k} must not exceed 120 characters`);
        }
      }

      if (address.phone && !PHONE.test(address.phone)) {
        throw new BadRequestError("Valid 10 digit phone is required");
      }
      cart.deliveryAddress = address;
    }

    if (cart.orderMethod === "delivery") {
      const a = cart.deliveryAddress;
      if (!a?.hostel || !a?.roomNumber || !a?.phone) {
        throw new BadRequestError(
          "Delivery needs deliveryAddress with hostel, roomNumber and phone",
        );
      }
    }

    await cart.save();
    emitCartEvent(
      {
        studentId,
        cartId: String(cart._id),
        cafeId: cart.cafe ? String(cart.cafe) : null,
        itemCount: cart.items.length,
        totalAmount: cart.totalAmount,
        action: "options_updated",
      },
      legacyUserId,
    );
    return buildView(cart);
  });
};
