import crypto from "crypto";
import { Types } from "mongoose";

import { Cafe, type CafeApprovalStatus, IFile } from "../models/cafe.model.js";

import {
  uploadImage,
  signedUrl,
  deleteFromCloudinary,
  type CloudinaryFile,
  type CloudinaryUploadResult,
} from "../config/cloudinary.config.js";
import { logger } from "../config/logger.config.js";

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors/app.error.js";
import { MenuItem } from "../models/menuItem.model.js";
import {
  emitCafeApprovalEvent,
  emitCafeOpenStatusEvent,
} from "../socket/index.js";
import {
  REDIS_TTLS,
  cacheDeleteKeys,
  getOrLoadCachedJson,
  isRedisAvailable,
  redisGet,
  redisIncr,
  redisKeys,
} from "../infrastructure/redis/index.js";
import { invalidateCafeIdCache } from "../utils/order/requestUser.js";

export interface OrderableCafeMeta {
  _id: Types.ObjectId | string;
  name: string;
  isOpen: boolean;
  isApproved: boolean;
  approvalStatus: CafeApprovalStatus;
  isVisible: boolean;
  isActive: boolean;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  deliveryFee: number;
  platformFee: number;
}

export const invalidatePublicCafeListCache = async (): Promise<void> => {
  if (!isRedisAvailable()) return;
  try {
    await redisIncr(redisKeys.publicCafesVersion());
  } catch {
    // Best-effort collection cache version bump
  }
};

export const invalidatePublicMenuCaches = async (
  cafeId: string,
): Promise<void> => {
  await cacheDeleteKeys(
    redisKeys.publicMenu(cafeId, false),
    redisKeys.publicMenu(cafeId, true),
  );
};

export const invalidatePublicCafeCaches = async (
  cafeId: string,
): Promise<void> => {
  await Promise.all([
    cacheDeleteKeys(
      redisKeys.publicCafe(cafeId),
      redisKeys.cafeOrderableMeta(cafeId),
      redisKeys.publicMenu(cafeId, false),
      redisKeys.publicMenu(cafeId, true),
    ),
    invalidatePublicCafeListCache(),
  ]);
};

export const getOrderableCafeMeta = async (
  cafeId: Types.ObjectId | string,
): Promise<OrderableCafeMeta | null> => {
  const idStr = String(cafeId);
  return getOrLoadCachedJson<OrderableCafeMeta | null>(
    redisKeys.cafeOrderableMeta(idStr),
    REDIS_TTLS.CAFE_ORDERABLE_META_SEC,
    async () => {
      const cafe = await Cafe.findById(idStr)
        .select(
          "name isOpen isApproved approvalStatus isVisible isActive deliveryEnabled pickupEnabled deliveryFee platformFee",
        )
        .lean<OrderableCafeMeta | null>();
      return cafe;
    },
  );
};

/* =====================================================
   TYPES
===================================================== */

export type UploadedFiles = Record<string, CloudinaryFile[] | undefined>;

interface ParsedCafeBody {
  name: string;
  description?: string;
  contactNumber: string;
  email: string;
  ownerName?: string;
  ownerMobile?: string;
  aadhaarNumber: string;
  address: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  gstNumber?: string;
  panNumber: string;
  fssaiNumber: string;
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  deliveryFee: number;
}

/* =====================================================
   VALIDATION CONSTANTS
===================================================== */

const PHONE = /^[6-9]\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PINCODE = /^\d{6}$/;
const FSSAI = /^\d{14}$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GST = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const AADHAAR = /^\d{12}$/;
const ACCOUNT = /^\d{9,18}$/;

/* =====================================================
   BODY HELPERS
===================================================== */

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const bool = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") return true;
  if (value === "false") return false;

  throw new BadRequestError("Invalid boolean value");
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

const assertObjectId = (id: string, label: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError(`Invalid ${label}`);
  }
};

const ORDERABLE = {
  isAvailable: true,
  $or: [{ trackStock: false }, { stock: { $gt: 0 } }],
};

/* =====================================================
   PARSE AND VALIDATE CAFE BODY
===================================================== */
const parseBody = (body: unknown): ParsedCafeBody => {
  const b =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const data: ParsedCafeBody = {
    name: str(b.name),
    description: str(b.description) || undefined,
    contactNumber: str(b.contactNumber),
    email: str(b.email).toLowerCase(),
    ownerName: str(b.ownerName) || undefined,
    ownerMobile: str(b.ownerMobile) || undefined,
    aadhaarNumber: str(b.aadhaarNumber),
    address: str(b.address),
    landmark: str(b.landmark) || undefined,
    city: str(b.city),
    state: str(b.state),
    pincode: str(b.pincode),
    gstNumber: str(b.gstNumber).toUpperCase() || undefined,
    panNumber: str(b.panNumber).toUpperCase(),
    fssaiNumber: str(b.fssaiNumber),
    accountHolderName: str(b.accountHolderName),
    accountNumber: str(b.accountNumber),
    ifscCode: str(b.ifscCode).toUpperCase(),
    deliveryEnabled: bool(b.deliveryEnabled, true),
    pickupEnabled: bool(b.pickupEnabled, true),
    deliveryFee: Number(b.deliveryFee ?? 0),
  };

  if (!data.name) {
    throw new BadRequestError("Cafe name is required");
  }

  if (!PHONE.test(data.contactNumber)) {
    throw new BadRequestError("Valid 10 digit contact number is required");
  }

  if (!EMAIL.test(data.email)) {
    throw new BadRequestError("Valid email is required");
  }

  if (data.ownerMobile && !PHONE.test(data.ownerMobile)) {
    throw new BadRequestError("Invalid owner mobile number");
  }

  if (!data.address || !data.city || !data.state) {
    throw new BadRequestError("Address, city and state are required");
  }

  if (!PINCODE.test(data.pincode)) {
    throw new BadRequestError("Valid 6 digit pincode is required");
  }

  if (!AADHAAR.test(data.aadhaarNumber)) {
    throw new BadRequestError("Aadhaar must be 12 digits");
  }

  if (!PAN.test(data.panNumber)) {
    throw new BadRequestError("Invalid PAN number");
  }

  if (data.gstNumber && !GST.test(data.gstNumber)) {
    throw new BadRequestError("Invalid GST number");
  }

  if (!FSSAI.test(data.fssaiNumber)) {
    throw new BadRequestError("FSSAI number must be 14 digits");
  }

  if (!data.accountHolderName) {
    throw new BadRequestError("Account holder name is required");
  }

  if (!ACCOUNT.test(data.accountNumber)) {
    throw new BadRequestError("Invalid bank account number");
  }

  if (!IFSC.test(data.ifscCode)) {
    throw new BadRequestError("Invalid IFSC code");
  }

  if (!Number.isFinite(data.deliveryFee) || data.deliveryFee < 0) {
    throw new BadRequestError("Invalid delivery fee");
  }

  return data;
};

/* =====================================================
   CLOUDINARY RESULT -> CAFE MODEL IFile
===================================================== */
const toCafeFile = (result: CloudinaryUploadResult): IFile => ({
  url: result.url,
  publicId: result.publicId,
});

interface UploadedAssetRef {
  publicId: string;
  isPrivate: boolean;
}

const cleanupCloudinaryAssets = async (
  assets: UploadedAssetRef[],
  reason: string,
): Promise<void> => {
  const unique = new Map<string, UploadedAssetRef>();
  for (const asset of assets) {
    if (asset.publicId && !unique.has(asset.publicId)) {
      unique.set(asset.publicId, asset);
    }
  }

  if (unique.size === 0) {
    return;
  }

  const results = await Promise.allSettled(
    Array.from(unique.values()).map((asset) =>
      deleteFromCloudinary(asset.publicId, "image", asset.isPrivate),
    ),
  );

  for (const res of results) {
    if (res.status === "rejected") {
      logger.warn("Best-effort Cloudinary asset cleanup failed", {
        reason,
        error:
          res.reason instanceof Error ? res.reason.message : String(res.reason),
      });
    }
  }
};

/* =====================================================
   UPLOAD ONE FILE
===================================================== */
const uploadOne = async (
  files: UploadedFiles,
  key: string,
  folder: string,
  isPrivate: boolean,
  tracker?: UploadedAssetRef[],
): Promise<IFile | undefined> => {
  const file = files[key]?.[0];

  if (!file) {
    return undefined;
  }

  const result = await uploadImage(file, folder, isPrivate);
  tracker?.push({ publicId: result.publicId, isPrivate });

  return toCafeFile(result);
};

/* =====================================================
   OWNER: CREATE / RESUBMIT CAFE APPLICATION
===================================================== */
export const createCafeService = async (
  ownerId: string,
  body: unknown,
  files: UploadedFiles,
) => {
  if (!Types.ObjectId.isValid(ownerId)) {
    throw new BadRequestError("Invalid owner ID");
  }

  const data = parseBody(body);

  const existing = await Cafe.findOne({
    owner: ownerId,
  });

  if (existing && existing.approvalStatus !== "rejected") {
    throw new ConflictError(
      existing.approvalStatus === "approved"
        ? "Your cafe is already approved"
        : "Your application is already under review",
    );
  }

  const existingSnapshot = existing?.toObject();
  const old = existingSnapshot?.documents;

  const has = (key: string): boolean => Boolean(files[key]?.[0]);

  const required: [string, boolean][] = [
    ["panCardFront", has("panCardFront") || Boolean(old?.panCard?.front)],
    [
      "identityFront",
      has("identityFront") || Boolean(old?.identityProof?.front),
    ],
    ["foodLicense", has("foodLicense") || Boolean(old?.foodLicense)],
    [
      "cancelledCheque",
      has("cancelledCheque") || Boolean(old?.cancelledCheque),
    ],
  ];

  const missing = required
    .filter(([, present]) => !present)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new BadRequestError(`Missing documents: ${missing.join(", ")}`);
  }

  const emailTaken = await Cafe.exists({
    email: data.email,
    ...(existing ? { _id: { $ne: existing._id } } : {}),
  });
  if (emailTaken) {
    throw new ConflictError("A cafe with this email already exists");
  }

  const base = `cafes/${ownerId}`;
  const newlyUploadedAssets: UploadedAssetRef[] = [];

  const uploadSettled = await Promise.allSettled([
    uploadOne(files, "logo", `${base}/public`, false, newlyUploadedAssets),
    uploadOne(
      files,
      "coverImage",
      `${base}/public`,
      false,
      newlyUploadedAssets,
    ),
    uploadOne(
      files,
      "panCardFront",
      `${base}/documents`,
      true,
      newlyUploadedAssets,
    ),
    uploadOne(
      files,
      "panCardBack",
      `${base}/documents`,
      true,
      newlyUploadedAssets,
    ),
    uploadOne(
      files,
      "identityFront",
      `${base}/documents`,
      true,
      newlyUploadedAssets,
    ),
    uploadOne(
      files,
      "identityBack",
      `${base}/documents`,
      true,
      newlyUploadedAssets,
    ),
    uploadOne(
      files,
      "foodLicense",
      `${base}/documents`,
      true,
      newlyUploadedAssets,
    ),
    uploadOne(
      files,
      "cancelledCheque",
      `${base}/documents`,
      true,
      newlyUploadedAssets,
    ),
    Promise.allSettled(
      (files.galleryImages ?? []).map(async (file) => {
        const result = await uploadImage(file, `${base}/gallery`, false);
        newlyUploadedAssets.push({
          publicId: result.publicId,
          isPrivate: false,
        });
        return toCafeFile(result);
      }),
    ),
  ]);

  const firstSingleFailure = uploadSettled
    .slice(0, 8)
    .find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;

  const galleryOutcome = uploadSettled[8] as PromiseFulfilledResult<
    PromiseSettledResult<IFile>[]
  >;
  const firstGalleryFailure =
    galleryOutcome.status === "fulfilled"
      ? (galleryOutcome.value.find((r) => r.status === "rejected") as
          | PromiseRejectedResult
          | undefined)
      : (uploadSettled[8] as PromiseRejectedResult);

  if (firstSingleFailure || firstGalleryFailure) {
    await cleanupCloudinaryAssets(
      newlyUploadedAssets,
      "cafe_upload_partial_failure",
    );
    throw (firstSingleFailure ?? firstGalleryFailure)!.reason;
  }

  const logo = (uploadSettled[0] as PromiseFulfilledResult<IFile | undefined>)
    .value;
  const cover = (uploadSettled[1] as PromiseFulfilledResult<IFile | undefined>)
    .value;
  const panFront = (
    uploadSettled[2] as PromiseFulfilledResult<IFile | undefined>
  ).value;
  const panBack = (
    uploadSettled[3] as PromiseFulfilledResult<IFile | undefined>
  ).value;
  const identityFront = (
    uploadSettled[4] as PromiseFulfilledResult<IFile | undefined>
  ).value;
  const identityBack = (
    uploadSettled[5] as PromiseFulfilledResult<IFile | undefined>
  ).value;
  const foodLicense = (
    uploadSettled[6] as PromiseFulfilledResult<IFile | undefined>
  ).value;
  const cancelledCheque = (
    uploadSettled[7] as PromiseFulfilledResult<IFile | undefined>
  ).value;
  const galleryImages =
    galleryOutcome.status === "fulfilled"
      ? galleryOutcome.value.map(
          (r) => (r as PromiseFulfilledResult<IFile>).value,
        )
      : [];

  const documents = {
    panCard: {
      front: panFront ?? old?.panCard?.front,
      back: panBack ?? old?.panCard?.back,
    },

    identityProof: {
      front: identityFront ?? old?.identityProof?.front,
      back: identityBack ?? old?.identityProof?.back,
    },

    foodLicense: foodLicense ?? old?.foodLicense,

    cancelledCheque: cancelledCheque ?? old?.cancelledCheque,
  };

  const payload = {
    ...data,
    documents,

    ...(logo && {
      logo: logo.url,
    }),

    ...(cover && {
      coverImage: cover,
    }),

    ...(galleryImages.length > 0 && {
      galleryImages,
    }),
  };

  const lockedState = {
    approvalStatus: "pending" as const,
    isApproved: false,
    isVisible: false,
    isOpen: false,
  };

  try {
    let cafeId: Types.ObjectId;

    if (existing) {
      existing.set({
        ...payload,
        ...lockedState,
      });

      existing.rejectionReason = undefined;

      await existing.save();

      cafeId = existing._id as Types.ObjectId;
    } else {
      const created = await Cafe.create({
        owner: new Types.ObjectId(ownerId),
        ...payload,
        ...lockedState,
      });

      cafeId = created._id as Types.ObjectId;
    }

    if (existingSnapshot) {
      const replacedAssets: UploadedAssetRef[] = [];
      if (cover && existingSnapshot.coverImage?.publicId && existingSnapshot.coverImage.publicId !== cover.publicId) {
        replacedAssets.push({
          publicId: existingSnapshot.coverImage.publicId,
          isPrivate: false,
        });
      }
      if (panFront && old?.panCard?.front?.publicId && old.panCard.front.publicId !== panFront.publicId) {
        replacedAssets.push({ publicId: old.panCard.front.publicId, isPrivate: true });
      }
      if (panBack && old?.panCard?.back?.publicId && old.panCard.back.publicId !== panBack.publicId) {
        replacedAssets.push({ publicId: old.panCard.back.publicId, isPrivate: true });
      }
      if (identityFront && old?.identityProof?.front?.publicId && old.identityProof.front.publicId !== identityFront.publicId) {
        replacedAssets.push({ publicId: old.identityProof.front.publicId, isPrivate: true });
      }
      if (identityBack && old?.identityProof?.back?.publicId && old.identityProof.back.publicId !== identityBack.publicId) {
        replacedAssets.push({ publicId: old.identityProof.back.publicId, isPrivate: true });
      }
      if (foodLicense && old?.foodLicense?.publicId && old.foodLicense.publicId !== foodLicense.publicId) {
        replacedAssets.push({ publicId: old.foodLicense.publicId, isPrivate: true });
      }
      if (cancelledCheque && old?.cancelledCheque?.publicId && old.cancelledCheque.publicId !== cancelledCheque.publicId) {
        replacedAssets.push({ publicId: old.cancelledCheque.publicId, isPrivate: true });
      }
      if (galleryImages.length > 0 && Array.isArray(existingSnapshot.galleryImages)) {
        const newGalleryIds = new Set(galleryImages.map((g) => g.publicId));
        for (const oldImg of existingSnapshot.galleryImages) {
          if (oldImg?.publicId && !newGalleryIds.has(oldImg.publicId)) {
            replacedAssets.push({ publicId: oldImg.publicId, isPrivate: false });
          }
        }
      }

      if (replacedAssets.length > 0) {
        await cleanupCloudinaryAssets(replacedAssets, "cafe_resubmit_replaced");
      }
    }

    await invalidateCafeIdCache(ownerId);
    logger.info("Cafe application persisted", {
      cafeId: String(cafeId),
      ownerId,
      isResubmission: Boolean(existing),
      operation: existing ? "CAFE_RESUBMIT" : "CAFE_CREATE",
    });
    return await Cafe.findById(cafeId).select("-documents");
  } catch (error: unknown) {
    await cleanupCloudinaryAssets(
      newlyUploadedAssets,
      "cafe_db_persistence_failed",
    );

    const mongoError = error as {
      code?: number;
      keyPattern?: Record<string, unknown>;
    };

    if (mongoError?.code === 11000) {
      if (mongoError.keyPattern && "owner" in mongoError.keyPattern) {
        throw new ConflictError(
          "You have already submitted a cafe application",
        );
      }
      throw new ConflictError("A cafe with this email or code already exists");
    }

    throw error;
  }
};

/* =====================================================
   OWNER: GET MY CAFE
===================================================== */
export const getMyCafeService = async (ownerId: string) => {
  if (!Types.ObjectId.isValid(ownerId)) {
    throw new BadRequestError("Invalid owner ID");
  }

  const cafe = await Cafe.findOne({
    owner: ownerId,
  }).select("-documents");

  if (!cafe) {
    return {
      status: "not_registered" as const,
      rejectionReason: undefined,
      cafe: null,
    };
  }

  const obj = cafe.toObject();

  const isApproved = obj.approvalStatus === "approved" && obj.isApproved;

  return {
    status: obj.approvalStatus,
    rejectionReason: obj.rejectionReason,
    cafe: {
      ...obj,
      isOpen: isApproved && obj.isOpen,
      isVisible: isApproved && obj.isVisible,
    },
  };
};

/* =====================================================
   OWNER: SET CAFE OPEN STATUS
   - Only the authenticated owner of an approved, active cafe can open or close it
===================================================== */
export const setCafeOpenService = async (
  ownerId: string,
  isOpen: boolean,
) => {
  if (!Types.ObjectId.isValid(ownerId)) {
    throw new BadRequestError("Invalid owner ID");
  }

  if (typeof isOpen !== "boolean") {
    throw new BadRequestError("isOpen must be a boolean");
  }

  const cafe = await Cafe.findOneAndUpdate(
    {
      owner: ownerId,
      approvalStatus: "approved",
      isApproved: true,
      isActive: true,
    },
    {
      $set: {
        isOpen,
      },
    },
    {
      new: true,
      runValidators: true,
    },
  ).select("name isOpen");

  if (!cafe) {
    const existing = await Cafe.findOne({
      owner: ownerId,
    })
      .select("_id approvalStatus isApproved isActive")
      .lean();

    if (!existing) {
      throw new NotFoundError("Cafe not found");
    }

    if (!existing.isActive) {
      throw new ForbiddenError("Your cafe account is currently inactive");
    }

    throw new ConflictError(
      "Cafe must be approved before it can be opened or closed",
    );
  }

  await invalidatePublicCafeCaches(String(cafe._id));

  emitCafeOpenStatusEvent({
    cafeId: String(cafe._id),
    name: cafe.name,
    isOpen: cafe.isOpen,
  });

  logger.info("Cafe open status updated by owner", {
    cafeId: String(cafe._id),
    ownerId,
    isOpen: cafe.isOpen,
    operation: "CAFE_OPEN_STATUS",
  });

  return cafe;
};

/* =====================================================
   PUBLIC: LIST APPROVED CAFES
===================================================== */
export const listPublicCafesService = async (query: {
  city?: string;
  search?: string;
  page: number;
  limit: number;
}) => {
  const page = Math.max(1, Math.floor(query.page || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit || 10)));

  const filter: Record<string, unknown> = {
    isApproved: true,
    approvalStatus: "approved",
    isVisible: true,
    isActive: true,
  };

  if (query.city?.trim()) {
    const city = query.city.trim();
    if (city.length > 100) {
      throw new BadRequestError("City filter cannot exceed 100 characters");
    }
    const escapedCity = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    filter.city = new RegExp(`^${escapedCity}$`, "i");
  }

  if (query.search?.trim()) {
    const search = query.search.trim();
    if (search.length > 100) {
      throw new BadRequestError("Search query cannot exceed 100 characters");
    }
    filter.$text = {
      $search: search,
    };
  }

  const fields = [
    "name",
    "description",
    "logo",
    "coverImage",
    "city",
    "address",
    "landmark",
    "rating",
    "isOpen",
    "deliveryEnabled",
    "pickupEnabled",
    "deliveryFee",
    "platformFee",
  ].join(" ");

  const normalizedCity = query.city?.trim().toLowerCase() || "";
  const normalizedSearch = query.search?.trim().toLowerCase() || "";
  const queryHash = crypto
    .createHash("sha256")
    .update(`${normalizedCity}|${normalizedSearch}|${page}|${limit}`)
    .digest("hex")
    .slice(0, 24);

  let version = "1";
  if (isRedisAvailable()) {
    try {
      version = (await redisGet(redisKeys.publicCafesVersion())) || "1";
    } catch {
      version = "1";
    }
  }

  return getOrLoadCachedJson(
    redisKeys.publicCafesList(version, queryHash),
    REDIS_TTLS.PUBLIC_CAFE_LIST_SEC,
    async () => {
      const items = await Cafe.find(filter)
        .select(fields)
        .sort({
          isOpen: -1,
          "rating.average": -1,
        })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      const total =
        page === 1 && items.length < limit
          ? items.length
          : await Cafe.countDocuments(filter);

      return {
        items,
        total,
        page,
        pages: Math.ceil(total / limit),
      };
    },
  );
};

/* =====================================================
   PUBLIC: GET CAFE DETAILS
===================================================== */
export const getPublicCafeService = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError("Invalid cafe ID");
  }

  return getOrLoadCachedJson(
    redisKeys.publicCafe(id),
    REDIS_TTLS.PUBLIC_CAFE_CACHE_SEC,
    async () => {
      const cafe = await Cafe.findOne({
        _id: id,
        isApproved: true,
        approvalStatus: "approved",
        isVisible: true,
        isActive: true,
      })
        .select(
          [
            "name",
            "description",
            "logo",
            "coverImage",
            "galleryImages",
            "city",
            "state",
            "address",
            "landmark",
            "pincode",
            "rating",
            "isOpen",
            "deliveryEnabled",
            "pickupEnabled",
            "deliveryFee",
            "platformFee",
          ].join(" "),
        )
        .lean();

      if (!cafe) {
        throw new NotFoundError("Cafe not found");
      }

      return cafe;
    },
  );
};

/* =====================================================
   PRIVATE DOCUMENT SIGNING
===================================================== */
const sign = (file?: IFile): IFile | undefined => {
  if (!file?.publicId) {
    return file;
  }

  const extMatch = file.url?.match(/\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/);
  const format = extMatch?.[1]?.toLowerCase() ?? "";

  return {
    ...file,
    url: signedUrl(file.publicId, undefined, format),
  };
};

/* =====================================================
   ADMIN: LIST CAFES
===================================================== */
export const listCafesAdminService = async (
  status: string | undefined,
  page: number,
  limit: number,
) => {
  if (status && !["pending", "approved", "rejected"].includes(status)) {
    throw new BadRequestError("Invalid status filter");
  }

  const safePage = Math.max(1, Math.floor(page || 1));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit || 10)));

  const filter: Record<string, unknown> = {};

  if (status) {
    filter.approvalStatus = status;
  }

  const [items, total] = await Promise.all([
    Cafe.find(filter)
      .select("name city email contactNumber approvalStatus createdAt owner")
      .populate("owner", "name email")
      .sort({
        createdAt: -1,
      })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),

    Cafe.countDocuments(filter),
  ]);

  return {
    items,
    total,
    page: safePage,
    pages: Math.ceil(total / safeLimit),
  };
};

/* =====================================================
   ADMIN: LIST PENDING CAFES WITH FULL DETAILS + DOCUMENTS
===================================================== */
export const listPendingCafesService = async (page: number, limit: number) => {
  const safePage = Math.max(1, Math.floor(page || 1));
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit || 10)));

  const filter = {
    approvalStatus: "pending" as const,
    isApproved: false,
  };

  const [cafes, total] = await Promise.all([
    Cafe.find(filter)
      .select("+aadhaarNumber +panNumber +accountNumber")
      .populate("owner", "name email phone")
      .sort({
        createdAt: 1,
      })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),

    Cafe.countDocuments(filter),
  ]);

  const items = cafes.map((cafe) => {
    const docs = cafe.documents;

    const signedDocuments = {
      panCard: {
        front: sign(docs?.panCard?.front),
        back: sign(docs?.panCard?.back),
      },
      identityProof: {
        front: sign(docs?.identityProof?.front),
        back: sign(docs?.identityProof?.back),
      },
      foodLicense: sign(docs?.foodLicense),
      cancelledCheque: sign(docs?.cancelledCheque),
    };

    return {
      _id: cafe._id,
      status: cafe.approvalStatus,
      submittedAt: cafe.createdAt,
      updatedAt: cafe.updatedAt,

      owner: cafe.owner,

      cafe: {
        name: cafe.name,
        description: cafe.description,
        logo: cafe.logo,
        coverImage: cafe.coverImage,
        galleryImages: cafe.galleryImages,
        email: cafe.email,
        contactNumber: cafe.contactNumber,
        ownerName: cafe.ownerName,
        ownerMobile: cafe.ownerMobile,
        address: cafe.address,
        landmark: cafe.landmark,
        city: cafe.city,
        state: cafe.state,
        pincode: cafe.pincode,
        deliveryEnabled: cafe.deliveryEnabled,
        pickupEnabled: cafe.pickupEnabled,
        deliveryFee: cafe.deliveryFee,
      },

      verification: {
        aadhaarNumber: cafe.aadhaarNumber,
        panNumber: cafe.panNumber,
        gstNumber: cafe.gstNumber,
        fssaiNumber: cafe.fssaiNumber,
        bank: {
          accountHolderName: cafe.accountHolderName,
          accountNumber: cafe.accountNumber,
          ifscCode: cafe.ifscCode,
        },
      },

      documents: signedDocuments,

      documentsComplete: Boolean(
        signedDocuments.panCard.front &&
        signedDocuments.identityProof.front &&
        signedDocuments.foodLicense &&
        signedDocuments.cancelledCheque,
      ),
    };
  });

  return {
    items,
    total,
    page: safePage,
    pages: Math.ceil(total / safeLimit),
  };
};

/* =====================================================
   ADMIN: GET CAFE DETAILS INCLUDING DOCUMENTS
===================================================== */
export const getCafeAdminService = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError("Invalid cafe ID");
  }

  const cafe = await Cafe.findById(id)
    .select("+aadhaarNumber +panNumber +accountNumber")
    .populate("owner", "name email phone");

  if (!cafe) {
    throw new NotFoundError("Cafe not found");
  }

  const obj = cafe.toObject();
  const documents = obj.documents;

  obj.documents = {
    panCard: {
      front: sign(documents?.panCard?.front),
      back: sign(documents?.panCard?.back),
    },

    identityProof: {
      front: sign(documents?.identityProof?.front),
      back: sign(documents?.identityProof?.back),
    },

    foodLicense: sign(documents?.foodLicense),

    cancelledCheque: sign(documents?.cancelledCheque),
  };

  return obj;
};

/* =====================================================
   ADMIN: APPROVE CAFE
===================================================== */
export const approveCafeService = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError("Invalid cafe ID");
  }

  const cafe = await Cafe.findOneAndUpdate(
    {
      _id: id,
      approvalStatus: "pending",
    },
    {
      $set: {
        approvalStatus: "approved",
        isApproved: true,
        isVisible: true,
        isOpen: false,
        code: `CAFE-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      },

      $unset: {
        rejectionReason: "",
      },
    },
    {
      new: true,
      runValidators: true,
    },
  ).select("name approvalStatus code owner");

  if (!cafe) {
    const exists = await Cafe.exists({
      _id: id,
    });

    if (!exists) {
      throw new NotFoundError("Cafe not found");
    }

    throw new ConflictError("Only pending cafes can be approved");
  }

  await invalidatePublicCafeCaches(String(cafe._id));

  if (cafe.owner) {
    emitCafeApprovalEvent(
      {
        cafeId: String(cafe._id),
        name: cafe.name,
        approvalStatus: "approved",
        isApproved: true,
      },
      String(cafe.owner),
    );
  }

  logger.info("Cafe approved by admin", {
    cafeId: String(cafe._id),
    code: cafe.code,
    operation: "CAFE_APPROVE",
  });

  return {
    _id: cafe._id,
    name: cafe.name,
    approvalStatus: cafe.approvalStatus,
    code: cafe.code,
  };
};

/* =====================================================
   ADMIN: REJECT CAFE
===================================================== */
export const rejectCafeService = async (id: string, reason: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError("Invalid cafe ID");
  }

  const trimmedReason = reason?.trim() ?? "";
  if (!trimmedReason) {
    throw new BadRequestError("Rejection reason is required");
  }
  if (trimmedReason.length > 500) {
    throw new BadRequestError("Rejection reason cannot exceed 500 characters");
  }

  const cafe = await Cafe.findOneAndUpdate(
    {
      _id: id,
      approvalStatus: "pending",
    },
    {
      $set: {
        approvalStatus: "rejected",
        rejectionReason: trimmedReason,
        isApproved: false,
        isVisible: false,
        isOpen: false,
      },
    },
    {
      new: true,
      runValidators: true,
    },
  ).select("name approvalStatus rejectionReason owner");

  if (!cafe) {
    const exists = await Cafe.exists({
      _id: id,
    });

    if (!exists) {
      throw new NotFoundError("Cafe not found");
    }

    throw new ConflictError("Only pending cafes can be rejected");
  }

  await invalidatePublicCafeCaches(String(cafe._id));

  if (cafe.owner) {
    emitCafeApprovalEvent(
      {
        cafeId: String(cafe._id),
        name: cafe.name,
        approvalStatus: "rejected",
        isApproved: false,
        rejectionReason: cafe.rejectionReason,
      },
      String(cafe.owner),
    );
  }

  logger.info("Cafe rejected by admin", {
    cafeId: String(cafe._id),
    operation: "CAFE_REJECT",
  });

  return {
    _id: cafe._id,
    name: cafe.name,
    approvalStatus: cafe.approvalStatus,
    rejectionReason: cafe.rejectionReason,
  };
};

/* =====================================================
   PUBLIC: GET CAFE MENU (grouped by category)
===================================================== */
export const getPublicMenuService = async (
  cafeId: string,
  onlyOrderable = false,
) => {
  assertObjectId(cafeId, "cafe ID");

  return getOrLoadCachedJson(
    redisKeys.publicMenu(cafeId, onlyOrderable),
    REDIS_TTLS.PUBLIC_MENU_CACHE_SEC,
    async () => {
      const cafe = await Cafe.findOne({
        _id: cafeId,
        isApproved: true,
        approvalStatus: "approved",
        isVisible: true,
        isActive: true,
      })
        .select("name isOpen")
        .lean();

      if (!cafe) throw new NotFoundError("Cafe not found");

      const filter: Record<string, unknown> = {
        cafe: cafeId,
        isAvailable: true,
      };
      if (onlyOrderable) Object.assign(filter, ORDERABLE);

      const items = await MenuItem.find(filter)
        .select(
          "name description price category image isVeg isAvailable trackStock stock",
        )
        .sort({ category: 1, name: 1 })
        .limit(500)
        .lean();

      const grouped: Record<string, unknown[]> = {};

      for (const raw of items) {
        const { stock, trackStock, ...rest } = withStatus(raw);
        (grouped[raw.category] ??= []).push({ ...rest, trackStock: undefined });
        void stock;
        void trackStock;
      }

      return {
        cafe: { _id: cafe._id, name: cafe.name, isOpen: cafe.isOpen },
        menu: Object.entries(grouped).map(([category, items]) => ({
          category,
          items,
        })),
      };
    },
  );
};
