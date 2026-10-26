import { Schema, model, Document, Types } from "mongoose";
import { IUser } from "./user.model";

export interface IDeliveryAddress {
  label?: string;
  hostel?: string;
  block?: string;
  roomNumber?: string;
  landmark?: string;
  phone?: string;
  isDefault: boolean;
}

export interface IStudent extends Document {
  user: Types.ObjectId | IUser;
  rollNumber: string;
  course: string;
  semester: string;
  collegeName?: string;
  address?: string;
  deliveryAddresses: IDeliveryAddress[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const deliveryAddressSchema = new Schema<IDeliveryAddress>(
  {
    label: { type: String, default: "Hostel" },
    hostel: { type: String },
    block: { type: String },
    roomNumber: { type: String },
    landmark: { type: String },
    phone: { type: String },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true },
);

const studentSchema = new Schema<IStudent>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    rollNumber: { type: String, required: true },
    course: { type: String, required: true },
    semester: { type: String, required: true },
    collegeName: { type: String },
    address: { type: String },
    deliveryAddresses: [deliveryAddressSchema],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Student = model<IStudent>("Student", studentSchema);
