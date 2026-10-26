import { Schema, model, Document, Types } from "mongoose";
import { IOrder } from "./order.model.js";
import { IStudent } from "./student.model.js";
import { ICafe } from "./cafe.model.js";

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

    paidAt: { type: Date },
  },
  { timestamps: true },
);

paymentSchema.pre("validate", async function (next) {
  if (!this.paymentId) {
    const count = await model("Payment").countDocuments();
    this.paymentId = `pay_${1001 + count}`;
  }
});

export const Payment = model<IPayment>("Payment", paymentSchema);
