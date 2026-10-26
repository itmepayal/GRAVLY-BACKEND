import type { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";

import {
  getMyCartService,
  addToCartService,
  updateCartItemService,
  removeCartItemService,
  clearCartService,
  updateCartOptionsService,
} from "../service/cart.service";

import { BadRequestError } from "../utils/errors/app.error";

/* =====================================================
   HELPERS
===================================================== */
const getUserId = (req: Request): string => {
  const id = req.user?._id;
  if (!id) throw new BadRequestError("Authenticated user is missing");
  return String(id);
};

const itemId = (req: Request): string => {
  const id = String(req.params.menuItemId ?? "");
  if (!Types.ObjectId.isValid(id))
    throw new BadRequestError("Invalid menu item ID");
  return id;
};

/* =====================================================
   GET /cart
   Works even if the cafe is closed 
===================================================== */
export const getMyCart = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await getMyCartService(getUserId(req));
    res
      .status(200)
      .json({ success: true, message: "Cart fetched successfully", data });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   POST /cart/items
   409 if cafe is closed or cart has another cafe's items
===================================================== */
export const addToCart = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await addToCartService(getUserId(req), req.body);
    res
      .status(200)
      .json({ success: true, message: "Item added to cart", data });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   PATCH /cart/items/:menuItemId
   quantity 0 removes the item
===================================================== */
export const updateCartItem = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await updateCartItemService(
      getUserId(req),
      itemId(req),
      req.body,
    );
    res.status(200).json({ success: true, message: "Cart updated", data });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   DELETE /cart/items/:menuItemId
===================================================== */
export const removeCartItem = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await removeCartItemService(getUserId(req), itemId(req));
    res
      .status(200)
      .json({ success: true, message: "Item removed from cart", data });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   DELETE /cart
===================================================== */
export const clearCart = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await clearCartService(getUserId(req));
    res.status(200).json({ success: true, message: "Cart cleared", data });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   PATCH /cart/options
   delivery / self_pickup, payment, address, notes
   409 if cafe is closed
===================================================== */
export const updateCartOptions = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await updateCartOptionsService(getUserId(req), req.body);
    res
      .status(200)
      .json({ success: true, message: "Cart options updated", data });
  } catch (error) {
    next(error);
  }
};
