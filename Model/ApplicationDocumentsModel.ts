import mongoose from "mongoose";

// The documents attached to one Apply request (Utils/applicationDocuments.ts). Kept apart from the
// request itself, which is listed in many places, so this sensitive data is only ever read by the
// routes that need it. Files are private Cloudinary assets; the NIN is `select: false` so it is
// only read by the route that shows it.

const storedFileSchema = new mongoose.Schema(
  {
    fileId: { type: String, required: true },
    publicId: { type: String, required: true },
    resourceType: { type: String, enum: ["image", "raw"], required: true },
    format: { type: String, required: true },
    mime: { type: String, required: true },
    bytes: { type: Number, required: true },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false }
);

const ApplicationDocumentsSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, trim: true },
    // The 11-digit NIN as the applicant typed it. Stored in plain text by the owner's decision on
    // 2026-10-28 (no encryption, no key); only the SuperAdmin documents route selects it.
    nin: { type: String, select: false },
    ninLast4: { type: String },
    ninUpdatedAt: { type: Date },
    bankStatements: { type: [storedFileSchema], default: [] },
    // The applicant confirmed the down payment was in the account before they generated the
    // statement.
    downPaymentConfirmedAt: { type: Date },
    ninSelfie: { type: storedFileSchema, default: null },
  },
  { timestamps: true }
);

// One documents record per request (Shortwork/AGENTS.md §3.8).
ApplicationDocumentsSchema.index({ requestId: 1 }, { unique: true });

export type ApplicationDocumentFile = mongoose.InferSchemaType<typeof storedFileSchema>;

export default mongoose.model("applicationdocuments", ApplicationDocumentsSchema);
