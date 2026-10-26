import crypto from "crypto";
import { Types } from "mongoose";

import { Cafe, IFile } from "../models/cafe.model";

import {
  uploadImage,
  signedUrl,
  type CloudinaryFile,
  type CloudinaryUploadResult,
} from "../config/cloudinary.config";

import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/errors/app.error";
import { MenuItem } from "../models/menuItem.model";

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

/* =====================================================
   UPLOAD ONE FILE
===================================================== */
const uploadOne = async (
  files: UploadedFiles,
  key: string,
  folder: string,
  isPrivate: boolean,
): Promise<IFile | undefined> => {
  const file = files[key]?.[0];

  if (!file) {
    return undefined;
  }

  const result = await uploadImage(file, folder, isPrivate);

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

  const old = existing?.toObject().documents;

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

  const base = `cafes/${ownerId}`;

  const [
    logo,
    cover,
    panFront,
    panBack,
    identityFront,
    identityBack,
    foodLicense,
    cancelledCheque,
    galleryImages,
  ] = await Promise.all([
    uploadOne(files, "logo", `${base}/public`, false),
    uploadOne(files, "coverImage", `${base}/public`, false),
    uploadOne(files, "panCardFront", `${base}/documents`, true),
    uploadOne(files, "panCardBack", `${base}/documents`, true),
    uploadOne(files, "identityFront", `${base}/documents`, true),
    uploadOne(files, "identityBack", `${base}/documents`, true),
    uploadOne(files, "foodLicense", `${base}/documents`, true),
    uploadOne(files, "cancelledCheque", `${base}/documents`, true),

    Promise.all(
      (files.galleryImages ?? []).map(async (file) => {
        const result = await uploadImage(file, `${base}/gallery`, false);

        return toCafeFile(result);
      }),
    ),
  ]);

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

    return await Cafe.findById(cafeId).select("-documents");
  } catch (error: unknown) {
    const mongoError = error as {
      code?: number;
    };

    if (mongoError?.code === 11000) {
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
   ADMIN: SET CAFE OPEN STATUS
   - Only approved cafes can be opened or closed
===================================================== */
export const setCafeOpenService = async (
  cafeId: Types.ObjectId,
  isOpen: boolean,
) => {
  if (!Types.ObjectId.isValid(cafeId.toString())) {
    throw new BadRequestError("Invalid cafe ID");
  }

  if (typeof isOpen !== "boolean") {
    throw new BadRequestError("isOpen must be a boolean");
  }

  const cafe = await Cafe.findOneAndUpdate(
    {
      _id: cafeId,
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
    const exists = await Cafe.exists({
      _id: cafeId,
    });

    if (!exists) {
      throw new NotFoundError("Cafe not found");
    }

    throw new ConflictError(
      "Cafe must be approved before it can be opened or closed",
    );
  }

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
    const escapedCity = query.city
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    filter.city = new RegExp(`^${escapedCity}$`, "i");
  }

  if (query.search?.trim()) {
    filter.$text = {
      $search: query.search.trim(),
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

  const [items, total] = await Promise.all([
    Cafe.find(filter)
      .select(fields)
      .sort({
        isOpen: -1,
        "rating.average": -1,
      })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),

    Cafe.countDocuments(filter),
  ]);

  return {
    items,
    total,
    page,
    pages: Math.ceil(total / limit),
  };
};

/* =====================================================
   PUBLIC: GET CAFE DETAILS
===================================================== */
export const getPublicCafeService = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError("Invalid cafe ID");
  }

  const cafe = await Cafe.findOne({
    _id: id,
    isApproved: true,
    approvalStatus: "approved",
    isVisible: true,
    isActive: true,
  }).select(
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
  );

  if (!cafe) {
    throw new NotFoundError("Cafe not found");
  }

  return cafe;
};

/* =====================================================
   PRIVATE DOCUMENT SIGNING
===================================================== */
const sign = (file?: IFile): IFile | undefined => {
  if (!file?.publicId) {
    return file;
  }

  return {
    ...file,
    url: signedUrl(file.publicId),
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
  ).select("name approvalStatus code");

  if (!cafe) {
    const exists = await Cafe.exists({
      _id: id,
    });

    if (!exists) {
      throw new NotFoundError("Cafe not found");
    }

    throw new ConflictError("Only pending cafes can be approved");
  }

  return cafe;
};

/* =====================================================
   ADMIN: REJECT CAFE
===================================================== */
export const rejectCafeService = async (id: string, reason: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError("Invalid cafe ID");
  }

  if (!reason?.trim()) {
    throw new BadRequestError("Rejection reason is required");
  }

  const cafe = await Cafe.findOneAndUpdate(
    {
      _id: id,
      approvalStatus: "pending",
    },
    {
      $set: {
        approvalStatus: "rejected",
        rejectionReason: reason.trim(),
        isApproved: false,
        isVisible: false,
        isOpen: false,
      },
    },
    {
      new: true,
      runValidators: true,
    },
  ).select("name approvalStatus rejectionReason");

  if (!cafe) {
    const exists = await Cafe.exists({
      _id: id,
    });

    if (!exists) {
      throw new NotFoundError("Cafe not found");
    }

    throw new ConflictError("Only pending cafes can be rejected");
  }

  return cafe;
};

/* =====================================================
   PUBLIC: GET CAFE MENU (grouped by category)
===================================================== */
export const getPublicMenuService = async (
  cafeId: string,
  onlyOrderable = false,
) => {
  assertObjectId(cafeId, "cafe ID");

  const cafe = await Cafe.findOne({
    _id: cafeId,
    isApproved: true,
    approvalStatus: "approved",
    isVisible: true,
    isActive: true,
  }).select("name isOpen");

  if (!cafe) throw new NotFoundError("Cafe not found");

  const filter: Record<string, unknown> = { cafe: cafeId, isAvailable: true };
  if (onlyOrderable) Object.assign(filter, ORDERABLE);

  const items = await MenuItem.find(filter)
    .select(
      "name description price category image isVeg isAvailable trackStock stock",
    )
    .sort({ category: 1, name: 1 })
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
};
