import mongoose from "mongoose";

const EASYBUY_EVENT_TYPES = [
  "page_view",
  "form_start",
  "provider_selected",
  "step_complete",
  "form_submit",
] as const;

type EasyBuyEventType = (typeof EASYBUY_EVENT_TYPES)[number];

type EasyBuyEvent = {
  anonymousId: string;
  event: EasyBuyEventType;
  provider?: string;
  meta?: Record<string, unknown>;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  referrer?: string;
  landingPage?: string;
};

const EasyBuyEventSchema = new mongoose.Schema<EasyBuyEvent>(
  {
    anonymousId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    event: {
      type: String,
      enum: EASYBUY_EVENT_TYPES,
      required: true,
      trim: true,
      index: true,
    },
    provider: {
      type: String,
      trim: true,
      lowercase: true,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
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
    referrer: {
      type: String,
      trim: true,
    },
    landingPage: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

EasyBuyEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

type IEasyBuyEvent = mongoose.InferSchemaType<typeof EasyBuyEventSchema>;

export default mongoose.model<IEasyBuyEvent>("easybuyevent", EasyBuyEventSchema);
