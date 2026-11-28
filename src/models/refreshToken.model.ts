import { Schema, model, Document, Types } from "mongoose";

export type RefreshTokenStatus = "active" | "rotated" | "revoked";

export interface IRefreshToken extends Document {
  user: Types.ObjectId;
  jti: string;
  sessionId: string;
  familyId: string;
  tokenHash: string;
  status: RefreshTokenStatus;
  isRevoked: boolean;
  issuedAt: Date;
  rotatedAt?: Date;
  revokedAt?: Date;
  revokedReason?: string;
  replacedByTokenHash?: string;
  expiresAt: Date;
  createdAt: Date;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    jti: {
      type: String,
      required: true,
      unique: true,
    },
    sessionId: {
      type: String,
      required: true,
      index: true,
    },
    familyId: {
      type: String,
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["active", "rotated", "revoked"],
      default: "active",
      required: true,
      index: true,
    },
    isRevoked: {
      type: Boolean,
      default: false,
      index: true,
    },
    issuedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    rotatedAt: {
      type: Date,
    },
    revokedAt: {
      type: Date,
    },
    revokedReason: {
      type: String,
    },
    replacedByTokenHash: {
      type: String,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ familyId: 1, status: 1 });
refreshTokenSchema.index({ user: 1, sessionId: 1 });
refreshTokenSchema.index({ user: 1, isRevoked: 1 });

export const RefreshToken = model<IRefreshToken>(
  "RefreshToken",
  refreshTokenSchema,
);
