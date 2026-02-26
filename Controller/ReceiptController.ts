import { type Request, type Response } from "express";
import fs from "fs/promises";
import ReceiptModel from "../Model/ReceiptModel.js";
import cloudinary from "../Utils/cloudinary.js";
import EasyBoughtItemModel from "../Model/EasyBoughtitem.js";
import AuditLogModel from "../Model/AuditLogModel.js";

const toNumber = (value: unknown): number => Number(value);
const normalizeReason = (value: unknown): string => {
  const trimmed = String(value ?? "").trim();
  return trimmed || "No reason provided";
};

const isValidReceiptMimeType = (mimeType: string) => {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
};

let checkedLegacyPaymentIndex = false;
const ensureLegacyPaymentIndexRemoved = async () => {
  if (checkedLegacyPaymentIndex) return;

  try {
    const indexes = await ReceiptModel.collection.indexes();
    const hasLegacyPaymentIndex = indexes.some((index) => index.name === "payment_1");

    if (hasLegacyPaymentIndex) {
      await ReceiptModel.collection.dropIndex("payment_1");
    }
  } finally {
    checkedLegacyPaymentIndex = true;
  }
};

export const UploadReceipt = async (req: Request, res: Response) => {
  const userId = req.user?._id;
  if (!userId) {
    return res.status(401).json({ message: "Access denied" });
  }

  try {
    await ensureLegacyPaymentIndexRemoved();

    const { amount } = req.body;
    const file = req.file as any;

    if (!amount) {
      return res.status(400).json({
        message: "amount is required",
      });
    }

    if (!file) {
      return res.status(400).json({ message: "Receipt file is required" });
    }

    if (!isValidReceiptMimeType(file.mimetype)) {
      return res.status(400).json({ message: "Only image or PDF receipts are allowed" });
    }

    const parsedAmount = toNumber(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ message: "amount must be greater than zero" });
    }

    const easyBoughtItem = await EasyBoughtItemModel.findOne({ UserId: userId })
      .sort({ createdAt: -1 })
      .lean();
    if (!easyBoughtItem) {
      return res.status(404).json({
        message: "No EasyBought item found for this user",
      });
    }

    const uploaded = await cloudinary.uploader.upload(file.path, {
      folder: "easybuy/receipts",
      resource_type: "auto",
      use_filename: true,
      unique_filename: true,
    });
    const receipt = await ReceiptModel.create({
      user: userId,
      plan: easyBoughtItem.Plan,
      amount: parsedAmount,
      fileUrl: uploaded.secure_url,
      fileType: file.mimetype === "application/pdf" ? "pdf" : "image",
      cloudinaryPublicId: uploaded.public_id,
      status: "pending",
    });

    await fs.unlink(file.path).catch(() => undefined);

    return res.status(201).json({
      message: "Receipt uploaded successfully and awaiting approval",
      data: receipt,
    });
  } catch (error: any) {
    const file = req.file as any;
    if (file?.path) {
      await fs.unlink(file.path).catch(() => undefined);
    }
    const reason = error?.message || "Unknown error";
    return res.status(400).json({
      message: `Failed to upload receipt: ${reason}`,
      reason,
    });
  }
};

export const GetMyReceipts = async (req: Request, res: Response) => {
  const userId = req.user?._id;
  if (!userId) {
    return res.status(401).json({ message: "Access denied" });
  }

  try {
    const receipts = await ReceiptModel.find({ user: userId })
      .sort({ createdAt: -1 })
      .select({ amount: 1, fileUrl: 1, fileType: 1, status: 1, createdAt: 1 })
      .lean();

    return res.status(200).json({
      message: "Receipts retrieved successfully",
      data: receipts,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve receipts",
      reason: error?.message || "Unknown error",
    });
  }
};

export const GetPendingReceipts = async (_req: Request, res: Response) => {
  try {
    const receipts = await ReceiptModel.find({ status: "pending" })
      .sort({ createdAt: -1 })
      .populate({
        path: "user",
        select: "fullName email createdByAdmin",
        populate: {
          path: "createdByAdmin",
          select: "fullName email role",
        },
      })
      .select({ amount: 1, fileUrl: 1, fileType: 1, status: 1, createdAt: 1, user: 1 })
      .lean();

    return res.status(200).json({
      message: "Pending receipts retrieved successfully",
      data: receipts,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve pending receipts",
      reason: error?.message || "Unknown error",
    });
  }
};

export const ApproveReceiptPayment = async (req: Request, res: Response) => {
  try {
    const actorId = req.user?._id;
    const actorRole = req.user?.role;
    const { receiptId } = req.params;
    if (!receiptId) {
      return res.status(400).json({ message: "receiptId is required" });
    }

    const approvedAt = new Date();
    const receipt = await ReceiptModel.findOneAndUpdate(
      { _id: receiptId, status: "pending" },
      {
        $set: {
          status: "approved",
          approvedAt,
        },
      },
      { returnDocument: "after" }
    ).lean();

    if (!receipt) {
      const existingReceipt = await ReceiptModel.findById(receiptId).select({ _id: 1, status: 1 }).lean();
      if (!existingReceipt) {
        return res.status(404).json({ message: "Receipt not found" });
      }

      return res.status(409).json({ message: "Receipt is already approved" });
    }

    const reason = normalizeReason(req.body?.reason);

    if (actorId && actorRole === "SuperAdmin") {
      await AuditLogModel.create({
        actor: actorId,
        actorRole,
        action: "RECEIPT_APPROVE",
        targetType: "receipt",
        targetId: receipt._id,
        reason,
        metadata: {
          receiptAmount: receipt.amount,
          receiptPlan: receipt.plan,
          receiptOwner: receipt.user,
        },
      });
    }

    return res.status(200).json({
      message: "Payment approved successfully",
      data: {
        receiptId: receipt._id,
        receiptStatus: receipt.status,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to approve receipt payment",
      reason: error?.message || "Unknown error",
    });
  }
};
