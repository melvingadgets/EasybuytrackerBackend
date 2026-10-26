import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  OUTBOX_COLLECTION,
  createTokenSigner,
  createTokenVerifier,
  generateSigningKey,
  type Scope,
  type ServiceId,
} from "@melvingadgets/platform-kit";

// The reseller programme's EasyBuy side (RESELLER-PLAN.md §7, §8b):
//   - an Apply request records the applicant's person only from a verified Melvin user token;
//   - submitted / approved / rejected / item.created events commit with their change (outbox);
//   - converting charges the 8% service fee on the financed amount, in integer kobo;
//   - the reseller service can read a person's journey with its own scoped token.
// Runs against the local replica set (setup-env), dropped at the end.

const ISSUER = "http://auth.test";
const signer = createTokenSigner({ issuer: ISSUER, keys: [generateSigningKey("k1")], activeKid: "k1" });
const SUPERADMIN = "60a000000000000000000001";
let app: express.Application;
let RequestModel: typeof import("../Model/PublicEasyBuyRequestModel.js").default;
let ItemModel: typeof import("../Model/EasyBoughtitem.js").default;
let UserModel: typeof import("../Model/UserModel.js").default;

const userToken = async (personId: string) =>
  `Bearer ${(await signer.signUserToken({ personId, role: "User", sessionId: `s-${personId}` })).token}`;
const serviceToken = async (scopes: Scope[], caller: ServiceId = "reseller") =>
  `Bearer ${(await signer.signServiceToken({ caller, audience: "easybuy", scopes })).token}`;

beforeAll(async () => {
  await (await import("../Database/Database.js")).default;
  RequestModel = (await import("../Model/PublicEasyBuyRequestModel.js")).default;
  ItemModel = (await import("../Model/EasyBoughtitem.js")).default;
  UserModel = (await import("../Model/UserModel.js")).default;
  await Promise.all([RequestModel.syncIndexes(), ItemModel.syncIndexes(), UserModel.syncIndexes()]);
  const { initOutbox } = await import("../Utils/messaging.js");
  await initOutbox();

  const verifier = createTokenVerifier({ issuer: ISSUER, jwks: await signer.jwks() });
  const { createPublicRouter } = await import("../Router/PublicRouter.js");
  const { createInternalRouter } = await import("../Router/InternalRouter.js");
  const admin = await import("../Controller/SuperAdminController.js");
  const asSuperAdmin: express.RequestHandler = (req, _res, next) => {
    (req as unknown as { user: unknown }).user = { _id: SUPERADMIN, role: "SuperAdmin" };
    (req as unknown as { traceId: string }).traceId = "trace-reseller-test";
    next();
  };

  app = express();
  app.use(express.json());
  app.use("/api/v1/public", createPublicRouter(verifier));
  app.use("/api/v1/internal", createInternalRouter(verifier));
  app.post("/admin/:requestId/approve", asSuperAdmin, admin.SuperAdminApprovePublicEasyBuyRequest);
  app.post("/admin/:requestId/reject", asSuperAdmin, admin.SuperAdminRejectPublicEasyBuyRequest);
  app.post("/admin/:requestId/convert", asSuperAdmin, admin.SuperAdminConvertPublicEasyBuyRequest);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([
    RequestModel.deleteMany({}),
    ItemModel.deleteMany({}),
    UserModel.deleteMany({}),
    mongoose.connection.db!.collection(OUTBOX_COLLECTION).deleteMany({}),
    mongoose.connection.db!.collection("event_seqs").deleteMany({}),
  ]);
});

const outbox = () => mongoose.connection.db!.collection(OUTBOX_COLLECTION);
let applicant = 0;
const apply = (token?: string, extra: Record<string, unknown> = {}) => {
  applicant += 1;
  const call = request(app)
    .post("/api/v1/public/easybuy-requests")
    .set("user-agent", `vitest-${applicant}`)
    .send({
      fullName: "Ada Obi",
      email: `ada${applicant}@example.com`,
      phone: "+2348030000000",
      iphoneModel: "iPhone 13",
      capacity: "128GB",
      plan: "Monthly",
      ...extra,
    });
  return token ? call.set("authorization", token) : call;
};

describe("service fee maths", () => {
  it("is 8% of the financed amount, in kobo, half-up", async () => {
    const { computeServiceFee } = await import("../Utils/serviceFee.js");
    expect(computeServiceFee({ phonePrice: 1_200_000, loanedAmount: 720_000 })).toMatchObject({
      serviceFeeKobo: 5_760_000,
      serviceFeeBps: 800,
      serviceFeeBase: "financed",
      baseKobo: 72_000_000,
    });
    // 8% of 1,234.56 naira = 98.7648 naira = 9,876.48 kobo -> 9,876.
    expect(computeServiceFee({ phonePrice: 2_000, loanedAmount: 1_234.56 }).serviceFeeKobo).toBe(9_876);
    // 8% of 0.06 naira = 0.48 kobo -> 0; 8% of 0.07 = 0.56 -> 1 (half-up).
    expect(computeServiceFee({ phonePrice: 1, loanedAmount: 0.06 }).serviceFeeKobo).toBe(0);
    expect(computeServiceFee({ phonePrice: 1, loanedAmount: 0.07 }).serviceFeeKobo).toBe(1);
    expect(computeServiceFee({ phonePrice: 1_000, loanedAmount: 600 }, { bps: 800, base: "price" }).serviceFeeKobo).toBe(8_000);
  });

  it("always matches exact half-up integer maths", async () => {
    const { computeServiceFee } = await import("../Utils/serviceFee.js");
    for (let i = 0; i < 500; i += 1) {
      const financedKobo = Math.floor(Math.random() * 500_000_000);
      const exact = (BigInt(financedKobo) * 800n * 2n + 10_000n) / 20_000n; // round half up of k*800/10000
      expect(BigInt(computeServiceFee({ phonePrice: 0, loanedAmount: financedKobo / 100 }).serviceFeeKobo)).toBe(exact);
    }
  });
});

describe("Apply request → person and event", () => {
  it("records the person only from a verified Melvin token, and writes easybuy.request.submitted", async () => {
    const res = await apply(await userToken("person-ada"));
    expect(res.status).toBe(201);
    const saved = await RequestModel.findOne({ requestId: res.body.data.requestId }).lean();
    expect(saved?.personId).toBe("person-ada");

    const events = await outbox().find({ type: "easybuy.request.submitted" }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "easybuy",
      subject: { kind: "request", id: res.body.data.requestId, personId: "person-ada" },
      data: { requestId: res.body.data.requestId, personId: "person-ada", model: "iPhone 13", capacity: "128GB", plan: "Monthly" },
    });
    expect(JSON.stringify(events[0])).not.toContain("example.com");
  });

  it("stays anonymous without a token, with a bad token, and ignores a personId in the body", async () => {
    const anonymous = await apply(undefined, { personId: "forged-person" });
    const bad = await apply("Bearer not-a-token");
    expect([anonymous.status, bad.status]).toEqual([201, 201]);
    const saved = await RequestModel.find({}).lean();
    expect(saved.every((doc) => doc.personId === undefined)).toBe(true);
    const events = await outbox().find({ type: "easybuy.request.submitted" }).toArray();
    expect(events.map((event) => event.data.personId)).toEqual([null, null]);
  });
});

describe("review → events", () => {
  it("writes approved and rejected events with the status change", async () => {
    const first = await apply(await userToken("person-b"));
    const second = await apply(await userToken("person-b"), { capacity: "256GB" });
    expect((await request(app).post(`/admin/${first.body.data.requestId}/approve`).send({})).status).toBe(200);
    expect((await request(app).post(`/admin/${second.body.data.requestId}/reject`).send({ reason: "incomplete" })).status).toBe(200);

    const types = (await outbox().find({}).sort({ createdAt: 1 }).toArray()).map((event) => event.type);
    expect(types).toEqual(["easybuy.request.submitted", "easybuy.request.submitted", "easybuy.request.approved", "easybuy.request.rejected"]);
    const approved = await outbox().findOne({ type: "easybuy.request.approved" });
    expect(approved).toMatchObject({ seq: 2, data: { personId: "person-b" } });
  });

  it("writes nothing when the change is refused", async () => {
    expect((await request(app).post("/admin/EBR-NOPE/approve").send({})).status).toBe(404);
    expect(await outbox().countDocuments({ type: "easybuy.request.approved" })).toBe(0);
  });
});

describe("convert → 8% service fee and easybuy.item.created", () => {
  it("charges 8% of the financed amount and publishes the completed transaction", async () => {
    const applied = await apply(await userToken("person-c"));
    const requestId = applied.body.data.requestId;
    const email = (await RequestModel.findOne({ requestId }).lean())!.email;
    await UserModel.create({ fullName: "Ada Obi", email, role: "User" });
    await request(app).post(`/admin/${requestId}/approve`).send({});

    const res = await request(app).post(`/admin/${requestId}/convert`).send({ phonePrice: 1_200_000, monthlyPlan: 3 });
    expect(res.status).toBe(200);

    const item = await ItemModel.findOne({ sourceRequestId: requestId }).lean();
    expect(item).toMatchObject({
      downPayment: 480_000,
      loanedAmount: 720_000,
      serviceFeeKobo: 5_760_000,
      serviceFeeBps: 800,
      serviceFeeBase: "financed",
      personId: "person-c",
    });

    const event = await outbox().findOne({ type: "easybuy.item.created" });
    expect(event).toMatchObject({
      subject: { kind: "item", id: String(item!._id), personId: "person-c" },
      data: {
        requestId,
        personId: "person-c",
        phonePriceKobo: 120_000_000,
        downPaymentKobo: 48_000_000,
        financedKobo: 72_000_000,
        serviceFeeKobo: 5_760_000,
        serviceFeeBps: 800,
      },
    });
  });
});

describe("GET /internal/people/:personId/journey", () => {
  it("needs the reseller's journey scope", async () => {
    const url = "/api/v1/internal/people/person-d/journey";
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(url).set("authorization", await serviceToken(["easybuy:quote.read"], "store"))).status).toBe(403);
  });

  it("returns the person's requests and items in kobo, without contact details", async () => {
    const applied = await apply(await userToken("person-d"));
    await apply(await userToken("someone-else"));
    const res = await request(app)
      .get("/api/v1/internal/people/person-d/journey")
      .set("authorization", await serviceToken(["easybuy:journey.read"]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ personId: "person-d", unit: "kobo", items: [] });
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0]).toMatchObject({ requestId: applied.body.data.requestId, status: "verified", model: "iPhone 13" });
    expect(JSON.stringify(res.body)).not.toMatch(/example\.com|\+234|Ada/);
  });
});

describe("GET /public/easybuy-requests/mine", () => {
  it("lists only the signed-in person's own applications", async () => {
    await apply(await userToken("person-e"));
    await apply(await userToken("person-f"));
    expect((await request(app).get("/api/v1/public/easybuy-requests/mine")).status).toBe(401);
    const res = await request(app).get("/api/v1/public/easybuy-requests/mine").set("authorization", await userToken("person-e"));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ status: "verified", iphoneModel: "iPhone 13" });
  });
});
