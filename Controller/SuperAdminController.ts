import { type Request, type Response } from "express";
import mongoose from "mongoose";
import AuditLogModel from "../Model/AuditLogModel.js";
import EasyBoughtItemModel from "../Model/EasyBoughtitem.js";
import EasyBuyPlanModel from "../Model/EasyBuyPlanModel.js";
import EasyBuyCapacityPriceModel from "../Model/EasyBuyCapacityPriceModel.js";
import PaymentModel from "../Model/PaymentModel.js";
import ProfileModel from "../Model/Profilemodel.js";
import PublicEasyBuyDraftModel from "../Model/PublicEasyBuyDraftModel.js";
import PublicEasyBuyRequestModel from "../Model/PublicEasyBuyRequestModel.js";
import ReceiptModel from "../Model/ReceiptModel.js";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";
import { EASYBUY_CATALOG, normalizeCapacityInput } from "../Utils/EasyBuyCatalog.js";
import { normalizePricingUpdateInput } from "../Utils/EasyBuyPricing.js";
import { appendPricingProviderFilter, sortPricingDocsByProviderPrecedence } from "../Utils/providers/helpers.js";
import { getDefaultProvider, resolveProvider } from "../Utils/providers/registry.js";

const normalizeReason = (value: unknown) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || "No reason provided";
};

const parseDateInput = (value: unknown, fieldName: string): Date => {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error(`${fieldName} is required`);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return parsed;
};

const buildEasyBuyPricingModels = async (providerSlug?: string) => {
  const provider = providerSlug ? resolveProvider(providerSlug) : getDefaultProvider();
  const filter: Record<string, unknown> = {};
  appendPricingProviderFilter(filter, provider);

  const pricingDocs = await EasyBuyCapacityPriceModel.find(filter)
    .select({ provider: 1, model: 1, capacity: 1, price: 1, _id: 0 })
    .lean();
  const priceLookup = provider.buildPriceLookup(
    sortPricingDocsByProviderPrecedence(pricingDocs, provider)
  );

  return provider.catalog.map((entry) => ({
    model: entry.model,
    capacities: [...entry.capacities],
    pricesByCapacity: provider.getModelPrices(priceLookup, entry.model),
  }));
};

const normalizeString = (value: unknown): string => String(value ?? "").trim();
const normalizeEmail = (value: unknown): string => normalizeString(value).toLowerCase();
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parsePositiveNumber = (value: unknown, fieldName: string): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${fieldName} must be greater than zero`);
  }
  return Number(numeric.toFixed(2));
};

export const SuperAdminGetAllUsers = async (_req: Request, res: Response) => {
  try {
    const users = await UserModel.find()
      .select("-password")
      .populate("createdByAdmin", "fullName email role")
      .lean();

    return res.status(200).json({
      message: "Users retrieved successfully",
      total: users.length,
      data: users,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve users",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminGetUsersWithEasyBoughtItems = async (req: Request, res: Response) => {
  try {
    const users = await UserModel.find().select("-password").lean();
    if (!users.length) {
      return res.status(200).json({
        message: "Users retrieved successfully",
        total: 0,
        data: [],
      });
    }

    const userIds = users.map((user) => user._id);
    const easyBoughtItems = await EasyBoughtItemModel.find({ UserId: { $in: userIds } }).lean();

    const itemMap = new Map<string, Array<(typeof easyBoughtItems)[number]>>();
    for (const item of easyBoughtItems) {
      const userIdKey = String(item.UserId);
      const current = itemMap.get(userIdKey) || [];
      current.push(item);
      itemMap.set(userIdKey, current);
    }

    const usersWithItems = users.map((user) => ({
      ...user,
      easyBoughtItems: itemMap.get(String(user._id)) || [],
    }));

    return res.status(200).json({
      message: "Users and EasyBoughtItems retrieved successfully",
      total: usersWithItems.length,
      data: usersWithItems,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve users with EasyBoughtItems",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminDeleteUserOrAdmin = async (req: Request, res: Response) => {
  const actorId = req.user?._id;
  const actorRole = req.user?.role;
  const { userId } = req.params;

  if (!actorId || actorRole !== "SuperAdmin") {
    return res.status(401).json({
      message: "Access denied",
    });
  }

  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({
      message: "A valid userId is required",
    });
  }

  if (actorId === userId) {
    return res.status(400).json({
      message: "SuperAdmin cannot delete their own account",
    });
  }

  const reason = normalizeReason(req.body?.reason);

  const session = await mongoose.startSession();

  try {
    const targetUser = await UserModel.findById(userId)
      .select({ _id: 1, role: 1, email: 1, fullName: 1 })
      .lean();
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!["User", "Admin"].includes(targetUser.role)) {
      return res.status(403).json({
        message: "Only User or Admin accounts can be deleted through this endpoint",
      });
    }

    await session.withTransaction(async () => {
      await UserModel.findByIdAndDelete(targetUser._id, { session });

      await UserModel.updateMany(
        {},
        { $pull: { createdUsers: targetUser._id } },
        { session }
      );

      if (targetUser.role === "Admin") {
        await UserModel.updateMany(
          { createdByAdmin: targetUser._id },
          { $set: { createdByAdmin: null } },
          { session }
        );
      }

      await Promise.all([
        EasyBoughtItemModel.deleteMany({ UserId: targetUser._id }, { session }),
        EasyBuyPlanModel.deleteMany({ user: targetUser._id }, { session }),
        PaymentModel.deleteMany({ user: targetUser._id }, { session }),
        ReceiptModel.deleteMany({ user: targetUser._id }, { session }),
        SessionModel.deleteMany({ user: targetUser._id }, { session }),
        ProfileModel.deleteOne({ _id: targetUser._id }, { session }),
      ]);

      await AuditLogModel.create(
        [
          {
            actor: new mongoose.Types.ObjectId(actorId),
            actorRole: actorRole,
            action: "USER_DELETE",
            targetType: "user",
            targetId: targetUser._id,
            reason,
            metadata: {
              deletedUserRole: targetUser.role,
              deletedUserEmail: targetUser.email,
              deletedUserFullName: targetUser.fullName,
            },
          },
        ],
        { session }
      );
    });

    return res.status(200).json({
      message: `${targetUser.role} deleted successfully`,
      data: {
        _id: targetUser._id,
        fullName: targetUser.fullName,
        email: targetUser.email,
        role: targetUser.role,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to delete user",
      reason: error?.message || "Unknown error",
    });
  } finally {
    await session.endSession();
  }
};

export const SuperAdminPreviewReceiptUploadedDate = async (req: Request, res: Response) => {
  try {
    const { receiptId } = req.params;
    if (!receiptId || !mongoose.isValidObjectId(receiptId)) {
      return res.status(400).json({ message: "A valid receiptId is required" });
    }

    const receipt = await ReceiptModel.findById(receiptId)
      .select({ _id: 1, user: 1, plan: 1, amount: 1, status: 1, createdAt: 1 })
      .lean();

    if (!receipt) {
      return res.status(404).json({ message: "Receipt not found" });
    }

    let proposedUploadedAt: Date | null = null;
    if (req.query?.uploadedAt !== undefined) {
      try {
        proposedUploadedAt = parseDateInput(req.query.uploadedAt, "uploadedAt");
      } catch (error: any) {
        return res.status(400).json({
          message: error?.message || "Invalid uploadedAt value",
        });
      }
    }

    return res.status(200).json({
      message: "Receipt uploaded date preview retrieved",
      data: {
        receiptId: receipt._id,
        currentUploadedAt: receipt.createdAt ?? null,
        proposedUploadedAt,
        user: receipt.user,
        plan: receipt.plan,
        amount: receipt.amount,
        status: receipt.status,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to preview receipt uploaded date",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminUpdateReceiptUploadedDate = async (req: Request, res: Response) => {
  const actorId = req.user?._id;
  const actorRole = req.user?.role;
  const { receiptId } = req.params;

  if (!actorId || actorRole !== "SuperAdmin") {
    return res.status(401).json({ message: "Access denied" });
  }

  if (!receiptId || !mongoose.isValidObjectId(receiptId)) {
    return res.status(400).json({ message: "A valid receiptId is required" });
  }

  let uploadedAt: Date;
  try {
    uploadedAt = parseDateInput(req.body?.uploadedAt, "uploadedAt");
  } catch (error: any) {
    return res.status(400).json({
      message: error?.message || "Invalid uploadedAt value",
    });
  }

  const reason = normalizeReason(req.body?.reason);

  try {
    const existingReceipt = await ReceiptModel.findById(receiptId)
      .select({ _id: 1, user: 1, plan: 1, amount: 1, status: 1, createdAt: 1 })
      .lean();

    if (!existingReceipt) {
      return res.status(404).json({ message: "Receipt not found" });
    }

    const updatedReceipt = await ReceiptModel.findOneAndUpdate(
      { _id: receiptId },
      { $set: { createdAt: uploadedAt } },
      {
        returnDocument: "after",
        runValidators: true,
        overwriteImmutable: true,
      }
    )
      .select({ _id: 1, user: 1, plan: 1, amount: 1, status: 1, createdAt: 1, updatedAt: 1 })
      .lean();

    if (!updatedReceipt) {
      return res.status(404).json({ message: "Receipt not found" });
    }

    await AuditLogModel.create({
      actor: new mongoose.Types.ObjectId(actorId),
      actorRole,
      action: "RECEIPT_UPLOAD_DATE_UPDATE",
      targetType: "receipt",
      targetId: new mongoose.Types.ObjectId(String(updatedReceipt._id)),
      reason,
      metadata: {
        receiptUser: existingReceipt.user,
        receiptPlan: existingReceipt.plan,
        receiptAmount: existingReceipt.amount,
        previousUploadedAt: existingReceipt.createdAt ?? null,
        updatedUploadedAt: updatedReceipt.createdAt ?? null,
      },
    });

    return res.status(200).json({
      message: "Receipt uploaded date updated successfully",
      data: {
        receiptId: updatedReceipt._id,
        previousUploadedAt: existingReceipt.createdAt ?? null,
        updatedUploadedAt: updatedReceipt.createdAt ?? null,
        updatedAt: updatedReceipt.updatedAt ?? null,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to update receipt uploaded date",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminPreviewUserNextDueDate = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: "A valid userId is required" });
    }

    const user = await UserModel.findById(userId)
      .select({ _id: 1, fullName: 1, email: 1, manualNextDueDate: 1 })
      .lean();
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    let proposedNextDueDate: Date | null = null;
    if (req.query?.nextDueDate !== undefined) {
      try {
        proposedNextDueDate = parseDateInput(req.query.nextDueDate, "nextDueDate");
      } catch (error: any) {
        return res.status(400).json({
          message: error?.message || "Invalid nextDueDate value",
        });
      }
    }

    return res.status(200).json({
      message: "User next due date preview retrieved",
      data: {
        userId: user._id,
        fullName: user.fullName,
        email: user.email,
        currentNextDueDate: user.manualNextDueDate ?? null,
        proposedNextDueDate,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to preview user next due date",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminUpdateUserNextDueDate = async (req: Request, res: Response) => {
  const actorId = req.user?._id;
  const actorRole = req.user?.role;
  const { userId } = req.params;

  if (!actorId || actorRole !== "SuperAdmin") {
    return res.status(401).json({ message: "Access denied" });
  }

  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ message: "A valid userId is required" });
  }

  let nextDueDate: Date;
  try {
    nextDueDate = parseDateInput(req.body?.nextDueDate, "nextDueDate");
  } catch (error: any) {
    return res.status(400).json({
      message: error?.message || "Invalid nextDueDate value",
    });
  }

  const reason = normalizeReason(req.body?.reason);

  try {
    const existingUser = await UserModel.findById(userId)
      .select({ _id: 1, fullName: 1, email: 1, manualNextDueDate: 1 })
      .lean();
    if (!existingUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const updatedUser = await UserModel.findOneAndUpdate(
      { _id: userId },
      { $set: { manualNextDueDate: nextDueDate } },
      { returnDocument: "after", runValidators: true }
    )
      .select({ _id: 1, fullName: 1, email: 1, manualNextDueDate: 1, updatedAt: 1 })
      .lean();

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    await AuditLogModel.create({
      actor: new mongoose.Types.ObjectId(actorId),
      actorRole,
      action: "USER_NEXT_DUE_DATE_UPDATE",
      targetType: "user",
      targetId: new mongoose.Types.ObjectId(String(updatedUser._id)),
      reason,
      metadata: {
        targetUserEmail: updatedUser.email,
        targetUserFullName: updatedUser.fullName,
        previousNextDueDate: existingUser.manualNextDueDate ?? null,
        updatedNextDueDate: updatedUser.manualNextDueDate ?? null,
      },
    });

    return res.status(200).json({
      message: "User next due date updated successfully",
      data: {
        userId: updatedUser._id,
        previousNextDueDate: existingUser.manualNextDueDate ?? null,
        updatedNextDueDate: updatedUser.manualNextDueDate ?? null,
        updatedAt: updatedUser.updatedAt ?? null,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to update user next due date",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminPreviewItemCreatedDate = async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    if (!itemId || !mongoose.isValidObjectId(itemId)) {
      return res.status(400).json({ message: "A valid itemId is required" });
    }

    const item = await EasyBoughtItemModel.findById(itemId)
      .select({ _id: 1, UserId: 1, UserEmail: 1, IphoneModel: 1, Plan: 1, createdAt: 1 })
      .lean();
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    let proposedCreatedAt: Date | null = null;
    if (req.query?.createdAt !== undefined) {
      try {
        proposedCreatedAt = parseDateInput(req.query.createdAt, "createdAt");
      } catch (error: any) {
        return res.status(400).json({
          message: error?.message || "Invalid createdAt value",
        });
      }
    }

    return res.status(200).json({
      message: "Item created date preview retrieved",
      data: {
        itemId: item._id,
        currentCreatedAt: item.createdAt ?? null,
        proposedCreatedAt,
        userId: item.UserId,
        userEmail: item.UserEmail,
        iphoneModel: item.IphoneModel,
        plan: item.Plan,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to preview item created date",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminUpdateItemCreatedDate = async (req: Request, res: Response) => {
  const actorId = req.user?._id;
  const actorRole = req.user?.role;
  const { itemId } = req.params;

  if (!actorId || actorRole !== "SuperAdmin") {
    return res.status(401).json({ message: "Access denied" });
  }

  if (!itemId || !mongoose.isValidObjectId(itemId)) {
    return res.status(400).json({ message: "A valid itemId is required" });
  }

  let createdAt: Date;
  try {
    createdAt = parseDateInput(req.body?.createdAt, "createdAt");
  } catch (error: any) {
    return res.status(400).json({
      message: error?.message || "Invalid createdAt value",
    });
  }

  const reason = normalizeReason(req.body?.reason);

  try {
    const existingItem = await EasyBoughtItemModel.findById(itemId)
      .select({ _id: 1, UserId: 1, UserEmail: 1, IphoneModel: 1, Plan: 1, createdAt: 1 })
      .lean();
    if (!existingItem) {
      return res.status(404).json({ message: "Item not found" });
    }

    const updatedItem = await EasyBoughtItemModel.findOneAndUpdate(
      { _id: itemId },
      { $set: { createdAt } },
      {
        returnDocument: "after",
        runValidators: true,
        overwriteImmutable: true,
      }
    )
      .select({ _id: 1, UserId: 1, UserEmail: 1, IphoneModel: 1, Plan: 1, createdAt: 1, updatedAt: 1 })
      .lean();

    if (!updatedItem) {
      return res.status(404).json({ message: "Item not found" });
    }

    await AuditLogModel.create({
      actor: new mongoose.Types.ObjectId(actorId),
      actorRole,
      action: "ITEM_CREATED_DATE_UPDATE",
      targetType: "easyboughtitem",
      targetId: new mongoose.Types.ObjectId(String(updatedItem._id)),
      reason,
      metadata: {
        itemUserId: existingItem.UserId,
        itemUserEmail: existingItem.UserEmail,
        itemModel: existingItem.IphoneModel,
        itemPlan: existingItem.Plan,
        previousCreatedAt: existingItem.createdAt ?? null,
        updatedCreatedAt: updatedItem.createdAt ?? null,
      },
    });

    return res.status(200).json({
      message: "Item created date updated successfully",
      data: {
        itemId: updatedItem._id,
        previousCreatedAt: existingItem.createdAt ?? null,
        updatedCreatedAt: updatedItem.createdAt ?? null,
        updatedAt: updatedItem.updatedAt ?? null,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to update item created date",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminGetEasyBuyPricing = async (req: Request, res: Response) => {
  try {
    const providerSlug = normalizeString(req.query?.provider) || undefined;
    const models = await buildEasyBuyPricingModels(providerSlug);
    return res.status(200).json({
      message: "EasyBuy pricing retrieved successfully",
      data: {
        models,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve EasyBuy pricing",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminUpdateEasyBuyPricing = async (req: Request, res: Response) => {
  const actorId = req.user?._id;
  const actorRole = req.user?.role;

  if (!actorId || actorRole !== "SuperAdmin") {
    return res.status(401).json({ message: "Access denied" });
  }

  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  if (!updates.length) {
    return res.status(400).json({
      message: "updates is required and must contain at least one item",
    });
  }

  const providerSlug = normalizeString(req.body?.provider) || undefined;
  const provider = resolveProvider(providerSlug);

  const validatedUpdates = new Map<string, { model: string; capacity: string; price: number }>();

  for (const update of updates) {
    const { model, capacity, price } = normalizePricingUpdateInput(update);

    if (!model || !capacity) {
      return res.status(400).json({
        message: "Each update item must include model and capacity",
      });
    }

    if (!provider.isValidModelCapacity(model, capacity)) {
      return res.status(400).json({
        message: `Unsupported model/capacity pair: ${model} ${capacity}`,
      });
    }

    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({
        message: `Invalid price for ${model} ${capacity}. Price must be greater than zero.`,
      });
    }

    validatedUpdates.set(`${model}__${capacity}`, {
      model,
      capacity,
      price: Number(price.toFixed(2)),
    });
  }

  const bulkOperations = Array.from(validatedUpdates.values()).map((item) => ({
    updateOne: {
      filter: { provider: provider.slug, model: item.model, capacity: item.capacity },
      update: {
        $set: {
          provider: provider.slug,
          model: item.model,
          capacity: item.capacity,
          price: item.price,
          updatedBy: new mongoose.Types.ObjectId(actorId),
        },
      },
      upsert: true,
    },
  }));

  try {
    if (bulkOperations.length) {
      await EasyBuyCapacityPriceModel.bulkWrite(bulkOperations, { ordered: false });
    }

    const models = await buildEasyBuyPricingModels(provider.slug);
    return res.status(200).json({
      message: "EasyBuy pricing updated successfully",
      data: {
        updatedCount: bulkOperations.length,
        models,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to update EasyBuy pricing",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminListPublicEasyBuyRequests = async (req: Request, res: Response) => {
  try {
    const status = normalizeString(req.query?.status);
    const search = normalizeString(req.query?.search);
    const providerSlug = normalizeString(req.query?.provider);
    const safeSearch = search ? escapeRegExp(search) : "";
    const page = Math.max(Number(req.query?.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 100);

    const filter: Record<string, unknown> = {};
    if (providerSlug) {
      filter.provider = providerSlug;
    }
    if (status) {
      filter.status = status;
    }
    if (safeSearch) {
      filter.$or = [
        { requestId: { $regex: safeSearch, $options: "i" } },
        { fullName: { $regex: safeSearch, $options: "i" } },
        { email: { $regex: safeSearch, $options: "i" } },
        { phone: { $regex: safeSearch, $options: "i" } },
      ];
    }

    const [items, total] = await Promise.all([
      PublicEasyBuyRequestModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({ verificationTokenHash: 0, verificationTokenExpiresAt: 0 })
        .populate("reviewedBy", "fullName email role")
        .lean(),
      PublicEasyBuyRequestModel.countDocuments(filter),
    ]);

    return res.status(200).json({
      message: "Public EasyBuy requests retrieved successfully",
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve public requests",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminListAbandonedPublicEasyBuyDrafts = async (req: Request, res: Response) => {
  try {
    const search = normalizeString(req.query?.search);
    const providerSlug = normalizeString(req.query?.provider);
    const safeSearch = search ? escapeRegExp(search) : "";
    const page = Math.max(Number(req.query?.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 100);
    const inactivityMinutesRaw = Number(req.query?.inactivityMinutes);
    const inactivityMinutes = Number.isFinite(inactivityMinutesRaw)
      ? Math.min(Math.max(Math.floor(inactivityMinutesRaw), 5), 60 * 24 * 30)
      : 30;
    const abandonedBefore = new Date(Date.now() - inactivityMinutes * 60 * 1000);

    const filter: Record<string, unknown> = {
      status: "draft",
      updatedAt: { $lte: abandonedBefore },
    };
    if (providerSlug) {
      filter.provider = providerSlug;
    }
    if (safeSearch) {
      filter.$or = [
        { fullName: { $regex: safeSearch, $options: "i" } },
        { email: { $regex: safeSearch, $options: "i" } },
        { phone: { $regex: safeSearch, $options: "i" } },
        { iphoneModel: { $regex: safeSearch, $options: "i" } },
        { capacity: { $regex: safeSearch, $options: "i" } },
      ];
    }

    const [items, total] = await Promise.all([
      PublicEasyBuyDraftModel.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({
          _id: 0,
          anonymousId: 1,
          fullName: 1,
          email: 1,
          phone: 1,
          iphoneModel: 1,
          capacity: 1,
          plan: 1,
          currentStep: 1,
          updatedAt: 1,
          createdAt: 1,
        })
        .lean(),
      PublicEasyBuyDraftModel.countDocuments(filter),
    ]);

    return res.status(200).json({
      message: "Abandoned public EasyBuy drafts retrieved successfully",
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
      meta: {
        inactivityMinutes,
        abandonedBefore,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve abandoned public EasyBuy drafts",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminApprovePublicEasyBuyRequest = async (req: Request, res: Response) => {
  const actorId = req.user?._id;
  const actorRole = req.user?.role;
  if (!actorId || actorRole !== "SuperAdmin") {
    return res.status(401).json({ message: "Access denied" });
  }

  const requestId = normalizeString(req.params?.requestId);
  if (!requestId) {
    return res.status(400).json({ message: "requestId is required" });
  }

  const reason = normalizeReason(req.body?.reason);

  try {
    const updated = await PublicEasyBuyRequestModel.findOneAndUpdate(
      { requestId, status: { $in: ["verified", "pending_verification"] } },
      {
        $set: {
          status: "approved",
          approvedAt: new Date(),
          reviewedBy: new mongoose.Types.ObjectId(actorId),
          reviewedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    ).lean();

    if (!updated) {
      const existing = await PublicEasyBuyRequestModel.findOne({ requestId })
        .select({ requestId: 1, status: 1 })
        .lean();
      if (!existing) {
        return res.status(404).json({ message: "Public request not found" });
      }
      return res.status(409).json({ message: `Request is currently ${existing.status}` });
    }

    await AuditLogModel.create({
      actor: new mongoose.Types.ObjectId(actorId),
      actorRole,
      action: "PUBLIC_REQUEST_APPROVE",
      targetType: "publicrequest",
      targetId: new mongoose.Types.ObjectId(String(updated._id)),
      reason,
      metadata: {
        requestId: updated.requestId,
        email: updated.email,
        iphoneModel: updated.iphoneModel,
        capacity: updated.capacity,
        plan: updated.plan,
      },
    });

    return res.status(200).json({
      message: "Public request approved",
      data: updated,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to approve public request",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminRejectPublicEasyBuyRequest = async (req: Request, res: Response) => {
  const actorId = req.user?._id;
  const actorRole = req.user?.role;
  if (!actorId || actorRole !== "SuperAdmin") {
    return res.status(401).json({ message: "Access denied" });
  }

  const requestId = normalizeString(req.params?.requestId);
  if (!requestId) {
    return res.status(400).json({ message: "requestId is required" });
  }

  const rejectionReason = normalizeString(req.body?.reason);
  if (!rejectionReason) {
    return res.status(400).json({ message: "reason is required to reject request" });
  }

  try {
    const updated = await PublicEasyBuyRequestModel.findOneAndUpdate(
      { requestId, status: { $in: ["pending_verification", "verified", "approved"] } },
      {
        $set: {
          status: "rejected",
          rejectedAt: new Date(),
          rejectionReason,
          reviewedBy: new mongoose.Types.ObjectId(actorId),
          reviewedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    ).lean();

    if (!updated) {
      const existing = await PublicEasyBuyRequestModel.findOne({ requestId })
        .select({ requestId: 1, status: 1 })
        .lean();
      if (!existing) {
        return res.status(404).json({ message: "Public request not found" });
      }
      return res.status(409).json({ message: `Request is currently ${existing.status}` });
    }

    await AuditLogModel.create({
      actor: new mongoose.Types.ObjectId(actorId),
      actorRole,
      action: "PUBLIC_REQUEST_REJECT",
      targetType: "publicrequest",
      targetId: new mongoose.Types.ObjectId(String(updated._id)),
      reason: rejectionReason,
      metadata: {
        requestId: updated.requestId,
        email: updated.email,
        iphoneModel: updated.iphoneModel,
        capacity: updated.capacity,
        plan: updated.plan,
      },
    });

    return res.status(200).json({
      message: "Public request rejected",
      data: updated,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to reject public request",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminConvertPublicEasyBuyRequest = async (req: Request, res: Response) => {
  const actorId = req.user?._id;
  const actorRole = req.user?.role;
  if (!actorId || actorRole !== "SuperAdmin") {
    return res.status(401).json({ message: "Access denied" });
  }

  const requestId = normalizeString(req.params?.requestId);
  if (!requestId) {
    return res.status(400).json({ message: "requestId is required" });
  }

  const reason = normalizeReason(req.body?.reason);

  const session = await mongoose.startSession();
  try {
    let responseData: Record<string, unknown> = {};

    await session.withTransaction(async () => {
      const requestDoc = await PublicEasyBuyRequestModel.findOne({
        requestId,
        status: "approved",
      }).session(session);

      if (!requestDoc) {
        const existing = await PublicEasyBuyRequestModel.findOne({ requestId })
          .select({ requestId: 1, status: 1 })
          .session(session)
          .lean();
        if (!existing) {
          throw new Error("Public request not found");
        }
        throw new Error(`Request is currently ${existing.status}`);
      }

      const provider = resolveProvider((requestDoc as any).provider);
      const iphoneModel = normalizeString(requestDoc.iphoneModel);
      const capacity = provider.normalizeCapacityInput(requestDoc.capacity);
      const plan = normalizeString(req.body?.plan || requestDoc.plan) as "Monthly" | "Weekly";
      const catalogEntry = provider.catalogMap.get(iphoneModel);
      if (!catalogEntry) {
        throw new Error("Unsupported iPhone model");
      }
      if (!catalogEntry.capacities.includes(capacity)) {
        throw new Error(`Capacity ${capacity} is unavailable for ${iphoneModel}`);
      }
      if (!catalogEntry.allowedPlans.includes(plan)) {
        throw new Error(`Plan must be one of: ${catalogEntry.allowedPlans.join(", ")}`);
      }

      const resolvedUserEmail = normalizeEmail(req.body?.userEmail || requestDoc.email);
      if (!resolvedUserEmail) {
        throw new Error("userEmail is required");
      }

      const user = await UserModel.findOne({ email: resolvedUserEmail })
        .select({ _id: 1, email: 1, fullName: 1, role: 1 })
        .lean();
      if (!user) {
        throw new Error("No existing user found for this email. Create user account first.");
      }

      const existingEasyBought = await EasyBoughtItemModel.findOne({ UserEmail: resolvedUserEmail })
        .session(session)
        .lean();
      if (existingEasyBought) {
        throw new Error("User already has an active EasyBought item");
      }

      const phonePrice = parsePositiveNumber(req.body?.phonePrice, "phonePrice");
      const downPaymentPct = provider.resolveDownPaymentPercentage(iphoneModel, phonePrice);
      const minimumDownPayment = Number(((downPaymentPct / 100) * phonePrice).toFixed(2));
      const downPayment =
        req.body?.downPayment === undefined || req.body?.downPayment === null || req.body?.downPayment === ""
          ? minimumDownPayment
          : parsePositiveNumber(req.body?.downPayment, "downPayment");

      if (downPayment < minimumDownPayment) {
        throw new Error(`downPayment must be at least ${minimumDownPayment.toFixed(2)}`);
      }
      if (downPayment > phonePrice) {
        throw new Error("downPayment cannot be greater than phonePrice");
      }

      const monthlyPlanNumber = Number(req.body?.monthlyPlan);
      const weeklyPlanNumber = Number(req.body?.weeklyPlan);

      const payload: Record<string, unknown> = {
        provider: provider.slug,
        IphoneModel: iphoneModel,
        IphoneImageUrl: catalogEntry.imageUrl,
        capacity,
        Plan: plan,
        downPayment: Number(downPayment.toFixed(2)),
        loanedAmount: Number((phonePrice - downPayment).toFixed(2)),
        PhonePrice: phonePrice,
        UserId: user._id,
        UserEmail: resolvedUserEmail,
      };

      if (plan === "Monthly") {
        if (!provider.planRules.monthlyDurations.includes(monthlyPlanNumber)) {
          throw new Error(
            `monthlyPlan must be one of: ${provider.planRules.monthlyDurations.join(", ")}`
          );
        }
        payload.monthlyPlan = monthlyPlanNumber;
      } else {
        if (!provider.planRules.weeklyDurations.includes(weeklyPlanNumber)) {
          throw new Error(`weeklyPlan must be one of: ${provider.planRules.weeklyDurations.join(", ")}`);
        }
        payload.weeklyPlan = weeklyPlanNumber;
      }

      const createdItems = await EasyBoughtItemModel.create([payload], { session });
      const createdItem = createdItems[0];
      if (!createdItem) {
        throw new Error("Failed to create EasyBought item");
      }

      requestDoc.status = "converted";
      requestDoc.convertedAt = new Date();
      requestDoc.convertedEasyBoughtItemId = createdItem._id as any;
      requestDoc.reviewedBy = new mongoose.Types.ObjectId(actorId);
      requestDoc.reviewedAt = new Date();
      await requestDoc.save({ session });

      await AuditLogModel.create(
        [
          {
            actor: new mongoose.Types.ObjectId(actorId),
            actorRole,
            action: "PUBLIC_REQUEST_CONVERT",
            targetType: "publicrequest",
            targetId: new mongoose.Types.ObjectId(String(requestDoc._id)),
            reason,
            metadata: {
              requestId: requestDoc.requestId,
              email: requestDoc.email,
              iphoneModel,
              capacity,
              plan,
              convertedEasyBoughtItemId: createdItem._id,
              convertedForUserEmail: resolvedUserEmail,
            },
          },
        ],
        { session }
      );

      responseData = {
        request: {
          requestId: requestDoc.requestId,
          status: requestDoc.status,
          convertedAt: requestDoc.convertedAt,
          convertedEasyBoughtItemId: requestDoc.convertedEasyBoughtItemId,
        },
        item: createdItem,
      };
    });

    return res.status(200).json({
      message: "Public request converted successfully",
      data: responseData,
    });
  } catch (error: any) {
    const message = normalizeString(error?.message) || "Unknown error";
    const lower = message.toLowerCase();
    if (lower.includes("not found")) {
      return res.status(404).json({ message });
    }
    if (lower.includes("currently")) {
      return res.status(409).json({ message });
    }
    return res.status(400).json({
      message: "Failed to convert public request",
      reason: message,
    });
  } finally {
    await session.endSession();
  }
};

export const SuperAdminGetLoginStats = async (req: Request, res: Response) => {
  try {
    const grouped = await SessionModel.aggregate([
      {
        $match: {
          active: true,
          expiresAt: { $gt: new Date() },
        },
      },
      {
        $group: {
          _id: "$role",
          uniqueUsers: { $addToSet: "$user" },
        },
      },
      {
        $project: {
          _id: 0,
          role: "$_id",
          count: { $size: "$uniqueUsers" },
        },
      },
    ]);

    const counts = grouped.reduce<Record<string, number>>((acc, item) => {
      acc[String(item.role || "")] = Number(item.count || 0);
      return acc;
    }, {});

    return res.status(200).json({
      message: "Login statistics retrieved successfully",
      data: {
        usersLoggedIn: counts.User || 0,
        adminsLoggedIn: counts.Admin || 0,
        superAdminsLoggedIn: counts.SuperAdmin || 0,
        totalLoggedIn: (counts.User || 0) + (counts.Admin || 0) + (counts.SuperAdmin || 0),
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve login statistics",
      reason: error?.message || "Unknown error",
    });
  }
};
