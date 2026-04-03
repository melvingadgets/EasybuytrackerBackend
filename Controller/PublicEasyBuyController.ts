import { type Request, type Response } from "express";
import crypto from "crypto";
import EasyBuyCapacityPriceModel from "../Model/EasyBuyCapacityPriceModel.js";
import EasyBuyEventModel from "../Model/EasyBuyEventModel.js";
import PublicEasyBuyDraftModel from "../Model/PublicEasyBuyDraftModel.js";
import PublicEasyBuyRequestModel from "../Model/PublicEasyBuyRequestModel.js";
import { appendPricingProviderFilter, sortPricingDocsByProviderPrecedence } from "../Utils/providers/helpers.js";
import { getAllProviderSlugs, getProvider, resolveProvider } from "../Utils/providers/registry.js";
import type { FinanceProvider } from "../Utils/providers/types.js";

const MAX_SUBMITS_PER_WINDOW = 8;
const SUBMIT_WINDOW_MS = 1000 * 60 * 15;
const MAX_DRAFT_SAVES_PER_WINDOW = 25;
const DRAFT_SAVE_WINDOW_MS = 1000 * 60 * 15;
const MAX_CATALOG_READS_PER_WINDOW = 80;
const CATALOG_READ_WINDOW_MS = 1000 * 60;
const CATALOG_CACHE_TTL_MS = 1000 * 60 * 2;

const WHATSAPP_NUMBER = "2347086758713";
const ANONYMOUS_COOKIE_KEY = "easybuy_public_anonymous_id";
const VERIFICATION_DISABLED_MESSAGE =
  "Email verification is currently disabled. Your request is already queued for admin review.";

const submitRateLimiter = new Map<string, { count: number; windowStart: number }>();
const draftSaveRateLimiter = new Map<string, { count: number; windowStart: number }>();
const catalogRateLimiter = new Map<string, { count: number; windowStart: number }>();

type PublicCatalogPayload = {
  models: Array<{
    model: string;
    imageUrl: string;
    capacities: string[];
    allowedPlans: Array<"Monthly" | "Weekly">;
    downPaymentPercentage: number;
    pricesByCapacity: Record<string, number>;
  }>;
  planRules: FinanceProvider["planRules"];
  provider: string;
};

const catalogCacheMap = new Map<
  string,
  {
    expiresAt: number;
    payload: PublicCatalogPayload;
  }
>();

const normalizeString = (value: unknown): string => String(value ?? "").trim();
const normalizeEmail = (value: unknown): string => normalizeString(value).toLowerCase();
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const PUBLIC_EVENT_TYPES = [
  "page_view",
  "form_start",
  "provider_selected",
  "step_complete",
  "form_submit",
] as const;

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

const buildWhatsAppUrl = (params: {
  fullName: string;
  email: string;
  phone: string;
  iphoneModel: string;
  capacity: string;
  plan: "Monthly" | "Weekly";
}) => {
  const message = [
    "Hello Admin, I have submitted my EasyBuy request.",
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

const buildSafePublicCatalog = async (provider: FinanceProvider): Promise<PublicCatalogPayload> => {
  const cached = catalogCacheMap.get(provider.slug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  const pricingFilter: Record<string, unknown> = {};
  appendPricingProviderFilter(pricingFilter, provider);

  const pricingDocs = await EasyBuyCapacityPriceModel.find(pricingFilter)
    .select({ provider: 1, model: 1, capacity: 1, price: 1, _id: 0 })
    .lean();
  const priceLookup = provider.buildPriceLookup(
    sortPricingDocsByProviderPrecedence(pricingDocs, provider)
  );

  const models = provider.catalog.map((entry) => {
    const pricesByCapacityRaw = provider.getModelPrices(priceLookup, entry.model);
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

  const payload: PublicCatalogPayload = {
    models,
    planRules: provider.planRules,
    provider: provider.slug,
  };

  catalogCacheMap.set(provider.slug, {
    expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
    payload,
  });

  return payload;
};

type DraftStep = 1 | 2 | 3;

const normalizeDraftStep = (value: unknown): DraftStep | 0 => {
  const numeric = Number(value);
  if (numeric === 1 || numeric === 2 || numeric === 3) {
    return numeric;
  }
  return 0;
};

const normalizePositiveInteger = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.floor(numeric);
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
    const provider = resolveProvider(req.query?.provider as string);
    const payload = await buildSafePublicCatalog(provider);
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

export const SavePublicEasyBuyDraftStep = async (req: Request, res: Response) => {
  const honeypot = normalizeString((req.body as any)?.website);
  if (honeypot) {
    return res.status(200).json({
      message: "Draft saved",
    });
  }

  const ipAddress = getClientIp(req);
  const limiterKey = `${ipAddress}::${normalizeString(req.headers["user-agent"])}`;
  if (isRateLimited(limiterKey, draftSaveRateLimiter, MAX_DRAFT_SAVES_PER_WINDOW, DRAFT_SAVE_WINDOW_MS)) {
    return res.status(429).json({
      message: "Too many draft save attempts. Please wait and try again.",
    });
  }

  try {
    const step = normalizeDraftStep(req.body?.step);
    if (!step) {
      return res.status(400).json({
        message: "step must be one of 1, 2, or 3",
      });
    }

    const anonymousId = ensureAnonymousId(req, res);
    const provider = resolveProvider(req.body?.provider as string);
    const fullName = normalizeString(req.body?.fullName);
    const email = normalizeEmail(req.body?.email);
    const phone = normalizeString(req.body?.phone);
    const iphoneModel = normalizeString(req.body?.iphoneModel);
    const capacity = provider.normalizeCapacityInput(req.body?.capacity);
    const plan = normalizeString(req.body?.plan) as "Monthly" | "Weekly";
    const address = normalizeString(req.body?.address);
    const occupation = normalizeString(req.body?.occupation);
    const monthlyPlan = normalizePositiveInteger(req.body?.monthlyPlan);
    const weeklyPlan = normalizePositiveInteger(req.body?.weeklyPlan);

    const updatePayload: Record<string, unknown> = {
      provider: provider.slug,
      currentStep: step,
      status: "draft",
      ipAddress,
      userAgent: normalizeString(req.headers["user-agent"]),
      referrer: normalizeString(req.body?.referrer || req.headers.referer),
      landingPage: normalizeString(req.body?.landingPage),
      utmSource: normalizeString(req.body?.utmSource),
      utmMedium: normalizeString(req.body?.utmMedium),
      utmCampaign: normalizeString(req.body?.utmCampaign),
      utmTerm: normalizeString(req.body?.utmTerm),
      utmContent: normalizeString(req.body?.utmContent),
    };
    const unsetPayload: Record<string, "" | 1> = {};

    if (fullName) updatePayload.fullName = fullName;
    if (email) updatePayload.email = email;
    if (phone) updatePayload.phone = phone;
    if (iphoneModel) updatePayload.iphoneModel = iphoneModel;
    if (capacity) updatePayload.capacity = capacity;
    if (plan) updatePayload.plan = plan;
    if (address) updatePayload.address = address;
    if (occupation) updatePayload.occupation = occupation;

    if (step === 1) {
      if (!fullName || !email || !phone) {
        return res.status(400).json({
          message: "fullName, email, and phone are required for step 1",
        });
      }
    }

    if (step === 2) {
      if (!iphoneModel || !capacity || !plan) {
        return res.status(400).json({
          message: "iphoneModel, capacity, and plan are required for step 2",
        });
      }

      const catalogEntry = provider.catalogMap.get(iphoneModel);
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

      if (plan === "Monthly") {
        if (!monthlyPlan || !provider.planRules.monthlyDurations.includes(monthlyPlan)) {
          return res.status(400).json({
            message: "A valid monthlyPlan is required for Monthly plan",
          });
        }
        updatePayload.monthlyPlan = monthlyPlan;
        unsetPayload.weeklyPlan = "";
      } else {
        if (!weeklyPlan || !provider.planRules.weeklyDurations.includes(weeklyPlan)) {
          return res.status(400).json({
            message: "A valid weeklyPlan is required for Weekly plan",
          });
        }
        updatePayload.weeklyPlan = weeklyPlan;
        unsetPayload.monthlyPlan = "";
      }
    }

    if (step === 3) {
      if (!address || !occupation) {
        return res.status(400).json({
          message: "address and occupation are required for step 3",
        });
      }
    }

    const updateQuery: Record<string, unknown> = {
      $set: updatePayload,
    };

    if (Object.keys(unsetPayload).length) {
      updateQuery.$unset = unsetPayload;
    }

    const saved = await PublicEasyBuyDraftModel.findOneAndUpdate({ anonymousId }, updateQuery, {
      upsert: true,
      returnDocument: "after",
    }).lean();

    return res.status(200).json({
      message: "Draft step saved",
      data: {
        anonymousId,
        currentStep: saved?.currentStep || step,
        status: saved?.status || "draft",
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to save draft step",
      reason: error?.message || "Unknown error",
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
    const provider = resolveProvider(req.body?.provider as string);
    const capacity = provider.normalizeCapacityInput(req.body?.capacity);
    const plan = normalizeString(req.body?.plan) as "Monthly" | "Weekly";

    if (!fullName || !email || !phone || !iphoneModel || !capacity || !plan) {
      return res.status(400).json({
        message: "fullName, email, phone, iphoneModel, capacity, and plan are required",
      });
    }

    const catalogEntry = provider.catalogMap.get(iphoneModel);
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
        message: "You already have an active request for this device. Contact support for assistance.",
        data: {
          requestId: existingOpenRequest.requestId,
          status: existingOpenRequest.status,
        },
      });
    }

    const requestId = `EBR-${Date.now().toString(36).toUpperCase()}-${crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()}`;
    const anonymousId = ensureAnonymousId(req, res);

    const created = await PublicEasyBuyRequestModel.create({
      requestId,
      provider: provider.slug,
      fullName,
      email,
      phone,
      iphoneModel,
      capacity,
      plan,
      status: "verified",
      verifiedAt: new Date(),
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
    });

    try {
      await PublicEasyBuyDraftModel.deleteOne({ anonymousId });
    } catch (draftCleanupError: any) {
      console.error("[public-request] created request but failed to delete draft", {
        anonymousId,
        error: draftCleanupError?.message || "Unknown cleanup error",
      });
    }

    return res.status(201).json({
      message: "Request submitted successfully. An admin will contact you soon.",
      data: {
        requestId: created.requestId,
        status: created.status,
        provider: provider.slug,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to submit request",
      reason: error?.message || "Unknown error",
    });
  }
};

export const ResendPublicEasyBuyVerification = async (_req: Request, res: Response) => {
  try {
    return res.status(200).json({
      message: VERIFICATION_DISABLED_MESSAGE,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to process request",
      reason: error?.message || "Unknown error",
    });
  }
};

export const VerifyPublicEasyBuyRequest = async (req: Request, res: Response) => {
  try {
    const token = normalizeString(req.query?.token);
    if (!token) {
      return res.status(200).json({
        message: VERIFICATION_DISABLED_MESSAGE,
      });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const request = await PublicEasyBuyRequestModel.findOne({
      verificationTokenHash: tokenHash,
    }).lean();

    if (!request) {
      return res.status(200).json({
        message: VERIFICATION_DISABLED_MESSAGE,
      });
    }

    let status = request.status;

    if (request.status === "pending_verification") {
      await PublicEasyBuyRequestModel.updateOne(
        { _id: request._id, status: "pending_verification" },
        {
          $set: {
            status: "verified",
            verifiedAt: new Date(),
          },
        }
      );
      status = "verified";
    }

    return res.status(200).json({
      message: VERIFICATION_DISABLED_MESSAGE,
      data: {
        requestId: request.requestId,
        status,
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

export const GetPublicProviders = async (req: Request, res: Response) => {
  const ipAddress = getClientIp(req);
  const limiterKey = `${ipAddress}::${normalizeString(req.headers["user-agent"])}`;
  if (isRateLimited(limiterKey, catalogRateLimiter, MAX_CATALOG_READS_PER_WINDOW, CATALOG_READ_WINDOW_MS)) {
    return res.status(429).json({
      message: "Too many requests. Please wait and try again.",
    });
  }

  try {
    const providers = getAllProviderSlugs()
      .map((slug) => {
        const provider = getProvider(slug);
        return provider ? { slug: provider.slug, displayName: provider.displayName } : null;
      })
      .filter(Boolean);

    return res.status(200).json({
      message: "Providers retrieved successfully",
      data: providers,
    });
  } catch (_error: any) {
    return res.status(400).json({
      message: "Failed to retrieve providers",
    });
  }
};

export const TrackPublicEvent = async (req: Request, res: Response) => {
  try {
    const anonymousId = normalizeString(req.body?.anonymousId);
    const event = normalizeString(req.body?.event);

    if (!anonymousId || !PUBLIC_EVENT_TYPES.includes(event as (typeof PUBLIC_EVENT_TYPES)[number])) {
      return res.status(400).json({
        message: "anonymousId and a valid event are required",
      });
    }

    const provider = String(req.body?.provider || "").trim().toLowerCase() || undefined;
    const meta = isPlainObject(req.body?.meta) ? req.body.meta : {};
    const utmSource = normalizeString(req.body?.utmSource) || undefined;
    const utmMedium = normalizeString(req.body?.utmMedium) || undefined;
    const utmCampaign = normalizeString(req.body?.utmCampaign) || undefined;
    const utmTerm = normalizeString(req.body?.utmTerm) || undefined;
    const utmContent = normalizeString(req.body?.utmContent) || undefined;
    const referrer = normalizeString(req.body?.referrer) || undefined;
    const landingPage = normalizeString(req.body?.landingPage) || undefined;

    await EasyBuyEventModel.create({
      anonymousId,
      event,
      meta,
      ...(provider ? { provider } : {}),
      ...(utmSource ? { utmSource } : {}),
      ...(utmMedium ? { utmMedium } : {}),
      ...(utmCampaign ? { utmCampaign } : {}),
      ...(utmTerm ? { utmTerm } : {}),
      ...(utmContent ? { utmContent } : {}),
      ...(referrer ? { referrer } : {}),
      ...(landingPage ? { landingPage } : {}),
    });

    return res.status(200).json({ message: "ok" });
  } catch (_error: any) {
    return res.status(500).json({
      message: "Failed to track event",
    });
  }
};
