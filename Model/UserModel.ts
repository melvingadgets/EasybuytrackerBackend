import mongoose from "mongoose";
interface user {
  fullName: string;
  email: string;
  password: string;
  role: "User" | "Admin";
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
      enum: ["User", "Admin"],
      default: "User",
    },
  },
  { timestamps: true }
);
export default mongoose.model<Iuser>("user", UserSchema);
