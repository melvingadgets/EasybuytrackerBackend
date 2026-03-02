import { type Request, type Response } from "express";
import crypto from "crypto";
import EasyBuyCapacityPriceModel from "../Model/EasyBuyCapacityPriceModel.js";
import PublicEasyBuyRequestModel from "../Model/PublicEasyBuyRequestModel.js";
import { EASYBUY_CATALOG, EASYBUY_CATALOG_MAP, EASYBUY_PLAN_RULES, normalizeCapacityInput } from "../Utils/EasyBuyCatalog.js";
import { buildEasyBuyPriceLookup, getModelPricesByCapacity } from "../Utils/EasyBuyPricing.js";
import { sendEasyBuyVerificationEmail } from "../Utils/Mailer.js";

const VERIFY_TOKEN_TTL_MS = 1000 * 60 * 30;
const RESEND_COOLDOWN_MS = 1000 * 60;
const MAX_RESEND_COUNT = 8;
const MAX_SUBMITS_PER_WINDOW = 8;
const SUBMIT_WINDOW_MS = 1000 * 60 * 15;
const MAX_CATALOG_READS_PER_WINDOW = 80;
const CATALOG_READ_WINDOW_MS = 1000 * 60;
const CATALOG_CACHE_TTL_MS = 1000 * 60 * 2;

const WHATSAPP_NUMBER = "2347086758713";
const ANONYMOUS_COOKIE_KEY = "easybuy_public_anonymous_id";

const submitRateLimiter = new Map<string, { count: number; windowStart: number }>();
const catalogRateLimiter = new Map<string, { count: number; windowStart: number }>();
let catalogCache: {
  expiresAt: number;
  payload: {
    models: Array<{
      model: string;
      imageUrl: string;
      capacities: string[];
      allowedPlans: Array<"Monthly" | "Weekly">;
      downPaymentPercentage: 40 | 60;
      pricesByCapacity: Record<string, number>;
    }>;
    planRules: typeof EASYBUY_PLAN_RULES;
  };
} | null = null;

const normalizeString = (value: unknown): string => String(value ?? "").trim();
const normalizeEmail = (value: unknown): string => normalizeString(value).toLowerCase();

const getForwardedAddress = (value: unknown): string => {
  const resolved = String(value ?? "").split(",")[0] || "";
  return resolved.trim();
};

const getClientIp = (req: Request): string =>
  getForwardedAddress(req.headers["x-forwarded-for"]) ||
  getForwardedAddress(req.socket?.remoteAddress) ||
  "";

const getCookieValue = (req: Request, key: string): string => {
  const rawCookie = String(req.headers.cookie || "");
  if (!rawCookie) return "";

  const token = rawCookie
    .split(";")
    .map((segment) => segment.trim())
    .find((segment) => segment.startsWith(`${key}=`));

  return token ? decodeURIComponent(token.split("=")[1] || "") : "";
};

const setAnonymousCookie = (res: Response, value: string) => {
  const secureFlag = String(process.env.NODE_ENV || "").toLowerCase() === "production" ? "; Secure" : "";
  const cookie = `${ANONYMOUS_COOKIE_KEY}=${encodeURIComponent(
    value
  )}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secureFlag}`;
  res.append("Set-Cookie", cookie);
};

const ensureAnonymousId = (req: Request, res: Response): string => {
  const fromCookie = getCookieValue(req, ANONYMOUS_COOKIE_KEY);
  const fromBody = normalizeString((req.body as any)?.anonymousId);
  const resolved = fromCookie || fromBody || crypto.randomUUID();

  if (!fromCookie) {
    setAnonymousCookie(res, resolved);
  }
  return resolved;
};

const buildVerifyToken = () => {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);
  return { raw, hash, expiresAt };
};

const getPublicAppBaseUrl = () => {
  const configured =
    normalizeString(process.env.PUBLIC_APP_BASE_URL) ||
    normalizeString(process.env.APP_PUBLIC_BASE_URL);
  return configured.replace(/\/+$/, "");
};

const buildVerificationUrl = (token: string) =>
  `${getPublicAppBaseUrl()}/apply/verify?token=${encodeURIComponent(token)}`;

const buildWhatsAppUrl = (params: {
  fullName: string;
  email: string;
  phone: string;
  iphoneModel: string;
  capacity: string;
  plan: "Monthly" | "Weekly";
}) => {
  const message = [
    "Hello Admin, I have verified my EasyBuy request.",
    `Name: ${params.fullName}`,
    `Email: ${params.email}`,
    `Phone: ${params.phone}`,
    `Device: ${params.iphoneModel} (${params.capacity})`,
    `Plan: ${params.plan}`,
  ].join("\n");

  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
};

const isRateLimited = (
  key: string,
  limiterStore: Map<string, { count: number; windowStart: number }>,
  maxRequests: number,
  windowMs: number
): boolean => {
  const now = Date.now();
  const existing = limiterStore.get(key);
  if (!existing || now - existing.windowStart > windowMs) {
    limiterStore.set(key, { count: 1, windowStart: now });
    return false;
  }

  existing.count += 1;
  limiterStore.set(key, existing);
  return existing.count > maxRequests;
};

const buildSafePublicCatalog = async () => {
  if (catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.payload;
  }

  const pricingDocs = await EasyBuyCapacityPriceModel.find()
    .select({ model: 1, capacity: 1, price: 1, _id: 0 })
    .lean();
  const priceLookup = buildEasyBuyPriceLookup(pricingDocs);

  const models = EASYBUY_CATALOG.map((entry) => {
    const pricesByCapacityRaw = getModelPricesByCapacity(priceLookup, entry.model);
    const safePricesByCapacity: Record<string, number> = {};

    for (const capacity of entry.capacities) {
      const rawPrice = Number(pricesByCapacityRaw?.[capacity]);
      if (Number.isFinite(rawPrice) && rawPrice > 0) {
        safePricesByCapacity[capacity] = rawPrice;
      }
    }

    return {
      ...entry,
      pricesByCapacity: safePricesByCapacity,
    };
  });

  const payload = {
    models,
    planRules: EASYBUY_PLAN_RULES,
  };

  catalogCache = {
    expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
    payload,
  };

  return payload;
};

export const GetPublicEasyBuyCatalog = async (req: Request, res: Response) => {
  const ipAddress = getClientIp(req);
  const limiterKey = `${ipAddress}::${normalizeString(req.headers["user-agent"])}`;
  if (isRateLimited(limiterKey, catalogRateLimiter, MAX_CATALOG_READS_PER_WINDOW, CATALOG_READ_WINDOW_MS)) {
    return res.status(429).json({
      message: "Too many catalog requests. Please wait and try again.",
    });
  }

  try {
    const payload = await buildSafePublicCatalog();
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");

    return res.status(200).json({
      message: "Public EasyBuy catalog retrieved successfully",
      data: payload,
    });
  } catch (_error: any) {
    console.error("[public-catalog] failed to retrieve public easybuy catalog");
    return res.status(400).json({
      message: "Failed to retrieve catalog",
    });
  }
};

export const CreatePublicEasyBuyRequest = async (req: Request, res: Response) => {
  const honeypot = normalizeString((req.body as any)?.website);
  if (honeypot) {
    return res.status(200).json({
      message: "Request submitted successfully",
    });
  }

  const ipAddress = getClientIp(req);
  const limiterKey = `${ipAddress}::${normalizeString(req.headers["user-agent"])}`;
  if (isRateLimited(limiterKey, submitRateLimiter, MAX_SUBMITS_PER_WINDOW, SUBMIT_WINDOW_MS)) {
    return res.status(429).json({
      message: "Too many requests. Please wait and try again.",
    });
  }

  try {
    const fullName = normalizeString(req.body?.fullName);
    const email = normalizeEmail(req.body?.email);
    const phone = normalizeString(req.body?.phone);
    const iphoneModel = normalizeString(req.body?.iphoneModel);
    const capacity = normalizeCapacityInput(req.body?.capacity);
    const plan = normalizeString(req.body?.plan) as "Monthly" | "Weekly";

    if (!fullName || !email || !phone || !iphoneModel || !capacity || !plan) {
      return res.status(400).json({
        message: "fullName, email, phone, iphoneModel, capacity, and plan are required",
      });
    }

    const catalogEntry = EASYBUY_CATALOG_MAP.get(iphoneModel);
    if (!catalogEntry) {
      return res.status(400).json({
        message: "Unsupported iPhone model",
      });
    }
    if (!catalogEntry.capacities.includes(capacity)) {
      return res.status(400).json({
        message: `Capacity ${capacity} is unavailable for ${iphoneModel}`,
      });
    }
    if (!catalogEntry.allowedPlans.includes(plan)) {
      return res.status(400).json({
        message: `Plan must be one of: ${catalogEntry.allowedPlans.join(", ")}`,
      });
    }

    const existingOpenRequest = await PublicEasyBuyRequestModel.findOne({
      email,
      iphoneModel,
      capacity,
      status: { $in: ["pending_verification", "verified", "approved"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (existingOpenRequest) {
      return res.status(409).json({
        message:
          "You already have an active request for this device. Use resend verification email or contact support.",
        data: {
          requestId: existingOpenRequest.requestId,
          status: existingOpenRequest.status,
        },
      });
    }

    const { raw: verificationToken, hash: verificationTokenHash, expiresAt } = buildVerifyToken();
    const requestId = `EBR-${Date.now().toString(36).toUpperCase()}-${crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()}`;
    const anonymousId = ensureAnonymousId(req, res);

    const created = await PublicEasyBuyRequestModel.create({
      requestId,
      fullName,
      email,
      phone,
      iphoneModel,
      capacity,
      plan,
      status: "pending_verification",
      anonymousId,
      ipAddress,
      userAgent: normalizeString(req.headers["user-agent"]),
      referrer: normalizeString(req.body?.referrer || req.headers.referer),
      landingPage: normalizeString(req.body?.landingPage),
      utmSource: normalizeString(req.body?.utmSource),
      utmMedium: normalizeString(req.body?.utmMedium),
      utmCampaign: normalizeString(req.body?.utmCampaign),
      utmTerm: normalizeString(req.body?.utmTerm),
      utmContent: normalizeString(req.body?.utmContent),
      verificationTokenHash,
      verificationTokenExpiresAt: expiresAt,
      resendCount: 0,
    });

    const verifyUrl = buildVerificationUrl(verificationToken);
    try {
      await sendEasyBuyVerificationEmail({
        to: email,
        fullName,
        verifyUrl,
        requestId: created.requestId,
        iphoneModel,
        capacity,
        plan,
      });

      await PublicEasyBuyRequestModel.updateOne(
        { _id: created._id },
        {
          $set: {
            lastVerificationSentAt: new Date(),
          },
        }
      );

      return res.status(201).json({
        message: "Request submitted. Please verify your email to continue.",
        data: {
          requestId: created.requestId,
          status: created.status,
        },
      });
    } catch (emailError: any) {
      console.error("[public-request] request created but verification email failed", {
        requestId: created.requestId,
        error: emailError?.message || "Unknown mail error",
      });

      return res.status(202).json({
        message:
          "Request saved, but verification email could not be sent right now. Use resend verification email.",
        data: {
          requestId: created.requestId,
          status: created.status,
          emailDelivery: "failed",
        },
      });
    }
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to submit request",
      reason: error?.message || "Unknown error",
    });
  }
};

export const ResendPublicEasyBuyVerification = async (req: Request, res: Response) => {
  try {
    const requestId = normalizeString(req.body?.requestId);
    const email = normalizeEmail(req.body?.email);

    if (!requestId && !email) {
      return res.status(400).json({
        message: "requestId or email is required",
      });
    }

    const query = requestId ? { requestId } : { email };
    const existing = await PublicEasyBuyRequestModel.findOne(query)
      .sort({ createdAt: -1 })
      .lean();

    if (!existing) {
      return res.status(200).json({
        message: "If a request exists, a verification email has been sent.",
      });
    }

    if (existing.status !== "pending_verification") {
      return res.status(200).json({
        message: "Email is already verified or request is no longer awaiting verification.",
        data: {
          requestId: existing.requestId,
          status: existing.status,
        },
      });
    }

    const lastSent = existing.lastVerificationSentAt
      ? new Date(existing.lastVerificationSentAt).getTime()
      : 0;
    const now = Date.now();
    const elapsed = now - lastSent;

    if (elapsed < RESEND_COOLDOWN_MS) {
      return res.status(429).json({
        message: "Please wait before requesting another verification email.",
        data: {
          retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000),
        },
      });
    }

    if (Number(existing.resendCount || 0) >= MAX_RESEND_COUNT) {
      return res.status(429).json({
        message: "Verification resend limit reached. Please contact support.",
      });
    }

    const token = buildVerifyToken();
    await PublicEasyBuyRequestModel.updateOne(
      { _id: existing._id },
      {
        $set: {
          verificationTokenHash: token.hash,
          verificationTokenExpiresAt: token.expiresAt,
          lastVerificationSentAt: new Date(),
        },
        $inc: {
          resendCount: 1,
        },
      }
    );

    await sendEasyBuyVerificationEmail({
      to: existing.email,
      fullName: existing.fullName,
      verifyUrl: buildVerificationUrl(token.raw),
      requestId: existing.requestId,
      iphoneModel: existing.iphoneModel,
      capacity: existing.capacity,
      plan: existing.plan,
    });

    return res.status(200).json({
      message: "Verification email sent",
      data: {
        requestId: existing.requestId,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to resend verification email",
      reason: error?.message || "Unknown error",
    });
  }
};

export const VerifyPublicEasyBuyRequest = async (req: Request, res: Response) => {
  try {
    const token = normalizeString(req.query?.token);
    if (!token) {
      return res.status(400).json({
        message: "Verification token is required",
      });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const request = await PublicEasyBuyRequestModel.findOne({
      verificationTokenHash: tokenHash,
    }).lean();

    if (!request) {
      return res.status(400).json({
        message: "Invalid or expired verification token",
      });
    }

    if (request.status !== "pending_verification") {
      return res.status(200).json({
        message: "Request already verified",
        data: {
          requestId: request.requestId,
          status: request.status,
          whatsappUrl: buildWhatsAppUrl({
            fullName: request.fullName,
            email: request.email,
            phone: request.phone,
            iphoneModel: request.iphoneModel,
            capacity: request.capacity,
            plan: request.plan,
          }),
        },
      });
    }

    const isExpired =
      !request.verificationTokenExpiresAt ||
      new Date(request.verificationTokenExpiresAt).getTime() < Date.now();
    if (isExpired) {
      return res.status(400).json({
        message: "Verification token expired. Please request another verification email.",
      });
    }

    await PublicEasyBuyRequestModel.updateOne(
      { _id: request._id, status: "pending_verification" },
      {
        $set: {
          status: "verified",
          verifiedAt: new Date(),
        },
      }
    );

    return res.status(200).json({
      message: "Email verified successfully",
      data: {
        requestId: request.requestId,
        status: "verified",
        whatsappUrl: buildWhatsAppUrl({
          fullName: request.fullName,
          email: request.email,
          phone: request.phone,
          iphoneModel: request.iphoneModel,
          capacity: request.capacity,
          plan: request.plan,
        }),
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to verify request",
      reason: error?.message || "Unknown error",
    });
  }
};
