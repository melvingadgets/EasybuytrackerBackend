import mongoose from "mongoose";

type AuditActorRole = "Admin" | "SuperAdmin";
type AuditAction = "USER_DELETE" | "RECEIPT_APPROVE";
type AuditTargetType = "user" | "receipt";

interface AuditLog {
  actor: mongoose.Types.ObjectId;
  actorRole: AuditActorRole;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: mongoose.Types.ObjectId;
  reason: string;
  metadata?: Record<string, unknown>;
}

interface IAuditLog extends AuditLog, mongoose.Document {}

const AuditLogSchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },
    actorRole: {
      type: String,
      enum: ["Admin", "SuperAdmin"],
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: ["USER_DELETE", "RECEIPT_APPROVE"],
      required: true,
      index: true,
    },
    targetType: {
      type: String,
      enum: ["user", "receipt"],
      required: true,
      index: true,
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    reason: {
      type: String,
      default: "No reason provided",
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true }
);

AuditLogSchema.index({ createdAt: -1, action: 1 });

export default mongoose.model<IAuditLog>("auditlog", AuditLogSchema);
