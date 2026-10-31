import { type Request, type Response } from "express";
import { inTransaction } from "@melvingadgets/platform-kit";
import fs from "fs/promises";
import ReceiptModel from "../Model/ReceiptModel.js";
import cloudinary from "../Utils/cloudinary.js";
import EasyBoughtItemModel from "../Model/EasyBoughtitem.js";
import AuditLogModel from "../Model/AuditLogModel.js";
import UserModel from "../Model/UserModel.js";
import { config } from "../config/Config.js";
import { mongoClient } from "../Utils/messaging.js";
import { publishPaymentApproved, traceIdOf } from "../Utils/journeyEvents.js";

/** The session a caller supplied, or null when events are off and no transaction is open. */
type MaybeSession = Parameters<typeof publishPaymentApproved>[0] | null;

/**
 * Marks a pending receipt approved, returning it or null when it was not pending.
 *
 * The filter is the concurrency control (Shortwork/AGENTS.md §3.8): two admins approving at once
 * means one `findOneAndUpdate` matches and the other gets null → 409, never two approvals.
 */
const approvePendingReceipt = async (receiptId: string, approvedAt: Date, session: MaybeSession) =>
  ReceiptModel.findOneAndUpdate(
    { _id: receiptId, status: "pending" },
    { $set: { status: "approved", approvedAt } },
    { returnDocument: "after", ...(session ? { session: session as never } : {}) }
  ).lean();

/**
 * Who this receipt belongs to, for the invoice.
 *
 * `personId` is auth's id and comes only from the account's `personId` field — the same rule the
 * rest of EasyBuy uses (`UserController` when it stamps an item, `InternalController` when it looks
 * a person's journey up). An account with no field is **not linked to auth**, and the honest answer
 * is null: falling back to the account's `_id` would send an EasyBuy ObjectId as though it were an
 * auth personId, and the invoice service would address a financial document to a nonexistent person.
 *
 * The financed item is looked up by the owning account, which is how items created before items
 * carried `personId` are still found.
 */
const resolveReceiptOwner = async (
  receipt: { _id: unknown; user: unknown },
  session: MaybeSession
): Promise<{ personId: string | null; itemId: string | null }> => {
  const account = await UserModel.findById(receipt.user)
    .select({ _id: 1, personId: 1 })
    .lean()
    .session(session as never);
  const personId = String(account?.personId ?? "").trim() || null;

  const item = await EasyBoughtItemModel.findOne({ UserId: receipt.user } as never)
    .select({ _id: 1 })
    .sort({ createdAt: -1 })
    .lean()
    .session(session as never);

  return { personId, itemId: item ? String(item._id) : null };
};

const toNumber = (value: unknown): number => Number(value);
const normalizeReason = (value: unknown): string => {
  const trimmed = String(value ?? "").trim();
  return trimmed || "No reason provided";
};
const normalizeRequiredReason = (value: unknown): string => String(value ?? "").trim();

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
      .select({
        amount: 1,
        fileUrl: 1,
        fileType: 1,
        status: 1,
        createdAt: 1,
        rejectedAt: 1,
        rejectionReason: 1,
      })
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
    const { receiptId: rawReceiptId } = req.params;
    const receiptId = typeof rawReceiptId === "string" ? rawReceiptId : "";
    if (!receiptId) {
      return res.status(400).json({ message: "receiptId is required" });
    }

    // The approval, its audit row and its event commit together (Shortwork/AGENTS.md §3.1). The
    // audit row was previously written *after* a separate update, so a crash in between left an
    // approval with no record of who made it. With events off the behaviour is the plain update it
    // was, so the rollout stays additive (§7.1).
    const approvedAt = new Date();
    const receipt = await (config.eventsEnabled
      ? inTransaction(mongoClient(), async (session) => {
          const approved = await approvePendingReceipt(receiptId, approvedAt, session);
          if (!approved) return null;

          if (actorId && actorRole === "SuperAdmin") {
            await AuditLogModel.create(
              [
                {
                  actor: actorId,
                  actorRole,
                  action: "RECEIPT_APPROVE",
                  targetType: "receipt",
                  targetId: approved._id,
                  reason: normalizeReason(req.body?.reason),
                  metadata: { receiptAmount: approved.amount, receiptPlan: approved.plan, receiptOwner: approved.user },
                },
              ],
              { session: session as never }
            );
          }

          const owner = await resolveReceiptOwner(approved, session);
          await publishPaymentApproved(session, traceIdOf(req), {
            receiptId: String(approved._id),
            personId: owner.personId,
            itemId: owner.itemId,
            amount: approved.amount,
            plan: approved.plan,
            approvedAt,
          });
          return approved;
        })
      : approvePendingReceipt(receiptId, approvedAt, null));

    if (!receipt) {
      const existingReceipt = await ReceiptModel.findById(receiptId).select({ _id: 1, status: 1 }).lean();
      if (!existingReceipt) {
        return res.status(404).json({ message: "Receipt not found" });
      }

      const existingStatus = String(existingReceipt.status || "unknown");
      return res.status(409).json({ message: `Receipt is already ${existingStatus}` });
    }

    if (!config.eventsEnabled && actorId && actorRole === "SuperAdmin") {
      await AuditLogModel.create({
        actor: actorId,
        actorRole,
        action: "RECEIPT_APPROVE",
        targetType: "receipt",
        targetId: receipt._id,
        reason: normalizeReason(req.body?.reason),
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

export const RejectReceiptPayment = async (req: Request, res: Response) => {
  try {
    const actorId = req.user?._id;
    const actorRole = req.user?.role;
    const { receiptId } = req.params;
    if (!receiptId) {
      return res.status(400).json({ message: "receiptId is required" });
    }

    const reason = normalizeRequiredReason(req.body?.reason);
    if (!reason) {
      return res.status(400).json({ message: "reason is required to reject a receipt" });
    }

    const rejectedAt = new Date();
    const receipt = await ReceiptModel.findOneAndUpdate(
      { _id: receiptId, status: "pending" },
      {
        $set: {
          status: "rejected",
          rejectedAt,
          rejectedBy: actorId || null,
          rejectionReason: reason,
        },
      },
      { returnDocument: "after" }
    ).lean();

    if (!receipt) {
      const existingReceipt = await ReceiptModel.findById(receiptId).select({ _id: 1, status: 1 }).lean();
      if (!existingReceipt) {
        return res.status(404).json({ message: "Receipt not found" });
      }

      const existingStatus = String(existingReceipt.status || "unknown");
      return res.status(409).json({ message: `Receipt is already ${existingStatus}` });
    }

    if (actorId && actorRole === "SuperAdmin") {
      await AuditLogModel.create({
        actor: actorId,
        actorRole,
        action: "RECEIPT_REJECT",
        targetType: "receipt",
        targetId: receipt._id,
        reason,
        metadata: {
          receiptAmount: receipt.amount,
          receiptPlan: receipt.plan,
          receiptOwner: receipt.user,
          rejectedAt,
        },
      });
    }

    return res.status(200).json({
      message: "Receipt rejected successfully",
      data: {
        receiptId: receipt._id,
        receiptStatus: receipt.status,
        rejectionReason: receipt.rejectionReason,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to reject receipt payment",
      reason: error?.message || "Unknown error",
    });
  }
};
