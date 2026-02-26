import mongoose from "mongoose";

type SessionRole = "User" | "Admin" | "SuperAdmin";

interface Session {
  user: mongoose.Types.ObjectId;
  role: SessionRole;
  jti: string;
  active: boolean;
  loginAt: Date;
  logoutAt?: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

interface ISession extends Session, mongoose.Document {}

const SessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["User", "Admin", "SuperAdmin"],
      required: true,
      index: true,
    },
    jti: {
      type: String,
      required: true,
      unique: true,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    loginAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    logoutAt: {
      type: Date,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

SessionSchema.index({ active: 1, role: 1, expiresAt: 1 });
SessionSchema.index({ user: 1, active: 1 });

export default mongoose.model<ISession>("session", SessionSchema);
