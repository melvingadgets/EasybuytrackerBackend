import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { config } from "../config/Config.js";
import { syncLocalShadowUser, toLegacyRole } from "../Service/AuthService.js";

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

    const normalizedRole = toLegacyRole(String(payload.role || ""));
    const normalizedName = String(payload.fullName || payload.userName || "");

    await syncLocalShadowUser({
      _id: String(payload._id),
      email: String(payload.email || ""),
      fullName: normalizedName,
      role:
        normalizedRole === "Admin"
          ? "admin"
          : normalizedRole === "SuperAdmin"
            ? "superadmin"
            : "user",
    });

    const currentUser: Request["user"] = {
      _id: String(payload._id),
      userName: normalizedName,
      email: String(payload.email || ""),
      role: normalizedRole,
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
