import { Schema, model, Document, Types } from "mongoose";
import { IStudent } from "./student.model";
import { ICafe } from "./cafe.model";
import { IMenuItem } from "./menuItem.model";
import { IPayment } from "./payment.model";

export type OrderStatus =
  | "pending"
  | "confirmed"
  | "preparing"
  | "ready"
  | "delivered"
  | "cancelled"
  | "rejected";

export interface IOrderItem {
  menuItem: Types.ObjectId | IMenuItem;
  name: string;
  quantity: number;
  price: number;
}

export interface IOrder extends Document {
  orderNumber: string;
  student: Types.ObjectId | IStudent;
  cafe: Types.ObjectId | ICafe;
  items: IOrderItem[];

  orderMethod: "delivery" | "self_pickup";
  deliveryAddress?: {
    hostel?: string;
    block?: string;
    roomNumber?: string;
    landmark?: string;
    phone?: string;
  };
  notes?: string;

  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  totalAmount: number;

  status: OrderStatus;
  rejectionReason?: string;
  paymentMethod: "online" | "cash";
  paymentStatus: "pending" | "paid" | "failed" | "refunded";
  paymentId?: Types.ObjectId | IPayment;

  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, unique: true },
    student: {
      type: Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    cafe: {
      type: Schema.Types.ObjectId,
      ref: "Cafe",
      required: true,
      index: true,
    },
    items: [
      {
        menuItem: {
          type: Schema.Types.ObjectId,
          ref: "MenuItem",
          required: true,
        },
        name: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        price: { type: Number, required: true },
        _id: false,
      },
    ],

    orderMethod: {
      type: String,
      enum: ["delivery", "self_pickup"],
      required: true,
    },
    deliveryAddress: {
      hostel: String,
      block: String,
      roomNumber: String,
      landmark: String,
      phone: String,
    },
    notes: { type: String },

    subtotal: { type: Number, required: true },
    deliveryFee: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },

    status: {
      type: String,
      enum: [
        "pending",
        "confirmed",
        "preparing",
        "ready",
        "delivered",
        "cancelled",
        "rejected",
      ],
      default: "pending",
      index: true,
    },
    rejectionReason: { type: String },
    paymentMethod: { type: String, enum: ["online", "cash"], required: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },
    paymentId: { type: Schema.Types.ObjectId, ref: "Payment" },

    completedAt: { type: Date },
  },
  { timestamps: true },
);

orderSchema.index({ student: 1, createdAt: -1 });
orderSchema.index({ cafe: 1, status: 1, createdAt: -1 });

orderSchema.pre("validate", async function (next) {
  if (!this.orderNumber) {
    const count = await model("Order").countDocuments();
    this.orderNumber = String(1001 + count);
  }
});

export const Order = model<IOrder>("Order", orderSchema);
