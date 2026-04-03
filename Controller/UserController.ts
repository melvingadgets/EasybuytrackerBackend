import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import UserModel from "../Model/UserModel.js";
import {type Response, type Request} from "express";
import EasyBoughtItemModel from "../Model/EasyBoughtitem.js";
import EasyBuyCapacityPriceModel from "../Model/EasyBuyCapacityPriceModel.js";
import mongoose from "mongoose";
import { config } from "../config/Config.js";
import {
  appendPricingProviderFilter,
  getReadProvider,
  getWriteProvider,
  sortPricingDocsByProviderPrecedence,
} from "../Utils/providers/helpers.js";
import { getDefaultProvider } from "../Utils/providers/registry.js";
import type { CatalogEntry, FinanceProvider } from "../Utils/providers/types.js";
import {
  createAuthUser,
  findAuthUserByEmail,
  listAuthUsers,
  syncLocalShadowUser,
} from "../Service/AuthService.js";

const PROXIED_CATALOG_IMAGE_MODELS = new Set([
  "iPhone 17",
  "iPhone 17 Air",
  "iPhone 17 Pro",
  "iPhone 17 Pro Max",
]);

const GSM_ARENA_17_IMAGE_CANDIDATES: Record<string, string[]> = {
  "iPhone 17": [
    "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-17.jpg",
    "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-17-.jpg",
  ],
  "iPhone 17 Air": [
    "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-17-air.jpg",
    "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-17air.jpg",
  ],
  "iPhone 17 Pro": [
    "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-17-pro.jpg",
    "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-17pro.jpg",
  ],
  "iPhone 17 Pro Max": [
    "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-17-pro-max.jpg",
    "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-17-pro-max-.jpg",
    "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-17pro-max.jpg",
  ],
};

const DEFAULT_PROVIDER = getDefaultProvider();
const ACCESS_TOKEN_TTL_SECONDS = 40 * 60;

const getRequestBaseUrl = (req: Request): string => {
  const forwardedProto = (String(req.get("x-forwarded-proto") || "").split(",")[0] || "").trim();
  const forwardedHost = (String(req.get("x-forwarded-host") || "").split(",")[0] || "").trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || "localhost:552";
  return `${protocol}://${host}`;
};

const buildCatalogImageProxyUrl = (req: Request, provider: FinanceProvider, model: string): string =>
  `${getRequestBaseUrl(req)}/api/v1/user/easybuy-catalog-image/${encodeURIComponent(
    model
  )}?provider=${encodeURIComponent(provider.slug)}`;

const shouldProxyCatalogImage = (provider: FinanceProvider, model: string): boolean =>
  provider.slug === DEFAULT_PROVIDER.slug && PROXIED_CATALOG_IMAGE_MODELS.has(model);

const resolveCatalogImageUrl = (
  req: Request,
  provider: FinanceProvider,
  entry: CatalogEntry
): string => (shouldProxyCatalogImage(provider, entry.model) ? buildCatalogImageProxyUrl(req, provider, entry.model) : entry.imageUrl);

const getCatalogImageFetchCandidates = (provider: FinanceProvider, entry: CatalogEntry): string[] => {
  const providerCandidates =
    provider.slug === DEFAULT_PROVIDER.slug ? GSM_ARENA_17_IMAGE_CANDIDATES[entry.model] || [] : [];
  const candidates = [entry.imageUrl, ...providerCandidates];
  return Array.from(new Set(candidates));
};

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sendCatalogFallbackSvg = (res: Response, model: string) => {
  const safeModel = escapeXml(model || "iPhone");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="url(#bg)"/>
  <rect x="110" y="60" width="420" height="240" rx="28" fill="#334155" stroke="#475569" stroke-width="2"/>
  <text x="320" y="186" font-family="Arial, sans-serif" font-size="28" text-anchor="middle" fill="#f8fafc">${safeModel}</text>
  <text x="320" y="220" font-family="Arial, sans-serif" font-size="16" text-anchor="middle" fill="#cbd5e1">Preview unavailable</text>
</svg>`;
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).send(svg);
};

const isBcryptHash = (value: string): boolean => /^\$2[aby]\$\d{2}\$/.test(String(value || ""));

const verifyLocalPassword = async (candidate: string, storedPassword: string): Promise<boolean> => {
  const normalizedStored = String(storedPassword || "");
  if (!normalizedStored) return false;
  if (isBcryptHash(normalizedStored)) {
    return bcrypt.compare(candidate, normalizedStored);
  }
  return candidate === normalizedStored;
};

const signLocalAccessToken = (args: {
  _id: string;
  email: string;
  fullName: string;
  role: "User" | "Admin" | "SuperAdmin";
}): string =>
  jwt.sign(
    {
      _id: args._id,
      email: args.email,
      fullName: args.fullName,
      role:
        args.role === "Admin" ? "admin" : args.role === "SuperAdmin" ? "superadmin" : "user",
      jti: crypto.randomUUID(),
      app: "easybuy",
    },
    config.auth.jwtSecret,
    {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    }
  );


export const CreateAdmin = async (req: Request, res: Response) => {
  const checkrole = req.user?.role;
  if (checkrole !== "SuperAdmin") {
    return res.status(403).json({
      message: "You are not authorized to create admin",
    });
  }
  try {
    const { firstName, email, lastName, fullName, Password } = req.body;
    const normalizedFullName = fullName?.trim() || `${firstName || ""} ${lastName || ""}`.trim();
    if (!normalizedFullName || !email || !Password) {
      return res.status(401).json({
        message: "All fields required",
      });
    }
    const authToken = req.authToken;
    if (!authToken) {
      return res.status(401).json({ message: "Access denied" });
    }

    const created = await createAuthUser(authToken, {
      email: String(email).toLowerCase(),
      password: String(Password),
      fullName: normalizedFullName,
      role: "Admin",
    });
    const authUser = created.data?.user;
    if (!authUser) {
      return res.status(400).json({ message: "unable to create user" });
    }

    const UserData = await syncLocalShadowUser(authUser);

 return res.status(200).json({
      message: "registration was successful",
      success: 1,
      Result: {
        _id: UserData?._id || authUser._id,
        fullName: UserData?.fullName || authUser.fullName,
        email: UserData?.email || authUser.email,
        role: UserData?.role || "Admin",
      },
    });
     } catch (error: any) {
    res.status(400).json({
      message: "unable to create user",
      Reason: error.message,
    });
  }
};
export const LoginUser = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email || "").toLowerCase().trim();
    const normalizedPassword = String(password || "");

    if (!normalizedEmail || !normalizedPassword) {
      return res.status(400).json({
        message: "email and password are required",
      });
    }

    const user = await UserModel.findOne({ email: normalizedEmail }).select("+password");
    if (!user) {
      return res.status(404).json({
        message: "user does not exist",
      });
    }

    const validPassword = await verifyLocalPassword(normalizedPassword, String(user.password || ""));
    if (!validPassword) {
      return res.status(404).json({
        message: "Password is incorrect",
      });
    }

    const token = signLocalAccessToken({
      _id: String(user._id),
      email: String(user.email || ""),
      fullName: String(user.fullName || ""),
      role: user.role,
    });

    res.cookie("sessionId", token);

    return res.status(201).json({
      success: 1,
      message: "login successful",
      data: token,
    });
  } catch (error: any) {
    return res.status(error?.status || 400).json({
      message: error?.message || `unable to login because ${error}`,
    });
  } 
};
export const CreateUser = async (req: Request, res: Response) => {
const checkrole = req.user?.role;
if(checkrole !== "Admin"){
  return res.status(404).json({
    message: "You are not authorized to create user",
  });
}
  try {
    const { firstName, email, lastName, fullName, Password } = req.body;
    const normalizedFullName = fullName?.trim() || `${firstName || ""} ${lastName || ""}`.trim();
    if (!normalizedFullName || !email || !Password) {
      return res.status(401).json({
        message: "All fields required",
      });
    }

    const adminId = req.user?._id;
    const authToken = req.authToken;
    if (!adminId || !authToken) {
      return res.status(401).json({
        message: "Access denied",
      });
    }
    const created = await createAuthUser(authToken, {
      email: String(email).toLowerCase(),
      password: String(Password),
      fullName: normalizedFullName,
      role: "User",
    });
    const authUser = created.data?.user;
    if (!authUser) {
      return res.status(400).json({ message: "unable to create user" });
    }

    const UserData = await syncLocalShadowUser(authUser, {
      createdByAdmin: adminId,
      addCreatedUserToAdminId: adminId,
    });

 return res.status(200).json({
      message: "registration was successful",
      success: 1,
      Result: {
        _id: UserData?._id || authUser._id,
        fullName: UserData?.fullName || authUser.fullName,
        email: UserData?.email || authUser.email,
        role: UserData?.role || "User",
      },
    });
     } catch (error: any) {
    res.status(400).json({
      message: "unable to create user",
      Reason: error.message,
    });
  }
};


export const  GetEasyBoughtItems = async (req: Request, res: Response) => {
try {
      const userId = req.user?._id;
      if (!userId) {
        return res.status(401).json({
          message: "Access denied",
        });
      }
      {
        const easyBoughtItems = await EasyBoughtItemModel.find({UserId:userId}).lean();
        const normalizedItems = easyBoughtItems.map((item: any) => ({
          ...item,
          PhonePrice: item.PhonePrice ?? item.TotalPrice ?? 0,
          IphoneImageUrl: (() => {
            const provider = getReadProvider(item.provider);
            const model = String(item.IphoneModel || "");
            const catalogEntry = provider.catalogMap.get(model);
            return catalogEntry ? resolveCatalogImageUrl(req, provider, catalogEntry) : item.IphoneImageUrl;
          })(),
        }));
        return res.status(200).json({
          message: "EasyBoughtItems retrieved successfully",
          data: normalizedItems,
        });
      }
    }
      catch (error) {
  return res.status(404).json({
    message: "Access denied",
  });
}}

export const GetAllUsers = async (req: Request, res: Response) => {
  
    try {
      const checkrole = req.user?.role;  
    if (checkrole !== "Admin") {
      return res.status(404).json({
        message: "Access denied",
      });
    }
    else{
      const authToken = req.authToken;
      if (!authToken) {
        return res.status(401).json({ message: "Access denied" });
      }
      const payload = await listAuthUsers(authToken, { page: 1, limit: 200 });
      const authUsers = Array.isArray(payload.data) ? payload.data : [];
      const users = [];
      for (const authUser of authUsers) {
        const localUser = await syncLocalShadowUser(authUser);
        users.push(localUser);
      }
      return res.status(200).json({
        message: "Users retrieved successfully",
        data: users,
      });
    }
    } catch (error) {
      return res.status(404).json({
        message: "Access denied",
      });
    }
}

export const GetEasyBuyCatalog = async (req: Request, res: Response) => {
  try {
    const provider = getReadProvider(req.query?.provider);
    const pricingFilter: Record<string, unknown> = {};
    appendPricingProviderFilter(pricingFilter, provider);

    const pricingDocs = await EasyBuyCapacityPriceModel.find(pricingFilter)
      .select({ provider: 1, model: 1, capacity: 1, price: 1, _id: 0 })
      .lean();
    const priceLookup = provider.buildPriceLookup(
      sortPricingDocsByProviderPrecedence(pricingDocs, provider)
    );

    const models = provider.catalog.map((entry) => ({
      ...entry,
      imageUrl: resolveCatalogImageUrl(req, provider, entry),
      pricesByCapacity: provider.getModelPrices(priceLookup, entry.model),
    }));

    return res.status(200).json({
      message: "EasyBuy catalog retrieved successfully",
      data: {
        provider: provider.slug,
        models,
        planRules: provider.planRules,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve EasyBuy catalog",
      reason: error?.message || "Unknown error",
    });
  }
};

export const GetEasyBuyCatalogImage = async (req: Request, res: Response) => {
  const provider = getReadProvider(req.query?.provider);
  const requestedModel = decodeURIComponent(String(req.params.model || "")).trim();
  const entry = provider.catalogMap.get(requestedModel);

  if (!entry) {
    return sendCatalogFallbackSvg(res, requestedModel || "iPhone");
  }

  const candidates = getCatalogImageFetchCandidates(provider, entry);

  for (const candidateUrl of candidates) {
    if (!/^https?:\/\//i.test(candidateUrl)) continue;

    try {
      const response = await fetch(candidateUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Referer: "https://www.apple.com/",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      });

      if (!response.ok) continue;

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.startsWith("image/")) continue;

      const payload = Buffer.from(await response.arrayBuffer());
      if (!payload.length) continue;

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      return res.status(200).send(payload);
    } catch {
      // try next candidate
    }
  }

  return sendCatalogFallbackSvg(res, entry.model);
};

export const CreateEasyBoughtItem = async (req: Request, res: Response) => {
    const checkrole = req.user?.role;  
    if (checkrole !== "Admin") {
      return res.status(404).json({
        message: "Access denied",
      });
    }

    try {
    const CheckUseremail = req.user?.email;
    const authToken = req.authToken;
    if (!CheckUseremail || !authToken) {
      return res.status(401).json({
        message: "Access denied",
      });
    }
   
   

    const {
      provider: rawProvider,
      IphoneModel,
      ItemName,
      capacity,
      Plan,
      PhonePrice,
      TotalPrice,
      downPayment,
      monthlyPlan,
      weeklyPlan,
      UserEmail,
    } = req.body;
    let provider: FinanceProvider;
    try {
      provider = getWriteProvider(rawProvider);
    } catch (error: any) {
      return res.status(400).json({
        message: error?.message || "Unsupported provider",
      });
    }
    const resolvedIphoneModel = String(IphoneModel || ItemName || "").trim();
    const resolvedCapacity = provider.normalizeCapacityInput(capacity);
    const resolvedUserEmail = String(UserEmail || req.user?.email || "").trim();
    if (
      !resolvedIphoneModel ||
      !resolvedCapacity ||
      (PhonePrice === undefined && TotalPrice === undefined) ||
      !resolvedUserEmail
    ) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const catalogEntry = provider.catalogMap.get(resolvedIphoneModel);
    if (!catalogEntry) {
      return res.status(400).json({
        message: "Unsupported iPhone model",
      });
    }

    if (!catalogEntry.capacities.includes(resolvedCapacity)) {
      return res.status(400).json({
        message: `Capacity ${resolvedCapacity} is unavailable for ${resolvedIphoneModel}. Allowed capacities: ${catalogEntry.capacities.join(", ")}`,
      });
    }

    const resolvedPhonePrice = PhonePrice ?? TotalPrice;
    const phonePriceNumber = Number(resolvedPhonePrice);
    if (!Number.isFinite(phonePriceNumber) || phonePriceNumber <= 0) {
      return res.status(400).json({
        message: "PhonePrice must be greater than zero",
      });
    }

    const isWeeklyOnly = catalogEntry.allowedPlans.length === 1 && catalogEntry.allowedPlans[0] === "Weekly";
    const resolvedPlan = isWeeklyOnly ? "Weekly" : Plan;

    if (!catalogEntry.allowedPlans.includes(resolvedPlan)) {
      return res.status(400).json({
        message: `Plan must be one of: ${catalogEntry.allowedPlans.join(", ")}`,
      });
    }

    const monthlyPlanNumber = Number(monthlyPlan);
    const weeklyPlanNumber = Number(weeklyPlan);

    if (resolvedPlan === "Monthly" && !provider.planRules.monthlyDurations.includes(monthlyPlanNumber)) {
      return res.status(400).json({
        message: `monthlyPlan must be one of: ${provider.planRules.monthlyDurations.join(", ")}`,
      });
    }

    if (resolvedPlan === "Weekly" && !provider.planRules.weeklyDurations.includes(weeklyPlanNumber)) {
      return res.status(400).json({
        message: `weeklyPlan must be one of: ${provider.planRules.weeklyDurations.join(", ")}`,
      });
    }

    const authUser = await findAuthUserByEmail(authToken, resolvedUserEmail);
    const getUser = authUser
      ? await syncLocalShadowUser(authUser)
      : null;
    if(!getUser){
      return res.status(404).json({
        message: "User does not exist",
      });
    }

    const downPaymentMultiplier =
      provider.resolveDownPaymentPercentage(resolvedIphoneModel, phonePriceNumber) / 100;
    const minimumDownPayment = phonePriceNumber * downPaymentMultiplier;
    const requestedDownPayment =
      downPayment === undefined || downPayment === null || downPayment === ""
        ? minimumDownPayment
        : Number(downPayment);

    if (!Number.isFinite(requestedDownPayment) || requestedDownPayment <= 0) {
      return res.status(400).json({
        message: "downPayment must be greater than zero",
      });
    }

    if (requestedDownPayment < minimumDownPayment) {
      return res.status(400).json({
        message: `downPayment must be at least ${minimumDownPayment.toFixed(2)} for ${resolvedIphoneModel}`,
      });
    }

    if (requestedDownPayment > phonePriceNumber) {
      return res.status(400).json({
        message: "downPayment cannot be greater than PhonePrice",
      });
    }

    const normalizedDownPayment = Number(requestedDownPayment.toFixed(2));
    const loanedAmount = Number(Math.max(phonePriceNumber - normalizedDownPayment, 0).toFixed(2));
    
    const CheckUserInEaseBought=await EasyBoughtItemModel.findOne({UserEmail:resolvedUserEmail});
    if(CheckUserInEaseBought){
      return res.status(409).json({
        message: "User already has an active EasyBought item",
      });
    }

    const easyBoughtPayload: Record<string, any> = {
      provider: provider.slug,
      IphoneModel: resolvedIphoneModel,
      IphoneImageUrl: resolveCatalogImageUrl(req, provider, catalogEntry),
      capacity: resolvedCapacity,
      Plan: resolvedPlan,
      downPayment: normalizedDownPayment,
      loanedAmount,
      PhonePrice: phonePriceNumber,
      UserEmail: resolvedUserEmail,
      UserId:getUser._id,
    };

    if (resolvedPlan === "Monthly") {
      easyBoughtPayload.monthlyPlan = monthlyPlanNumber;
    } else {
      easyBoughtPayload.weeklyPlan = weeklyPlanNumber;
    }

    const easyBoughtItem = await EasyBoughtItemModel.create(easyBoughtPayload);

    return res.status(200).json({
      message: "EasyBoughtItem created successfully",
      data: easyBoughtItem,
    });
    } catch (error) {
      return res.status(400).json({
        message: "Failed to create EasyBoughtItem",
        error: error instanceof Error ? error.message : "Unknown error occurred", 
      });
    }
  } 

export const LogoutUser = async (req: Request, res: Response) => {


    try {
      res.clearCookie("sessionId");
      return res.status(200).json({
        message: "Logout successful",
      });
    } catch (error) {
      return res.status(400).json({
        message: "Failed to logout",
        error: error instanceof Error ? error.message : "Unknown error occurred", 
      });
    }
  }   
 export const GetCurrentUser = async (req: Request, res: Response) => {
try {
  const userId = req.user?._id;
  if (!userId) {
    return res.status(401).json({ message: "Access denied" });
  }

  const user = await UserModel.findById(userId).lean();
  if (!user) {
    return res.status(404).json({
      message: "User not found",
    });
  }

  return res.status(200).json({
    message: "Current user retrieved successfully",
    data: {
      _id: String(user._id),
      fullName: String(user.fullName || ""),
      email: String(user.email || ""),
      role: String(user.role || "User"),
    },
  });
} catch (error) {
  return res.status(400).json({
    message: "Failed to retrieve current user",
    error: error instanceof Error ? error.message : "Unknown error occurred", 
  }); 
}

 }

