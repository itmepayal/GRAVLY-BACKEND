import { randomBytes } from "crypto";
import { Schema, model, Document, Types } from "mongoose";
import { IOrder } from "./order.model.js";
import { IStudent } from "./student.model.js";
import { ICafe } from "./cafe.model.js";

export type RefundRetryStatus = "none" | "pending" | "refunded" | "failed";

export interface IPayment extends Document {
  paymentId: string;
  order: Types.ObjectId | IOrder;
  student: Types.ObjectId | IStudent;
  cafe: Types.ObjectId | ICafe;
  amount: number;
  method: "card" | "upi" | "wallet" | "cashfree" | "cash";
  status: "pending" | "success" | "failed" | "refunded";
  transactionId?: string;
  gatewayResponse?: any;

  commission: number;
  cafeEarning: number;
  settlementStatus: "unsettled" | "settled";

  refundStatus: RefundRetryStatus;
  refundId?: string;
  refundRetryCount: number;
  refundNextRetryAt?: Date;
  refundLastError?: string;
  refundRequestedAt?: Date;
  refundedAt?: Date;

  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    paymentId: { type: String, unique: true },
    order: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true },
    cafe: {
      type: Schema.Types.ObjectId,
      ref: "Cafe",
      required: true,
      index: true,
    },
    amount: { type: Number, required: true },
    method: {
      type: String,
      enum: ["card", "upi", "wallet", "cashfree", "cash"],
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "success", "failed", "refunded"],
      default: "pending",
      index: true,
    },
    transactionId: { type: String },
    gatewayResponse: { type: Schema.Types.Mixed },

    commission: { type: Number, default: 0 },
    cafeEarning: { type: Number, default: 0 },
    settlementStatus: {
      type: String,
      enum: ["unsettled", "settled"],
      default: "unsettled",
    },

    refundStatus: {
      type: String,
      enum: ["none", "pending", "refunded", "failed"],
      default: "none",
    },
    refundId: { type: String },
    refundRetryCount: { type: Number, default: 0, min: 0 },
    refundNextRetryAt: { type: Date },
    refundLastError: { type: String },
    refundRequestedAt: { type: Date },
    refundedAt: { type: Date },

    paidAt: { type: Date },
  },
  { timestamps: true },
);

paymentSchema.pre("validate", function () {
  if (!this.paymentId) {
    this.paymentId = `pay_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  }
});

paymentSchema.index({ order: 1, createdAt: -1 });
paymentSchema.index({ status: 1, amount: 1 });
paymentSchema.index({ createdAt: -1, _id: -1 });
paymentSchema.index({ status: 1, createdAt: -1, _id: -1 });
paymentSchema.index(
  { order: 1, method: 1 },
  {
    name: "uniq_order_pending_cashfree",
    unique: true,
    partialFilterExpression: { method: "cashfree", status: "pending" },
  },
);
paymentSchema.index(
  { order: 1, method: 1 },
  {
    name: "uniq_order_cash",
    unique: true,
    partialFilterExpression: { method: "cash" },
  },
);

paymentSchema.index(
  { refundStatus: 1, refundNextRetryAt: 1 },
  {
    name: "idx_pending_refund_retries",
    partialFilterExpression: { refundStatus: "pending" },
  },
);

export const Payment = model<IPayment>("Payment", paymentSchema);
