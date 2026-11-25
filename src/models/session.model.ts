import { Schema, model, Document, Types } from "mongoose";

export type DeviceType =
  | "Desktop"
  | "Laptop"
  | "Mobile"
  | "Tablet"
  | "Unknown";

export type SessionStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface ISession extends Document {
  sessionId: string;
  user: Types.ObjectId;
  familyId: string;
  deviceName: string;
  deviceType: DeviceType;
  os: string;
  browser: string;
  userAgent: string;
  ipAddress: string;
  loginAt: Date;
  lastActivityAt: Date;
  lastRefreshAt?: Date;
  expiresAt: Date;
  idleExpiresAt?: Date;
  status: SessionStatus;
  revokedAt?: Date;
  revokedReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<ISession>(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    familyId: {
      type: String,
      required: true,
      index: true,
    },
    deviceName: {
      type: String,
      required: true,
      default: "Unknown Device",
      trim: true,
      maxlength: 120,
    },
    deviceType: {
      type: String,
      enum: ["Desktop", "Laptop", "Mobile", "Tablet", "Unknown"],
      required: true,
      default: "Unknown",
    },
    os: {
      type: String,
      required: true,
      default: "Unknown",
      trim: true,
      maxlength: 80,
    },
    browser: {
      type: String,
      required: true,
      default: "Unknown",
      trim: true,
      maxlength: 80,
    },
    userAgent: {
      type: String,
      default: "",
      maxlength: 512,
    },
    ipAddress: {
      type: String,
      required: true,
      default: "unknown",
      maxlength: 64,
    },
    loginAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    lastActivityAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    lastRefreshAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    idleExpiresAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["ACTIVE", "REVOKED", "EXPIRED"],
      required: true,
      default: "ACTIVE",
    },
    revokedAt: {
      type: Date,
    },
    revokedReason: {
      type: String,
      maxlength: 120,
    },
  },
  {
    timestamps: true,
  },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ user: 1, status: 1, lastActivityAt: -1 });
sessionSchema.index({ user: 1, sessionId: 1 });

export const Session = model<ISession>("Session", sessionSchema);
