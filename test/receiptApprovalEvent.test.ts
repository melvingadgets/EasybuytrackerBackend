import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OUTBOX_COLLECTION } from "@melvingadgets/platform-kit";

// Approving a repayment proof writes its `easybuy.payment.approved` event in the same transaction as
// the status change (Shortwork/AGENTS.md §3.1), and the money crosses the boundary as integer kobo
// (§4.1) even though `ReceiptModel.amount` is a naira float. The invoice service reads this event
// and nothing else (docs/invoice-service.md), so a wrong amount here is a wrong document there.

const ACTOR = "60a000000000000000000001";
const OWNER = "60a000000000000000000002";

let app: express.Application;
let ReceiptModel: typeof import("../Model/ReceiptModel.js").default;
let UserModel: typeof import("../Model/UserModel.js").default;
let ItemModel: typeof import("../Model/EasyBoughtitem.js").default;
let AuditModel: typeof import("../Model/AuditLogModel.js").default;

beforeAll(async () => {
  await (await import("../Database/Database.js")).default;
  ReceiptModel = (await import("../Model/ReceiptModel.js")).default;
  UserModel = (await import("../Model/UserModel.js")).default;
  ItemModel = (await import("../Model/EasyBoughtitem.js")).default;
  AuditModel = (await import("../Model/AuditLogModel.js")).default;
  await Promise.all([ReceiptModel.syncIndexes(), UserModel.syncIndexes(), ItemModel.syncIndexes()]);
  const { initOutbox } = await import("../Utils/messaging.js");
  await initOutbox();

  const { ApproveReceiptPayment } = await import("../Controller/ReceiptController.js");
  app = express();
  app.use(express.json());
  app.post(
    "/approve/:receiptId",
    (req, _res, next) => {
      (req as unknown as { user: unknown }).user = { _id: ACTOR, role: "SuperAdmin" };
      (req as unknown as { traceId: string }).traceId = "trace-receipttest";
      next();
    },
    ApproveReceiptPayment
  );
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([
    ReceiptModel.deleteMany({}),
    UserModel.deleteMany({}),
    ItemModel.deleteMany({}),
    AuditModel.deleteMany({}),
    mongoose.connection.db!.collection(OUTBOX_COLLECTION).deleteMany({}),
    mongoose.connection.db!.collection("event_seqs").deleteMany({}),
  ]);
});

const outbox = () => mongoose.connection.db!.collection(OUTBOX_COLLECTION);

const seed = async (options: { personId?: string | null; amount?: number } = {}) => {
  await UserModel.create({
    _id: new mongoose.Types.ObjectId(OWNER),
    fullName: "Receipt Owner",
    email: "owner@example.test",
    ...(options.personId === null ? {} : { personId: options.personId ?? OWNER }),
  });
  const item = await ItemModel.create({
    provider: "aurapay",
    IphoneModel: "iPhone 13",
    IphoneImageUrl: "https://example.test/x.png",
    capacity: "128GB",
    Plan: "Monthly",
    downPayment: 200_000,
    loanedAmount: 300_000,
    PhonePrice: 500_000,
    UserId: new mongoose.Types.ObjectId(OWNER),
    UserEmail: "owner@example.test",
  });
  const receipt = await ReceiptModel.create({
    user: new mongoose.Types.ObjectId(OWNER),
    plan: "Monthly",
    // Naira, deliberately a float: the boundary converts it (AGENTS.md §4.1).
    amount: options.amount ?? 86_400.5,
    fileUrl: "https://example.test/proof.jpg",
    fileType: "image",
    cloudinaryPublicId: "proof",
    status: "pending",
  });
  return { receipt, item };
};

describe("receipt approval → outbox", () => {
  it("writes the event with integer kobo, a personId and the item, in the same transaction", async () => {
    const { receipt, item } = await seed();
    const res = await request(app).post(`/approve/${receipt._id}`).send({ reason: "confirmed in bank" });
    expect(res.status).toBe(200);

    const events = await outbox().find({}).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "easybuy.payment.approved",
      source: "easybuy",
      status: "pending",
      seq: 1,
      subject: { kind: "receipt", id: String(receipt._id), personId: OWNER },
      data: {
        receiptId: String(receipt._id),
        personId: OWNER,
        itemId: String(item._id),
        // ₦86,400.50 → 8_640_050 kobo, an integer.
        amountKobo: 8_640_050,
        plan: "Monthly",
        method: "unknown",
      },
    });

    const stored = events[0]!.data as { amountKobo: number; approvedAt: string };
    expect(Number.isSafeInteger(stored.amountKobo)).toBe(true);
    expect(Date.parse(stored.approvedAt)).not.toBeNaN();

    // The receipt and its audit row landed too — all three, or none.
    expect((await ReceiptModel.findById(receipt._id).lean())?.status).toBe("approved");
    expect(await AuditModel.countDocuments({ action: "RECEIPT_APPROVE" })).toBe(1);
  });

  it("carries a null personId for an account that is not linked to auth", async () => {
    // The model keeps a missing field missing rather than storing null (UserModel), so an unlinked
    // account has no `personId` at all. The event schema allows null (personRef), so the producer
    // must send null and not the account's own _id — that would be an EasyBuy id masquerading as an
    // auth personId, and the invoice service would issue a document to nobody.
    const { receipt } = await seed({ personId: null });
    expect((await UserModel.findById(OWNER).lean())?.personId).toBeUndefined();

    expect((await request(app).post(`/approve/${receipt._id}`).send({})).status).toBe(200);
    const event = await outbox().findOne({});
    expect((event?.data as { personId: unknown }).personId).toBeNull();
    expect((event?.subject as { personId?: unknown }).personId).toBeUndefined();
  });

  it("writes no event when the receipt is not pending, and approves nothing twice", async () => {
    const { receipt } = await seed();
    await request(app).post(`/approve/${receipt._id}`).send({}).expect(200);
    const second = await request(app).post(`/approve/${receipt._id}`).send({});

    expect(second.status).toBe(409);
    expect(await outbox().countDocuments({})).toBe(1);
    expect(await AuditModel.countDocuments({ action: "RECEIPT_APPROVE" })).toBe(1);
  });

  it("writes nothing at all when the receipt does not exist", async () => {
    const missing = new mongoose.Types.ObjectId();
    expect((await request(app).post(`/approve/${missing}`).send({})).status).toBe(404);
    expect(await outbox().countDocuments({})).toBe(0);
  });
});
