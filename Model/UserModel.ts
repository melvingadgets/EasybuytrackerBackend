import mongoose from "mongoose";
interface user {
  fullName: string;
  email: string;
  password: string;
  role: "User" | "Admin" | "SuperAdmin";
  createdUsers: mongoose.Types.ObjectId[];
  createdByAdmin: mongoose.Types.ObjectId | null;
  manualNextDueDate?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface Iuser extends user, mongoose.Document {}
const UserSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // Required for existing authentication flow.
    password: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ["User", "Admin", "SuperAdmin"],
      default: "User",
    },
    createdUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
      },
    ],
    createdByAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      default: null,
      index: true,
    },
    manualNextDueDate: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);
export default mongoose.model<Iuser>("user", UserSchema);
