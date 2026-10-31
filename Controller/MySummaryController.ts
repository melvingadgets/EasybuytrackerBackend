import type { Request, Response } from "express";
import EasyBoughtItemModel from "../Model/EasyBoughtitem.js";
import ReceiptModel from "../Model/ReceiptModel.js";
import UserModel from "../Model/UserModel.js";
import { toKobo } from "../Utils/serviceFee.js";

// GET /api/v1/user/summary — the signed-in customer's own EasyBuy picture, for the Melvin OS
// Profile app (2026-10-30).
//
// Why a new route rather than reusing one:
//   - `/api/v1/internal/people/:personId/journey` is service-token only (`easybuy:journey.read`,
//     held by the reseller alone); a browser cannot and must not call it.
//   - `/geteasyboughtitems` returns raw documents, and `/api/dashboard` returns naira FLOATS.
//     AGENTS.md §4.1 says money leaves a service as integer kobo, so this route converts once,
//     at the boundary, with `toKobo`.
//
// Identity is `req.user` — set by `verifyToken` from a verified token, never from the body or a
// query (AGENTS.md §2.5). Read-only: it writes nothing.
//
// Deliberately absent: the NIN, the bank statements and the NIN selfie. They live in
// `applicationdocuments`, the app shows that they exist through its own route, and this one must
// never carry them (the collection stores the NIN in plain text — see EasybuytrackerBackend/AGENTS.md).

const iso = (value: unknown): string | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null);

/**
 * The exact JSON shape, as a pure function.
 *
 * It is pure on purpose: the money conversion and the privacy boundary are the two things that
 * must not drift, and this way they are testable without a database (`test/mySummary.mapping.test.ts`).
 * Nothing here reads `req` or hits Mongo.
 */
export const toSummaryItem = (item: {
  _id: unknown;
  IphoneModel?: string | null;
  IphoneImageUrl?: string | null;
  capacity?: string | null;
  Plan?: string | null;
  PhonePrice?: number | null;
  downPayment?: number | null;
  loanedAmount?: number | null;
  serviceFeeKobo?: number | null;
  monthlyPlan?: number | null;
  weeklyPlan?: number | null;
  sourceRequestId?: string | null;
  createdAt?: Date | null;
}) => ({
  itemId: String(item._id),
  requestId: item.sourceRequestId ?? null,
  model: item.IphoneModel,
  imageUrl: item.IphoneImageUrl ?? null,
  capacity: item.capacity,
  plan: item.Plan,
  phonePriceKobo: toKobo(Number(item.PhonePrice ?? 0)),
  downPaymentKobo: toKobo(Number(item.downPayment ?? 0)),
  financedKobo: toKobo(Number(item.loanedAmount ?? 0)),
  // Items created before the service charge existed have none.
  serviceFeeKobo: Number.isSafeInteger(item.serviceFeeKobo) ? Number(item.serviceFeeKobo) : 0,
  monthlyPlan: item.monthlyPlan ?? null,
  weeklyPlan: item.weeklyPlan ?? null,
  createdAt: iso(item.createdAt),
});

/** Never a `fileUrl`: a receipt image is the customer's own banking proof, not profile data. */
export const toSummaryReceipt = (receipt: {
  _id: unknown;
  amount?: number | null;
  status?: string | null;
  createdAt?: Date | null;
  rejectedAt?: Date | null;
  rejectionReason?: string | null;
}) => ({
  id: String(receipt._id),
  amountKobo: toKobo(Number(receipt.amount ?? 0)),
  status: receipt.status ?? null,
  createdAt: iso(receipt.createdAt),
  rejectedAt: iso(receipt.rejectedAt),
  rejectionReason: receipt.rejectionReason ?? null,
});

export const GetMySummary = async (req: Request, res: Response) => {
  const userId = req.user?._id;
  if (!userId) {
    return res.status(401).json({ message: "Access denied" });
  }

  try {
    // `req.user` carries only the identity fields, so the platform link is read here.
    const account = await UserModel.findById(userId).select({ _id: 1, personId: 1 }).lean();
    if (!account) {
      return res.status(404).json({ message: "User not found" });
    }
    const personId = typeof account.personId === "string" && account.personId ? account.personId : null;

    // Items made before items carried a personId belong to the linked EasyBuy account, so both
    // are matched — the same fallback the internal journey route uses.
    const itemQuery = {
      $or: [{ UserId: account._id }, ...(personId ? [{ personId }] : [])],
    };

    const [items, receipts] = await Promise.all([
      EasyBoughtItemModel.find(itemQuery)
        .sort({ createdAt: -1 })
        .limit(50)
        .select({ IphoneModel: 1, IphoneImageUrl: 1, capacity: 1, Plan: 1, PhonePrice: 1, downPayment: 1, loanedAmount: 1, serviceFeeKobo: 1, monthlyPlan: 1, weeklyPlan: 1, sourceRequestId: 1, createdAt: 1 })
        .lean(),
      ReceiptModel.find({ user: account._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .select({ amount: 1, status: 1, createdAt: 1, rejectedAt: 1, rejectionReason: 1 })
        .lean(),
    ]);

    return res.status(200).json({
      message: "Summary retrieved successfully",
      unit: "kobo",
      asOf: new Date().toISOString(),
      personId,
      items: items.map(toSummaryItem),
      receipts: receipts.map(toSummaryReceipt),
    });
  } catch (error) {
    return res.status(400).json({
      message: "Failed to retrieve summary",
      reason: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};
