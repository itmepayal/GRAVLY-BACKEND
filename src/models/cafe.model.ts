// src/models/cafe.model.ts
import { Schema, model, Document, Types } from "mongoose";
import { IUser } from "./user.model";

/* =====================================================
   TYPES
===================================================== */

export interface IFile {
  url: string;
  publicId?: string;
}

export interface IDocumentImages {
  front?: IFile;
  back?: IFile;
}

export type CafeApprovalStatus = "pending" | "approved" | "rejected";

export interface ICafe extends Document {
  owner: Types.ObjectId | IUser;
  code?: string;

  // Basic Information
  name: string;
  description?: string;
  logo?: string;
  bannerImage?: string;
  coverImage?: IFile;
  galleryImages: IFile[];

  contactNumber: string;
  email: string;
  ownerName?: string;
  ownerMobile?: string;

  // Sensitive identity information
  aadhaarNumber?: string;

  // Location
  address: string;
  landmark?: string;
  city?: string;
  state?: string;
  pincode?: string;

  // Business verification
  gstNumber?: string;
  panNumber?: string;
  fssaiNumber?: string;

  // Bank details
  accountHolderName?: string;
  accountNumber?: string;
  ifscCode?: string;

  // Verification documents
  documents: {
    panCard?: IDocumentImages;
    identityProof?: IDocumentImages;
    foodLicense?: IFile;
    cancelledCheque?: IFile;
  };

  // Admin approval
  isApproved: boolean;
  approvalStatus: CafeApprovalStatus;
  rejectionReason?: string;

  // Cafe availability
  isOpen: boolean;
  isVisible: boolean;
  isActive: boolean;

  // Delivery and pickup
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  deliveryFee: number;
  platformFee: number;

  // Rating
  rating: {
    average: number;
    count: number;
  };

  createdAt: Date;
  updatedAt: Date;
}

/* =====================================================
   REUSABLE FILE SCHEMA
===================================================== */

const fileSchema = new Schema<IFile>(
  {
    url: {
      type: String,
      required: true,
      trim: true,
    },
    publicId: {
      type: String,
      trim: true,
    },
  },
  {
    _id: false,
  },
);

/* =====================================================
   FRONT / BACK DOCUMENT SCHEMA
===================================================== */

const documentImagesSchema = new Schema<IDocumentImages>(
  {
    front: {
      type: fileSchema,
      required: false,
    },
    back: {
      type: fileSchema,
      required: false,
    },
  },
  {
    _id: false,
  },
);

/* =====================================================
   CAFE SCHEMA
===================================================== */

const cafeSchema = new Schema<ICafe>(
  {
    /* -----------------------------------------------
       OWNER
    ------------------------------------------------ */
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    code: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },

    /* -----------------------------------------------
       BASIC INFORMATION
    ------------------------------------------------ */

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 2000,
    },

    logo: {
      type: String,
      trim: true,
    },

    bannerImage: {
      type: String,
      trim: true,
    },

    coverImage: {
      type: fileSchema,
      required: false,
    },

    galleryImages: {
      type: [fileSchema],
      default: [],
    },

    contactNumber: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },

    ownerName: {
      type: String,
      trim: true,
    },

    ownerMobile: {
      type: String,
      trim: true,
    },

    /* -----------------------------------------------
       SENSITIVE IDENTITY INFORMATION
    ------------------------------------------------ */

    aadhaarNumber: {
      type: String,
      select: false,
    },

    /* -----------------------------------------------
       LOCATION
    ------------------------------------------------ */

    address: {
      type: String,
      required: true,
      trim: true,
    },

    landmark: {
      type: String,
      trim: true,
    },

    city: {
      type: String,
      trim: true,
      index: true,
    },

    state: {
      type: String,
      trim: true,
    },

    pincode: {
      type: String,
      trim: true,
    },

    /* -----------------------------------------------
       BUSINESS VERIFICATION
    ------------------------------------------------ */

    gstNumber: {
      type: String,
      trim: true,
      uppercase: true,
    },

    panNumber: {
      type: String,
      trim: true,
      uppercase: true,
      select: false,
    },

    fssaiNumber: {
      type: String,
      trim: true,
    },

    /* -----------------------------------------------
       BANK DETAILS
    ------------------------------------------------ */

    accountHolderName: {
      type: String,
      trim: true,
    },

    accountNumber: {
      type: String,
      select: false,
    },

    ifscCode: {
      type: String,
      trim: true,
      uppercase: true,
    },

    /* -----------------------------------------------
       DOCUMENTS
    ------------------------------------------------ */

    documents: {
      panCard: {
        type: documentImagesSchema,
        required: false,
      },

      identityProof: {
        type: documentImagesSchema,
        required: false,
      },

      foodLicense: {
        type: fileSchema,
        required: false,
      },

      cancelledCheque: {
        type: fileSchema,
        required: false,
      },
    },

    /* -----------------------------------------------
       ADMIN APPROVAL
    ------------------------------------------------ */

    isApproved: {
      type: Boolean,
      default: false,
      index: true,
    },

    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    rejectionReason: {
      type: String,
      trim: true,
    },

    /* -----------------------------------------------
       AVAILABILITY
    ------------------------------------------------ */

    isOpen: {
      type: Boolean,
      default: false,
    },

    isVisible: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    /* -----------------------------------------------
       DELIVERY / PICKUP
    ------------------------------------------------ */

    deliveryEnabled: {
      type: Boolean,
      default: true,
    },

    pickupEnabled: {
      type: Boolean,
      default: true,
    },

    deliveryFee: {
      type: Number,
      default: 0,
      min: 0,
    },

    platformFee: {
      type: Number,
      default: 0,
      min: 0,
    },

    /* -----------------------------------------------
       RATING
    ------------------------------------------------ */

    rating: {
      average: {
        type: Number,
        default: 0,
        min: 0,
        max: 5,
      },

      count: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
  },
  {
    timestamps: true,
  },
);

/* =====================================================
   INDEXES
===================================================== */
cafeSchema.index({ name: "text", description: "text" });

cafeSchema.index({
  owner: 1,
  approvalStatus: 1,
});

cafeSchema.index({
  isApproved: 1,
  isVisible: 1,
  isActive: 1,
});

export const Cafe = model<ICafe>("Cafe", cafeSchema);
