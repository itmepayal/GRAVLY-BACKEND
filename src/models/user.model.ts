import { Schema, model, Document } from "mongoose";

export type UserRole = "student" | "admin" | "cafeOwner";

export type AuthProvider = "google" | "apple" | "password";

export interface IUser extends Document {
  name: string;
  email: string;
  password?: string;
  authProvider: AuthProvider;
  providerId?: string;
  role: UserRole;
  profileImage?: string;
  phone?: string;
  isVerified: boolean;
  isActive: boolean;
  fcmTokens: string[];
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      select: false,
    },

    authProvider: {
      type: String,
      enum: ["google", "apple", "password"],
      default: "password",
      required: true,
    },

    providerId: {
      type: String,
      sparse: true,
    },

    role: {
      type: String,
      enum: ["student", "admin", "cafeOwner"],
      default: "student",
      required: true,
    },

    profileImage: {
      type: String,
      trim: true,
    },

    phone: {
      type: String,
      trim: true,
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    fcmTokens: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

userSchema.index(
  { authProvider: 1, providerId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerId: { $type: "string" } },
  },
);

export const User = model<IUser>("User", userSchema);
