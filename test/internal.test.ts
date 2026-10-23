import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenSigner, createTokenVerifier, generateSigningKey, type Scope, type ServiceId } from "@melvingadgets/platform-kit";

// U2: the service-token routes the store calls (BACKEND-UNIFICATION.md §8). Runs against a
// throwaway database on the local MongoDB, dropped at the end.

const signer = createTokenSigner({ issuer: "http://auth.test", keys: [generateSigningKey("k1")], activeKid: "k1" });
let app: express.Application;

const token = async (scopes: Scope[], caller: ServiceId = "store", audience: ServiceId = "easybuy") =>
  `Bearer ${(await signer.signServiceToken({ caller, audience, scopes })).token}`;

beforeAll(async () => {
  await (await import("../Database/Database.js")).default;
  const PriceModel = (await import("../Model/EasyBuyCapacityPriceModel.js")).default;
  await PriceModel.create([
    { provider: "aurapay", model: "iPhone 13", capacity: "128GB", price: 420000 },
    { provider: "aurapay", model: "iPhone 13", capacity: "256GB", price: 455000.5 },
  ]);
  const { createInternalRouter } = await import("../Router/InternalRouter.js");
  const verifier = createTokenVerifier({ issuer: "http://auth.test", jwks: await signer.jwks() });
  app = express();
  app.use("/api/v1/internal", createInternalRouter(verifier));
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe("service-token guard", () => {
  it("refuses calls without a token, with another audience, or without the scope", async () => {
    expect((await request(app).get("/api/v1/internal/catalog")).status).toBe(401);
    expect((await request(app).get("/api/v1/internal/catalog").set("authorization", await token(["market:prices.read"], "easybuy", "market"))).status).toBe(401);
    expect((await request(app).get("/api/v1/internal/catalog").set("authorization", await token(["easybuy:quote.read"]))).status).toBe(403);
  });

  it("answers 503 when platform tokens aren't configured, instead of letting calls through", async () => {
    const { createInternalRouter } = await import("../Router/InternalRouter.js");
    const unconfigured = express().use("/api/v1/internal", createInternalRouter(null));
    expect((await request(unconfigured).get("/api/v1/internal/catalog").set("authorization", await token(["easybuy:catalog.read"]))).status).toBe(503);
  });
});

describe("GET /internal/catalog", () => {
  it("returns prices as integer kobo", async () => {
    const res = await request(app).get("/api/v1/internal/catalog?provider=aurapay").set("authorization", await token(["easybuy:catalog.read"]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: "aurapay", currency: "NGN", unit: "kobo" });
    const iphone13 = res.body.models.find((model: { model: string }) => model.model === "iPhone 13");
    expect(iphone13.pricesByCapacity).toEqual({ "128GB": 42_000_000, "256GB": 45_500_050 });
    expect(res.body.planRules.weeklyMarkupMultipliers["8"]).toBe(1.4);
  });

  it("rejects an unknown provider", async () => {
    const res = await request(app).get("/api/v1/internal/catalog?provider=nope").set("authorization", await token(["easybuy:catalog.read"]));
    expect(res.status).toBe(400);
  });
});

describe("GET /internal/quote", () => {
  const quote = async (query: Record<string, string>) =>
    request(app).get("/api/v1/internal/quote").query(query).set("authorization", await token(["easybuy:quote.read"]));

  it("matches the worked example: iPhone 13 128GB, weekly x 8 is 44,100 a week", async () => {
    const res = await quote({ provider: "aurapay", model: "iPhone 13", capacity: "128GB", plan: "Weekly", duration: "8" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      unit: "kobo",
      phonePrice: 42_000_000,
      downPaymentPercentage: 40,
      minimumDownPayment: 16_800_000,
      downPayment: 16_800_000,
      loanedAmount: 25_200_000,
      markupMultiplier: 1.4,
      totalRepayable: 35_280_000,
    });
    expect(res.body.instalments).toEqual(Array(8).fill(4_410_000));
  });

  it("instalments always add up to the total, even when it doesn't divide evenly", async () => {
    const res = await quote({ provider: "aurapay", model: "iPhone 13", capacity: "256GB", plan: "Weekly", duration: "12" });
    expect(res.status).toBe(200);
    const sum = (res.body.instalments as number[]).reduce((total, part) => total + part, 0);
    expect(sum).toBe(res.body.totalRepayable);
    expect((res.body.instalments as number[]).every(Number.isInteger)).toBe(true);
  });

  it("accepts a larger down payment and refuses one below the minimum", async () => {
    const larger = await quote({ provider: "aurapay", model: "iPhone 13", capacity: "128GB", plan: "Monthly", duration: "3", downPayment: "20000000" });
    expect(larger.status).toBe(200);
    expect(larger.body.loanedAmount).toBe(22_000_000);
    const tooSmall = await quote({ provider: "aurapay", model: "iPhone 13", capacity: "128GB", plan: "Monthly", duration: "3", downPayment: "100" });
    expect(tooSmall.status).toBe(400);
    const fractional = await quote({ provider: "aurapay", model: "iPhone 13", capacity: "128GB", plan: "Monthly", duration: "3", downPayment: "16800000.5" });
    expect(fractional.status).toBe(400);
  });

  it("rejects unknown models, capacities, plans and durations", async () => {
    const base = { provider: "aurapay", model: "iPhone 13", capacity: "128GB", plan: "Weekly", duration: "8" };
    expect((await quote({ ...base, model: "iPhone 99" })).status).toBe(400);
    expect((await quote({ ...base, capacity: "64GB" })).status).toBe(400);
    expect((await quote({ ...base, plan: "Daily" })).status).toBe(400);
    expect((await quote({ ...base, duration: "9" })).status).toBe(400);
  });

  it("404s a valid model with no price set", async () => {
    const res = await quote({ provider: "aurapay", model: "iPhone 13", capacity: "512GB", plan: "Weekly", duration: "8" });
    expect(res.status).toBe(404);
  });
});
