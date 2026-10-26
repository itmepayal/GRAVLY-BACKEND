import { Schema, model, Document, Types } from "mongoose";
import { IStudent } from "./student.model";
import { ICafe } from "./cafe.model";
import { IMenuItem } from "./menuItem.model";

export interface IReview extends Document {
  student: Types.ObjectId | IStudent;
  cafe: Types.ObjectId | ICafe;
  order?: Types.ObjectId;
  menuItem?: Types.ObjectId | IMenuItem;
  rating: number;
  comment?: string;
  isApproved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true },
    cafe: {
      type: Schema.Types.ObjectId,
      ref: "Cafe",
      required: true,
      index: true,
    },
    order: { type: Schema.Types.ObjectId, ref: "Order" },
    menuItem: { type: Schema.Types.ObjectId, ref: "MenuItem" },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String },
    isApproved: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const Review = model<IReview>("Review", reviewSchema);
