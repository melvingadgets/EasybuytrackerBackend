import mongoose from "mongoose";

type ReceiptStatus = "pending" | "approved";
type ReceiptFileType = "image" | "pdf";

interface Receipt {
  user: mongoose.Types.ObjectId;
  plan: string;
  amount: number;
  fileUrl: string;
  fileType: ReceiptFileType;
  cloudinaryPublicId: string;
  status: ReceiptStatus;
  approvedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

interface IReceipt extends Receipt, mongoose.Document {}

const ReceiptSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },
    plan: {
      type: String,
      enum: ["Monthly", "Weekly"],
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    fileUrl: {
      type: String,
      required: true,
    },
    fileType: {
      type: String,
      enum: ["image", "pdf"],
      required: true,
    },
    cloudinaryPublicId: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved"],
      default: "pending",
      index: true,
    },
    approvedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IReceipt>("receipt", ReceiptSchema);
