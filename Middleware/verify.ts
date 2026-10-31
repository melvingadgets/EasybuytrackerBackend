import type { NextFunction, Request, Response } from "express";
import { isDomainRole, isPlatformRole } from "@melvingadgets/platform-kit";
import jwt, { type JwtPayload } from "jsonwebtoken";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";
import { config } from "../config/Config.js";
import { platformVerifier } from "../Utils/platform.js";
import { getAuthMe, syncLocalShadowUser } from "../Service/AuthService.js";

// A platform (unified) token is RS256; EasyBuy's own token is HS256. Reading the
// header alone is enough to route it — the signature is still fully verified below.
const isPlatformToken = (token: string): boolean => {
  try {
    const header = JSON.parse(Buffer.from(token.split(".")[0] || "", "base64url").toString("utf8"));
    return header?.alg === "RS256";
  } catch {
    return false;
  }
};

type AppRole = "Admin" | "User" | "SuperAdmin";

type TokenPayload = JwtPayload & {
  _id: string;
  fullName?: string;
  userName?: string;
  // The canonical spelling only. The lowercase dialect is refused by `isPlatformRole`
  // below rather than mapped, so a legacy token with `"admin"` fails closed.
  role?: unknown;
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
    // Unified token (Shortwork/AGENTS.md §2): verify against the auth JWKS and
    // resolve the person to their local EasyBuy record. Runs alongside the legacy
    // token (§7.1) so nothing breaks before every client has moved.
    if (isPlatformToken(token) && platformVerifier) {
      const person = await platformVerifier.verifyUserToken(token);

      type ResolvedUser = { _id: unknown; fullName?: string | null; email?: string | null; role?: string | null };
      let user: ResolvedUser | null = await UserModel.findOne({
        $or: [{ personId: person.personId }, { _id: person.personId }],
      })
        .select({ _id: 1, fullName: 1, email: 1, role: 1 })
        .lean();

      if (!user) {
        // Not migrated yet: fetch the profile from auth (with the user's own token).
        // Link an existing EasyBuy customer by email first so their items aren't
        // orphaned; only create a shadow if there's no match. Best-effort → 401.
        try {
          const me = await getAuthMe(token);
          const authUser = me.data?.user;
          if (authUser) {
            const email = String(authUser.email || "").toLowerCase().trim();
            const byEmail = email
              ? await UserModel.findOne({ email }).select({ _id: 1, fullName: 1, email: 1, role: 1 }).lean()
              : null;
            if (byEmail) {
              await UserModel.updateOne({ _id: byEmail._id }, { $set: { personId: person.personId } });
              user = byEmail;
            } else {
              const shadow = await syncLocalShadowUser(authUser);
              if (shadow) {
                user = { _id: shadow._id, fullName: shadow.fullName, email: shadow.email, role: shadow.role };
              }
            }
          }
        } catch {
          // fall through to the 401 below
        }
      }

      if (!user) {
        return res.status(401).json({ message: "user not found" });
      }

      // The role is the *verified claim*, not the local record. A role change in auth
      // now takes effect on the next token, without waiting for this shadow row to sync,
      // and there is no local value to fall back to.
      if (!isPlatformRole(person.role)) {
        return res.status(401).json({ message: "invalid token payload" });
      }
      const platformUser: Request["user"] = {
        _id: String(user._id),
        userName: String(user.fullName || ""),
        email: String(user.email || ""),
        role: person.role,
        domainRoles: person.domainRoles,
      };
      // The session lives in auth; the short-lived token plus (future) revocation
      // events are the check here, so there's no local SessionModel lookup.
      platformUser.jti = person.sessionId;
      req.user = platformUser;
      req.authToken = token;
      return next();
    }

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

    // No `|| "User"` fallback: a record whose role is missing or not canonical is a
    // 401, not an ordinary account. Defaulting here is what let a broken role look
    // like a working login.
    if (!isPlatformRole(user.role)) {
      return res.status(401).json({ message: "invalid token payload" });
    }
    const currentUser: Request["user"] = {
      _id: String(user._id),
      userName: String(user.fullName || payload.fullName || payload.userName || ""),
      email: String(user.email || payload.email || ""),
      role: user.role,
      domainRoles: Array.isArray(payload.domainRoles) ? payload.domainRoles.filter(isDomainRole) : [],
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

// `requireRole` used to live here. It's gone: every route now names the permission it
// needs from `@melvingadgets/platform-kit` (docs/rbac-unification.md). The old version
// was also wrong in a way that mattered — `requireRole(["Admin"])` returned 403 for a
// SuperAdmin, because it compared a list instead of a rank.
