import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OUTBOX_COLLECTION } from "@melvingadgets/platform-kit";

// U3: a SuperAdmin price change writes its easybuy.price.updated event to the outbox in the same
// transaction (Shortwork/AGENTS.md §3.1). Runs against the local replica set (setup-env), dropped
// at the end. No relay here — just the producer side.

const ACTOR = "60a000000000000000000001";
let app: express.Application;
let PriceModel: typeof import("../Model/EasyBuyCapacityPriceModel.js").default;

beforeAll(async () => {
  await (await import("../Database/Database.js")).default;
  PriceModel = (await import("../Model/EasyBuyCapacityPriceModel.js")).default;
  await PriceModel.syncIndexes();
  const { initOutbox } = await import("../Utils/messaging.js");
  await initOutbox();
  const { SuperAdminUpdateEasyBuyPricing } = await import("../Controller/SuperAdminController.js");
  app = express();
  app.use(express.json());
  app.post(
    "/price",
    (req, _res, next) => {
      (req as unknown as { user: unknown }).user = { _id: ACTOR, role: "SuperAdmin" };
      (req as unknown as { traceId: string }).traceId = "trace-pricetest";
      next();
    },
    SuperAdminUpdateEasyBuyPricing,
  );
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([
    PriceModel.deleteMany({}),
    mongoose.connection.db!.collection(OUTBOX_COLLECTION).deleteMany({}),
    mongoose.connection.db!.collection("event_seqs").deleteMany({}),
  ]);
});

const outbox = () => mongoose.connection.db!.collection(OUTBOX_COLLECTION);
const update = (updates: Array<{ model: string; capacity: string; price: number }>) =>
  request(app).post("/price").send({ provider: "aurapay", updates });

describe("price change → outbox", () => {
  it("writes one event per changed row, in the same transaction, in kobo", async () => {
    const res = await update([{ model: "iPhone 13", capacity: "128GB", price: 420000 }]);
    expect(res.status).toBe(200);

    const events = await outbox().find({}).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "easybuy.price.updated",
      source: "easybuy",
      status: "pending",
      seq: 1,
      subject: { kind: "price", id: "aurapay:iPhone 13:128GB" },
      data: { provider: "aurapay", model: "iPhone 13", capacity: "128GB", priceKobo: 42_000_000, previousPriceKobo: null },
    });
    // The price row and the event both landed.
    expect(await PriceModel.countDocuments({ model: "iPhone 13", capacity: "128GB" })).toBe(1);
  });

  it("carries the previous price and bumps seq on a later change to the same row", async () => {
    await update([{ model: "iPhone 13", capacity: "128GB", price: 420000 }]);
    await update([{ model: "iPhone 13", capacity: "128GB", price: 400000 }]);

    const events = await outbox().find({}).sort({ seq: 1 }).toArray();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      seq: 2,
      data: { priceKobo: 40_000_000, previousPriceKobo: 42_000_000 },
    });
  });

  it("emits no event when the submitted price equals the current one", async () => {
    await update([{ model: "iPhone 13", capacity: "128GB", price: 420000 }]);
    const res = await update([{ model: "iPhone 13", capacity: "128GB", price: 420000 }]);
    expect(res.status).toBe(200);
    expect(await outbox().countDocuments()).toBe(1); // still just the first change
  });

  it("writes an event per row across several models in one request", async () => {
    await update([
      { model: "iPhone 13", capacity: "128GB", price: 420000 },
      { model: "iPhone 13", capacity: "256GB", price: 480000 },
    ]);
    const subjects = (await outbox().find({}).toArray()).map((e) => (e as { subject: { id: string } }).subject.id).sort();
    expect(subjects).toEqual(["aurapay:iPhone 13:128GB", "aurapay:iPhone 13:256GB"]);
  });
});
