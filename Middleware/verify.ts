import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import SessionModel from "../Model/SessionModel.js";

type AppRole = "Admin" | "User" | "SuperAdmin";

type TokenPayload = JwtPayload & {
  _id: string;
  userName: string;
  role: AppRole;
  email: string;
  jti?: string;
};

const JWT_SECRET = "variationofeventsisatrandom";

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
    if (!payload?._id || !payload?.role || !payload?.email || !payload?.userName) {
      return res.status(401).json({ message: "invalid token payload" });
    }

    if (payload.jti) {
      const now = new Date();
      const activeSession = await SessionModel.findOneAndUpdate(
        {
          jti: payload.jti,
          user: payload._id,
          active: true,
          expiresAt: { $gt: now },
        },
        { $set: { lastSeenAt: now } }
      ).lean();

      if (!activeSession) {
        return res.status(401).json({ message: "session inactive or expired" });
      }
    }

    const currentUser: Request["user"] = {
      _id: String(payload._id),
      userName: String(payload.userName),
      email: String(payload.email),
      role: payload.role,
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
