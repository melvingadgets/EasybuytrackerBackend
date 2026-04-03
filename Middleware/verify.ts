import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";
import { config } from "../config/Config.js";

type AppRole = "Admin" | "User" | "SuperAdmin";

type TokenPayload = JwtPayload & {
  _id: string;
  fullName?: string;
  userName?: string;
  role: "user" | "admin" | "superadmin" | AppRole;
  email: string;
  jti?: string;
};

const JWT_SECRET = config.auth.jwtSecret;

const getTokenFromRequest = (req: Request): string => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.split(" ")[1] || "";
  }

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return "";

  const sessionCookie = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("sessionId="));

  return sessionCookie?.split("=")[1] || "";
};

export const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({
      message: "please login to get token",
    });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
    if (!payload?._id) {
      return res.status(401).json({ message: "invalid token payload" });
    }

    const user = await UserModel.findById(payload._id)
      .select({ _id: 1, fullName: 1, email: 1, role: 1 })
      .lean();
    if (!user) {
      return res.status(401).json({ message: "user not found" });
    }

    if (payload.jti) {
      const activeSession = await SessionModel.findOneAndUpdate(
        {
          user: user._id,
          jti: String(payload.jti),
          active: true,
          expiresAt: { $gt: new Date() },
        },
        {
          $set: {
            lastSeenAt: new Date(),
          },
        },
        { returnDocument: "after" }
      ).lean();

      if (!activeSession) {
        return res.status(401).json({ message: "session expired" });
      }
    }

    const currentUser: Request["user"] = {
      _id: String(user._id),
      userName: String(user.fullName || payload.fullName || payload.userName || ""),
      email: String(user.email || payload.email || ""),
      role: String(user.role || "User") as AppRole,
    };
    if (payload.jti) {
      currentUser.jti = String(payload.jti);
    }

    req.user = currentUser;
    req.authToken = token;

    next();
  } catch (_error) {
    return res.status(401).json({ message: "token expire" });
  }
};

export const requireRole =
  (allowedRoles: Array<AppRole>) => (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({
        message: "Access denied",
      });
    }
    next();
  };
