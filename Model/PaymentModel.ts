import mongoose from "mongoose";

type PaymentStatus = "paid" | "pending" | "approved" | "failed";
type PaymentMethod = "card" | "bank" | "wallet";

interface Payment {
  user: mongoose.Types.ObjectId;
  plan: mongoose.Types.ObjectId;
  amount: number;
  status: PaymentStatus;
  paymentMethod: PaymentMethod;
  paidAt: Date;
}

interface IPayment extends Payment, mongoose.Document {}

const PaymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "easybuyplan",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    status: {
      type: String,
      enum: ["paid", "pending", "approved", "failed"],
      default: "paid",
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ["card", "bank", "wallet"],
      required: true,
    },
    paidAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IPayment>("payment", PaymentSchema);
