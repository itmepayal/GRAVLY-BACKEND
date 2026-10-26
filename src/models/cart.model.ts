import { Schema, model, Document, Types } from "mongoose";
import { IStudent } from "./student.model";
import { ICafe } from "./cafe.model";
import { IMenuItem } from "./menuItem.model";

export interface ICartItem {
  menuItem: Types.ObjectId | IMenuItem;
  name?: string;
  quantity: number;
  price: number;
}

export interface ICart extends Document {
  student: Types.ObjectId | IStudent;
  cafe: Types.ObjectId | ICafe;
  items: ICartItem[];
  orderMethod: "delivery" | "self_pickup";
  deliveryAddress?: {
    hostel?: string;
    block?: string;
    roomNumber?: string;
    landmark?: string;
    phone?: string;
  };
  orderNotes?: string;
  paymentMethod: "online" | "cash";
  totalAmount: number;
  status: "active" | "ordered" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
}

const cartSchema = new Schema<ICart>(
  {
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true },
    cafe: { type: Schema.Types.ObjectId, ref: "Cafe", required: true },
    items: [
      {
        menuItem: {
          type: Schema.Types.ObjectId,
          ref: "MenuItem",
          required: true,
        },
        name: { type: String },
        quantity: { type: Number, required: true, min: 1 },
        price: { type: Number, required: true },
        _id: false,
      },
    ],
    orderMethod: {
      type: String,
      enum: ["delivery", "self_pickup"],
      default: "self_pickup",
    },
    deliveryAddress: {
      hostel: String,
      block: String,
      roomNumber: String,
      landmark: String,
      phone: String,
    },
    orderNotes: { type: String },
    paymentMethod: {
      type: String,
      enum: ["online", "cash"],
      default: "online",
    },
    totalAmount: { type: Number, required: true, default: 0 },
    status: {
      type: String,
      enum: ["active", "ordered", "cancelled"],
      default: "active",
    },
  },
  { timestamps: true },
);

cartSchema.index({ student: 1, status: 1 });

export const Cart = model<ICart>("Cart", cartSchema);
