import mongoose from "mongoose";

type PublicEasyBuyRequestPlan = "Monthly" | "Weekly";
type PublicEasyBuyRequestStatus =
  | "pending_verification"
  | "verified"
  | "approved"
  | "rejected"
  | "converted";

type PublicEasyBuyRequest = {
  requestId: string;
  fullName: string;
  email: string;
  phone: string;
  iphoneModel: string;
  capacity: string;
  plan: PublicEasyBuyRequestPlan;
  status: PublicEasyBuyRequestStatus;
  anonymousId?: string;
  ipAddress?: string;
  userAgent?: string;
  referrer?: string;
  landingPage?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  verificationTokenHash?: string;
  verificationTokenExpiresAt?: Date;
  lastVerificationSentAt?: Date;
  resendCount?: number;
  verifiedAt?: Date;
  approvedAt?: Date;
  rejectedAt?: Date;
  rejectionReason?: string;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  convertedAt?: Date;
  convertedEasyBoughtItemId?: mongoose.Types.ObjectId;
};

const PublicEasyBuyRequestSchema = new mongoose.Schema<PublicEasyBuyRequest>(
  {
    requestId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    iphoneModel: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    capacity: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    plan: {
      type: String,
      enum: ["Monthly", "Weekly"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending_verification", "verified", "approved", "rejected", "converted"],
      default: "verified",
      index: true,
    },
    anonymousId: {
      type: String,
      trim: true,
      index: true,
    },
    ipAddress: {
      type: String,
      trim: true,
    },
    userAgent: {
      type: String,
      trim: true,
    },
    referrer: {
      type: String,
      trim: true,
    },
    landingPage: {
      type: String,
      trim: true,
    },
    utmSource: {
      type: String,
      trim: true,
    },
    utmMedium: {
      type: String,
      trim: true,
    },
    utmCampaign: {
      type: String,
      trim: true,
    },
    utmTerm: {
      type: String,
      trim: true,
    },
    utmContent: {
      type: String,
      trim: true,
    },
    verificationTokenHash: {
      type: String,
      trim: true,
      index: true,
    },
    verificationTokenExpiresAt: {
      type: Date,
      index: true,
    },
    lastVerificationSentAt: {
      type: Date,
    },
    resendCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    verifiedAt: {
      type: Date,
    },
    approvedAt: {
      type: Date,
    },
    rejectedAt: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      trim: true,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      index: true,
    },
    reviewedAt: {
      type: Date,
    },
    convertedAt: {
      type: Date,
    },
    convertedEasyBoughtItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "easyboughtitem",
      index: true,
    },
  },
  { timestamps: true }
);

PublicEasyBuyRequestSchema.index({ email: 1, status: 1, createdAt: -1 });
PublicEasyBuyRequestSchema.index({ status: 1, createdAt: -1 });

type IPublicEasyBuyRequest = mongoose.InferSchemaType<typeof PublicEasyBuyRequestSchema>;

export default mongoose.model<IPublicEasyBuyRequest>(
  "publiceasybuyrequest",
  PublicEasyBuyRequestSchema
);
