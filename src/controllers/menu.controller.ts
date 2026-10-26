import type { Request, Response, NextFunction } from "express";

import {
  createMenuItemService,
  listMyMenuService,
  updateMenuItemService,
  setMenuAvailabilityService,
  updateMenuStockService,
  deleteMenuItemService,
  setMenuStockStatusService,
} from "../service/menu.service";
import type { UploadedFiles } from "../service/cafe.service";
import { BadRequestError } from "../utils/errors/app.error";

const getUserId = (req: Request): string => {
  const id = req.user?._id;
  if (!id) throw new BadRequestError("Authenticated user is missing");
  return String(id);
};

const getImage = (req: Request) => {
  const files = req.files;
  if (!files || Array.isArray(files)) return undefined;
  return (files as UploadedFiles).image?.[0];
};

const parseBool = (v: unknown, field: string): boolean => {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new BadRequestError(`${field} must be true or false`);
};

/* POST /api/v1/menu */
export const createMenuItem = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const item = await createMenuItemService(
      getUserId(req),
      req.body,
      getImage(req),
    );
    res
      .status(201)
      .json({ success: true, message: "Menu item created", data: item });
  } catch (e) {
    next(e);
  }
};

/* GET /api/v1/menu/me?category=&availability=&search= */
export const listMyMenu = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { category, availability, search } = req.query;

    if (
      availability !== undefined &&
      !["available", "unavailable", "out_of_stock"].includes(
        String(availability),
      )
    ) {
      throw new BadRequestError("Invalid availability filter");
    }

    const items = await listMyMenuService(getUserId(req), {
      category: typeof category === "string" ? category.trim() : undefined,
      availability: availability as
        | "available"
        | "unavailable"
        | "out_of_stock"
        | undefined,
      search: typeof search === "string" ? search.trim() : undefined,
    });

    res.status(200).json({
      success: true,
      message: "Menu fetched successfully",
      data: items,
    });
  } catch (e) {
    next(e);
  }
};

/* PATCH /api/v1/menu/:id */
export const updateMenuItem = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const item = await updateMenuItemService(
      getUserId(req),
      req.params.id,
      req.body,
      getImage(req),
    );
    res
      .status(200)
      .json({ success: true, message: "Menu item updated", data: item });
  } catch (e) {
    next(e);
  }
};

/* PATCH /api/v1/menu/:id/availability   body: { isAvailable: boolean } */
export const setMenuAvailability = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const isAvailable = parseBool(req.body?.isAvailable, "isAvailable");
    const item = await setMenuAvailabilityService(
      getUserId(req),
      req.params.id,
      isAvailable,
    );
    res.status(200).json({
      success: true,
      message: `Item marked ${isAvailable ? "available" : "unavailable"}`,
      data: item,
    });
  } catch (e) {
    next(e);
  }
};

/* PATCH /api/v1/menu/:id/stock   body: { stock } OR { adjust } */
export const updateMenuStock = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const item = await updateMenuStockService(
      getUserId(req),
      req.params.id,
      req.body,
    );
    res
      .status(200)
      .json({ success: true, message: "Stock updated", data: item });
  } catch (e) {
    next(e);
  }
};

/* DELETE /api/v1/menu/:id */
export const deleteMenuItem = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const item = await deleteMenuItemService(getUserId(req), req.params.id);
    res
      .status(200)
      .json({ success: true, message: "Menu item deleted", data: item });
  } catch (e) {
    next(e);
  }
};

export const setMenuStockStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const inStock = parseBool(req.body?.inStock, "inStock");

    let stock: number | undefined;

    if (req.body?.stock !== undefined && req.body?.stock !== "") {
      if (!inStock) {
        throw new BadRequestError(
          "stock can only be sent when inStock is true",
        );
      }

      stock = Number(req.body.stock);

      if (!Number.isInteger(stock) || stock < 1) {
        throw new BadRequestError("stock must be a positive integer");
      }
    }

    const item = await setMenuStockStatusService(
      getUserId(req),
      req.params.id,
      inStock,
      stock,
    );

    res.status(200).json({
      success: true,
      message: `Item marked ${inStock ? "in stock" : "out of stock"}`,
      data: item,
    });
  } catch (e) {
    next(e);
  }
};
