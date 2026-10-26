import { Types } from "mongoose";

import { Cafe } from "../models/cafe.model";
import { MenuItem } from "../models/menuItem.model";
import { uploadImage, type CloudinaryFile } from "../config/cloudinary.config";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/errors/app.error";

/* =====================================================
   HELPERS
===================================================== */

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const toBool = (v: unknown, field: string): boolean => {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new BadRequestError(`${field} must be true or false`);
};

const toNumber = (v: unknown, field: string): number => {
  const n = Number(v);
  if (v === "" || v === null || !Number.isFinite(n)) {
    throw new BadRequestError(`${field} must be a valid number`);
  }
  return n;
};

const assertObjectId = (id: string, label: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError(`Invalid ${label}`);
  }
};

const ORDERABLE = {
  isAvailable: true,
  $or: [{ trackStock: false }, { stock: { $gt: 0 } }],
};

const getOwnerCafeId = async (ownerId: string): Promise<Types.ObjectId> => {
  assertObjectId(ownerId, "owner ID");

  const cafe = await Cafe.findOne({ owner: ownerId }).select(
    "_id approvalStatus isApproved isActive",
  );

  if (!cafe) throw new NotFoundError("You have not registered a cafe");

  if (
    cafe.approvalStatus !== "approved" ||
    !cafe.isApproved ||
    !cafe.isActive
  ) {
    throw new ConflictError("Your cafe must be approved to manage the menu");
  }

  return cafe._id as Types.ObjectId;
};

const duplicateGuard = (error: unknown): never => {
  if ((error as { code?: number })?.code === 11000) {
    throw new ConflictError("A menu item with this name already exists");
  }
  throw error;
};

const withStatus = <
  T extends { isAvailable: boolean; trackStock: boolean; stock: number },
>(
  item: T,
) => ({
  ...item,
  inStock: !item.trackStock || item.stock > 0,
  orderable: item.isAvailable && (!item.trackStock || item.stock > 0),
});

/* =====================================================
   OWNER: CREATE MENU ITEM
===================================================== */
export const createMenuItemService = async (
  ownerId: string,
  body: unknown,
  file?: CloudinaryFile,
) => {
  const cafeId = await getOwnerCafeId(ownerId);
  const b = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;

  const name = str(b.name);
  if (!name) throw new BadRequestError("Item name is required");

  const price = toNumber(b.price, "price");
  if (price < 0) throw new BadRequestError("Price cannot be negative");

  const trackStock =
    b.trackStock === undefined ? false : toBool(b.trackStock, "trackStock");

  let stock = 0;
  if (b.stock !== undefined && b.stock !== "") {
    stock = toNumber(b.stock, "stock");
    if (!Number.isInteger(stock) || stock < 0) {
      throw new BadRequestError("Stock must be a non-negative integer");
    }
  }

  const image = file
    ? await uploadImage(file, `cafes/${ownerId}/menu`, false)
    : undefined;

  try {
    const item = await MenuItem.create({
      cafe: cafeId,
      name,
      description: str(b.description) || undefined,
      price,
      category: str(b.category) || "General",
      isVeg: b.isVeg === undefined ? true : toBool(b.isVeg, "isVeg"),
      isAvailable:
        b.isAvailable === undefined
          ? true
          : toBool(b.isAvailable, "isAvailable"),
      trackStock,
      stock,
      ...(image && { image: { url: image.url, publicId: image.publicId } }),
    });

    return withStatus(item.toObject());
  } catch (error) {
    return duplicateGuard(error);
  }
};

/* =====================================================
   OWNER: LIST MY MENU
===================================================== */
export const listMyMenuService = async (
  ownerId: string,
  query: {
    category?: string;
    availability?: "available" | "unavailable" | "out_of_stock";
    search?: string;
  },
) => {
  const cafeId = await getOwnerCafeId(ownerId);

  const filter: Record<string, unknown> = { cafe: cafeId };

  if (query.category) filter.category = query.category;

  if (query.search) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.name = new RegExp(escaped, "i");
  }

  if (query.availability === "available") {
    Object.assign(filter, ORDERABLE);
  } else if (query.availability === "unavailable") {
    filter.isAvailable = false;
  } else if (query.availability === "out_of_stock") {
    filter.trackStock = true;
    filter.stock = 0;
  }

  const items = await MenuItem.find(filter)
    .sort({ category: 1, name: 1 })
    .lean();

  return items.map(withStatus);
};

/* =====================================================
   OWNER: UPDATE MENU ITEM (details)
===================================================== */
export const updateMenuItemService = async (
  ownerId: string,
  itemId: string,
  body: unknown,
  file?: CloudinaryFile,
) => {
  assertObjectId(itemId, "item ID");
  const cafeId = await getOwnerCafeId(ownerId);
  const b = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;

  const update: Record<string, unknown> = {};

  if (b.name !== undefined) {
    const name = str(b.name);
    if (!name) throw new BadRequestError("Item name cannot be empty");
    update.name = name;
  }
  if (b.description !== undefined) update.description = str(b.description);
  if (b.category !== undefined) {
    update.category = str(b.category) || "General";
  }
  if (b.price !== undefined) {
    const price = toNumber(b.price, "price");
    if (price < 0) throw new BadRequestError("Price cannot be negative");
    update.price = price;
  }
  if (b.isVeg !== undefined) update.isVeg = toBool(b.isVeg, "isVeg");
  if (b.trackStock !== undefined) {
    update.trackStock = toBool(b.trackStock, "trackStock");
  }

  if (file) {
    const img = await uploadImage(file, `cafes/${ownerId}/menu`, false);
    update.image = { url: img.url, publicId: img.publicId };
  }

  if (Object.keys(update).length === 0) {
    throw new BadRequestError("No valid fields to update");
  }

  try {
    const item = await MenuItem.findOneAndUpdate(
      { _id: itemId, cafe: cafeId },
      { $set: update },
      { new: true, runValidators: true },
    ).lean();

    if (!item) throw new NotFoundError("Menu item not found");
    return withStatus(item);
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    return duplicateGuard(error);
  }
};

/* =====================================================
   OWNER: TOGGLE AVAILABILITY 
===================================================== */
export const setMenuAvailabilityService = async (
  ownerId: string,
  itemId: string,
  isAvailable: boolean,
) => {
  assertObjectId(itemId, "item ID");
  const cafeId = await getOwnerCafeId(ownerId);

  const item = await MenuItem.findOneAndUpdate(
    { _id: itemId, cafe: cafeId },
    { $set: { isAvailable } },
    { new: true },
  ).lean();

  if (!item) throw new NotFoundError("Menu item not found");
  return withStatus(item);
};

/* =====================================================
   OWNER: UPDATE STOCK
===================================================== */
export const updateMenuStockService = async (
  ownerId: string,
  itemId: string,
  body: unknown,
) => {
  assertObjectId(itemId, "item ID");
  const cafeId = await getOwnerCafeId(ownerId);
  const b = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;

  const hasStock = b.stock !== undefined;
  const hasAdjust = b.adjust !== undefined;

  if (hasStock === hasAdjust) {
    throw new BadRequestError("Provide either 'stock' or 'adjust'");
  }

  const query: Record<string, unknown> = { _id: itemId, cafe: cafeId };
  const update: Record<string, unknown> = {};
  const $set: Record<string, unknown> = {};

  if (b.trackStock !== undefined) {
    $set.trackStock = toBool(b.trackStock, "trackStock");
  }

  if (hasStock) {
    const stock = toNumber(b.stock, "stock");
    if (!Number.isInteger(stock) || stock < 0) {
      throw new BadRequestError("Stock must be a non-negative integer");
    }
    $set.stock = stock;
  } else {
    const adjust = toNumber(b.adjust, "adjust");
    if (!Number.isInteger(adjust) || adjust === 0) {
      throw new BadRequestError("Adjust must be a non-zero integer");
    }
    if (adjust < 0) query.stock = { $gte: -adjust };
    update.$inc = { stock: adjust };
  }

  if (Object.keys($set).length) update.$set = $set;

  const item = await MenuItem.findOneAndUpdate(query, update, {
    new: true,
    runValidators: true,
  }).lean();

  if (!item) {
    const exists = await MenuItem.exists({ _id: itemId, cafe: cafeId });
    if (!exists) throw new NotFoundError("Menu item not found");
    throw new ConflictError("Not enough stock for this adjustment");
  }

  return withStatus(item);
};

/* =====================================================
   OWNER: DELETE MENU ITEM
===================================================== */
export const deleteMenuItemService = async (
  ownerId: string,
  itemId: string,
) => {
  assertObjectId(itemId, "item ID");
  const cafeId = await getOwnerCafeId(ownerId);

  const item = await MenuItem.findOneAndDelete({ _id: itemId, cafe: cafeId });
  if (!item) throw new NotFoundError("Menu item not found");

  return { _id: item._id, name: item.name };
};

/* =====================================================
   OWNER: IN STOCK / OUT OF STOCK TOGGLE
===================================================== */
export const setMenuStockStatusService = async (
  ownerId: string,
  itemId: string,
  inStock: boolean,
  stock?: number,
) => {
  assertObjectId(itemId, "item ID");
  const cafeId = await getOwnerCafeId(ownerId);

  const current = await MenuItem.findOne({ _id: itemId, cafe: cafeId }).lean();
  if (!current) throw new NotFoundError("Menu item not found");

  const isOutNow = current.trackStock && current.stock === 0;

  let update: Record<string, unknown>;

  if (!inStock) {
    if (isOutNow) return withStatus(current);
    update = { $set: { trackStock: true, stock: 0 } };
  } else if (stock !== undefined) {
    update = { $set: { trackStock: true, stock } };
  } else if (isOutNow) {
    update = { $set: { trackStock: false } };
  } else {
    return withStatus(current);
  }

  const item = await MenuItem.findOneAndUpdate(
    { _id: itemId, cafe: cafeId },
    update,
    { new: true, runValidators: true },
  ).lean();

  if (!item) throw new NotFoundError("Menu item not found");

  return withStatus(item);
};
