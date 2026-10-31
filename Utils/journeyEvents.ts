import {
  easybuyItemCreated,
  easybuyPaymentApproved,
  easybuyRequestApproved,
  easybuyRequestRejected,
  easybuyRequestSubmitted,
  publishInTransaction,
  type MongoSession,
} from "@melvingadgets/platform-kit";
import type { Request } from "express";
import { rawDb } from "./messaging.js";
import { toKobo, type ServiceFee } from "./serviceFee.js";

// The customer-journey events EasyBuy owns (kit journey.ts, RESELLER-PLAN.md §7). Each is
// written in the SAME transaction as the change it describes (Shortwork/AGENTS.md §3.1):
// callers pass the session their own writes use. Events carry IDs, product data and kobo,
// never a phone or an email.

const FALLBACK_TRACE_ID = "00000000-0000-0000-0000-000000000000";
export const traceIdOf = (req: Request): string => req.traceId ?? FALLBACK_TRACE_ID;

type Plan = "Weekly" | "Monthly";

const subjectFor = (kind: string, id: string, personId: string | null) =>
  personId ? { kind, id, personId } : { kind, id };

export const publishRequestSubmitted = (
  session: MongoSession,
  traceId: string,
  request: { requestId: string; personId?: string | null; provider: string; iphoneModel: string; capacity: string; plan: Plan },
) => {
  const personId = request.personId || null;
  return publishInTransaction(rawDb(), session, easybuyRequestSubmitted, {
    subject: subjectFor("request", request.requestId, personId),
    traceId,
    data: {
      requestId: request.requestId,
      personId,
      provider: request.provider,
      model: request.iphoneModel,
      capacity: request.capacity,
      plan: request.plan,
    },
  });
};

export const publishRequestReviewed = (
  session: MongoSession,
  traceId: string,
  outcome: "approved" | "rejected",
  request: { requestId: string; personId?: string | null },
) => {
  const personId = request.personId || null;
  return publishInTransaction(rawDb(), session, outcome === "approved" ? easybuyRequestApproved : easybuyRequestRejected, {
    subject: subjectFor("request", request.requestId, personId),
    traceId,
    data: { requestId: request.requestId, personId },
  });
};

export const publishItemCreated = (
  session: MongoSession,
  traceId: string,
  item: {
    itemId: string;
    requestId: string | null;
    personId: string | null;
    provider: string;
    model: string;
    capacity: string;
    plan: Plan;
    phonePriceKobo: number;
    downPaymentKobo: number;
    financedKobo: number;
    fee: ServiceFee;
  },
) =>
  publishInTransaction(rawDb(), session, easybuyItemCreated, {
    subject: subjectFor("item", item.itemId, item.personId),
    traceId,
    data: {
      itemId: item.itemId,
      requestId: item.requestId,
      personId: item.personId,
      provider: item.provider,
      model: item.model,
      capacity: item.capacity,
      plan: item.plan,
      phonePriceKobo: item.phonePriceKobo,
      downPaymentKobo: item.downPaymentKobo,
      financedKobo: item.financedKobo,
      serviceFeeKobo: item.fee.serviceFeeKobo,
      serviceFeeBps: item.fee.serviceFeeBps,
    },
  });

/**
 * A repayment proof was approved: the customer's money is now recorded as paid, and the invoice
 * service issues the repayment document from this event (docs/invoice-service.md).
 *
 * `amount` is the receipt's **naira float** — `ReceiptModel.amount` predates the kobo rule — and is
 * converted once, here, at the producer boundary (Shortwork/AGENTS.md §4.1). No float crosses a
 * service boundary.
 *
 * `method` is "unknown" because the legacy receipt records no payment method; the field exists so
 * the document can say how money arrived once EasyBuy starts capturing it, not so this call site can
 * guess.
 */
export const publishPaymentApproved = (
  session: MongoSession,
  traceId: string,
  payment: {
    receiptId: string;
    personId: string | null;
    itemId: string | null;
    amount: number;
    plan: string;
    approvedAt: Date;
  },
) => {
  const plan = payment.plan === "Weekly" || payment.plan === "Monthly" ? payment.plan : "Monthly";
  return publishInTransaction(rawDb(), session, easybuyPaymentApproved, {
    subject: subjectFor("receipt", payment.receiptId, payment.personId),
    traceId,
    data: {
      receiptId: payment.receiptId,
      personId: payment.personId,
      itemId: payment.itemId,
      amountKobo: toKobo(payment.amount),
      plan,
      method: "unknown" as const,
      approvedAt: payment.approvedAt.toISOString(),
    },
  });
};
