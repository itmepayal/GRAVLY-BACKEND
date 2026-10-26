// src/models/menu.model.ts
import { Schema, model, Document, Types } from "mongoose";
import { ICafe, IFile } from "./cafe.model";

export interface IMenuItem extends Document {
  cafe: Types.ObjectId | ICafe;
  name: string;
  description?: string;
  price: number;
  category: string;
  image?: IFile;
  isVeg: boolean;

  isAvailable: boolean;

  trackStock: boolean;
  stock: number;

  createdAt: Date;
  updatedAt: Date;
}

const fileSchema = new Schema<IFile>(
  {
    url: { type: String, required: true, trim: true },
    publicId: { type: String, trim: true },
  },
  { _id: false },
);

const menuItemSchema = new Schema<IMenuItem>(
  {
    cafe: {
      type: Schema.Types.ObjectId,
      ref: "Cafe",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 1000 },
    price: { type: Number, required: true, min: 0 },
    category: { type: String, required: true, default: "General", trim: true },
    image: { type: fileSchema, required: false },
    isVeg: { type: Boolean, default: true },
    isAvailable: { type: Boolean, default: true },
    trackStock: { type: Boolean, default: false },
    stock: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

menuItemSchema.index({ cafe: 1, category: 1 });
menuItemSchema.index({ cafe: 1, isAvailable: 1 });
menuItemSchema.index(
  { cafe: 1, name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } },
);

export const MenuItem = model<IMenuItem>("MenuItem", menuItemSchema);
