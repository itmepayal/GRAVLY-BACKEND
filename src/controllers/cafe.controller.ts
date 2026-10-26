import type { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";

import {
  createCafeService,
  getMyCafeService,
  setCafeOpenService,
  listPublicCafesService,
  getPublicCafeService,
  getPublicMenuService,
  listCafesAdminService,
  listPendingCafesService,
  getCafeAdminService,
  approveCafeService,
  rejectCafeService,
  type UploadedFiles,
} from "../service/cafe.service";

import { BadRequestError } from "../utils/errors/app.error";

/* =====================================================
   HELPERS
===================================================== */
const getUserId = (req: Request): string => {
  const user = req.user;

  if (!user) {
    throw new BadRequestError("Authenticated user is missing");
  }

  const id = user._id;

  if (!id) {
    throw new BadRequestError("Authenticated user ID is missing");
  }

  return String(id);
};

const parsePositiveInteger = (
  value: unknown,
  defaultValue: number,
  maxValue = 100,
): number => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new BadRequestError("Invalid pagination parameter");
  }

  return Math.min(parsed, maxValue);
};

const parseBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new BadRequestError("isOpen must be true or false");
};

const getUploadedFiles = (req: Request): UploadedFiles => {
  const files = req.files;

  if (!files || Array.isArray(files)) {
    return {};
  }

  return files as UploadedFiles;
};

const validateObjectId = (id: string): void => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError("Invalid cafe ID");
  }
};

/* =====================================================
   OWNER: CREATE CAFE APPLICATION
   POST /api/v1/cafes
===================================================== */
export const createCafe = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const ownerId = getUserId(req);
    const files = getUploadedFiles(req);

    const cafe = await createCafeService(ownerId, req.body, files);

    res.status(201).json({
      success: true,
      message: "Cafe application submitted successfully",
      data: cafe,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   OWNER: GET MY CAFE
   GET /api/v1/cafes/me
===================================================== */
export const getMyCafe = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const ownerId = getUserId(req);

    const cafe = await getMyCafeService(ownerId);

    res.status(200).json({
      success: true,
      message: "Cafe details fetched successfully",
      data: cafe,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   ADMIN: SET CAFE OPEN STATUS
   PATCH /api/v1/cafes/admin/:id/open-status
===================================================== */
export const setCafeOpen = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;

    validateObjectId(id);

    const isOpen = parseBoolean(req.body?.isOpen);

    const cafe = await setCafeOpenService(new Types.ObjectId(id), isOpen);

    res.status(200).json({
      success: true,
      message: `Cafe is now ${isOpen ? "open" : "closed"}`,
      data: cafe,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   PUBLIC: LIST APPROVED CAFES
   GET /api/v1/cafes
===================================================== */
export const listPublicCafes = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const page = parsePositiveInteger(
      req.query.page,
      1,
      Number.MAX_SAFE_INTEGER,
    );

    const limit = parsePositiveInteger(req.query.limit, 10, 100);

    const city =
      typeof req.query.city === "string" ? req.query.city.trim() : undefined;

    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim()
        : undefined;

    const result = await listPublicCafesService({
      city,
      search,
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      message: "Public cafes fetched successfully",
      data: result.items,
      pagination: {
        total: result.total,
        page: result.page,
        limit,
        pages: result.pages,
      },
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   PUBLIC: GET CAFE DETAILS
   GET /api/v1/cafes/:id
===================================================== */
export const getPublicCafe = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;

    validateObjectId(id);

    const cafe = await getPublicCafeService(id);

    res.status(200).json({
      success: true,
      message: "Cafe details fetched successfully",
      data: cafe,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   PUBLIC: GET CAFE MENU
   GET /api/v1/cafes/:cafeId/menu?onlyOrderable=true
===================================================== */
export const getPublicMenu = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { cafeId } = req.params;

    validateObjectId(cafeId);

    const onlyOrderable = req.query.onlyOrderable === "true";

    const data = await getPublicMenuService(cafeId, onlyOrderable);

    res.status(200).json({
      success: true,
      message: "Menu fetched successfully",
      data,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   ADMIN: LIST CAFE APPLICATIONS
   GET /api/v1/cafes/admin
===================================================== */
export const listCafesAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const status =
      typeof req.query.status === "string"
        ? req.query.status.trim()
        : undefined;

    const page = parsePositiveInteger(
      req.query.page,
      1,
      Number.MAX_SAFE_INTEGER,
    );

    const limit = parsePositiveInteger(req.query.limit, 10, 100);

    const result = await listCafesAdminService(status, page, limit);

    res.status(200).json({
      success: true,
      message: "Cafe applications fetched successfully",
      data: result.items,
      pagination: {
        total: result.total,
        page: result.page,
        limit,
        pages: result.pages,
      },
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   ADMIN: LIST PENDING CAFES (FULL DETAILS + DOCUMENTS)
   GET /api/v1/cafes/admin/pending
===================================================== */
export const listPendingCafes = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const page = parsePositiveInteger(
      req.query.page,
      1,
      Number.MAX_SAFE_INTEGER,
    );

    const limit = parsePositiveInteger(req.query.limit, 10, 50);

    const result = await listPendingCafesService(page, limit);

    res.status(200).json({
      success: true,
      message: "Pending cafes fetched successfully",
      data: result.items,
      pagination: {
        total: result.total,
        page: result.page,
        limit,
        pages: result.pages,
      },
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   ADMIN: GET CAFE APPLICATION DETAILS
   GET /api/v1/cafes/admin/:id
===================================================== */
export const getCafeAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;

    validateObjectId(id);

    const cafe = await getCafeAdminService(id);

    res.status(200).json({
      success: true,
      message: "Cafe application details fetched successfully",
      data: cafe,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   ADMIN: APPROVE CAFE
   PATCH /api/v1/cafes/admin/:id/approve
===================================================== */
export const approveCafe = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;

    validateObjectId(id);

    const cafe = await approveCafeService(id);

    res.status(200).json({
      success: true,
      message: "Cafe approved successfully",
      data: cafe,
    });
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   ADMIN: REJECT CAFE
   PATCH /api/v1/cafes/admin/:id/reject
===================================================== */
export const rejectCafe = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;

    validateObjectId(id);

    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!reason) {
      throw new BadRequestError("Rejection reason is required");
    }

    const cafe = await rejectCafeService(id, reason);

    res.status(200).json({
      success: true,
      message: "Cafe application rejected successfully",
      data: cafe,
    });
  } catch (error) {
    next(error);
  }
};
