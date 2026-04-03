import mongoose from "mongoose";

type PublicEasyBuyDraftStep = 1 | 2 | 3;
type PublicEasyBuyDraftStatus = "draft" | "submitted";

type PublicEasyBuyDraft = {
  anonymousId: string;
  provider?: string;
  currentStep: PublicEasyBuyDraftStep;
  status: PublicEasyBuyDraftStatus;
  fullName?: string;
  email?: string;
  phone?: string;
  iphoneModel?: string;
  capacity?: string;
  plan?: "Monthly" | "Weekly";
  monthlyPlan?: number;
  weeklyPlan?: number;
  address?: string;
  occupation?: string;
  ipAddress?: string;
  userAgent?: string;
  referrer?: string;
  landingPage?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  submittedRequestId?: string;
};

const PublicEasyBuyDraftSchema = new mongoose.Schema<PublicEasyBuyDraft>(
  {
    anonymousId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    provider: {
      type: String,
      default: "aurapay",
      trim: true,
    },
    currentStep: {
      type: Number,
      enum: [1, 2, 3],
      default: 1,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["draft", "submitted"],
      default: "draft",
      required: true,
      index: true,
    },
    fullName: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      index: true,
    },
    iphoneModel: {
      type: String,
      trim: true,
      index: true,
    },
    capacity: {
      type: String,
      trim: true,
    },
    plan: {
      type: String,
      enum: ["Monthly", "Weekly"],
    },
    monthlyPlan: {
      type: Number,
      min: 0,
    },
    weeklyPlan: {
      type: Number,
      min: 0,
    },
    address: {
      type: String,
      trim: true,
    },
    occupation: {
      type: String,
      trim: true,
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
    submittedRequestId: {
      type: String,
      trim: true,
      index: true,
    },
  },
  { timestamps: true }
);

PublicEasyBuyDraftSchema.index({ status: 1, updatedAt: -1 });
PublicEasyBuyDraftSchema.index({ email: 1, status: 1, updatedAt: -1 });

type IPublicEasyBuyDraft = mongoose.InferSchemaType<typeof PublicEasyBuyDraftSchema>;

export default mongoose.model<IPublicEasyBuyDraft>("publiceasybuydraft", PublicEasyBuyDraftSchema);
