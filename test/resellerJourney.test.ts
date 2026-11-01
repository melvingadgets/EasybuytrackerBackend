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
  const { CreateEasyBoughtItem } = await import("../Controller/UserController.js");
  const asSuperAdmin: express.RequestHandler = (req, _res, next) => {
    (req as unknown as { user: unknown }).user = { _id: SUPERADMIN, role: "SuperAdmin", email: "superadmin@example.test" };
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
  app.post("/admin/items", asSuperAdmin, CreateEasyBoughtItem);
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

// New requests need their three documents before they can be approved (ApplicationDocumentsController).
const withDocuments = async (requestId: string) => {
  const Documents = (await import("../Model/ApplicationDocumentsModel.js")).default;
  const file = { fileId: `f-${requestId}`, publicId: `p-${requestId}`, resourceType: "image", format: "jpg", mime: "image/jpeg", bytes: 1, uploadedAt: new Date() };
  await Documents.create({ requestId, ninLast4: "1234", bankStatements: [file], ninSelfie: file });
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
    await withDocuments(first.body.data.requestId);
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
    // Linked to its person, as Middleware/verify.ts links it on the applicant's first verified request
    // (matched on the auth-verified email). An unlinked account is refused — see the F-1 tests below.
    await UserModel.create({ fullName: "Ada Obi", email, role: "User", personId: "person-c" });
    await withDocuments(requestId);
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

  // F-1 (docs/BUG-AUDIT-2026-10-31b.md): an item must never carry a personId that disagrees with the
  // account it is attributed to. A refusal writes nothing — no item, no item.created event — and the
  // request stays approved, so it can still be converted once the accounts are put right.
  const expectNothingWritten = async (requestId: string) => {
    expect(await ItemModel.countDocuments({ sourceRequestId: requestId })).toBe(0);
    expect(await outbox().countDocuments({ type: "easybuy.item.created" })).toBe(0);
    expect((await RequestModel.findOne({ requestId }).lean())?.status).toBe("approved");
  };

  it("refuses with 409 person_mismatch when userEmail points at someone else's account", async () => {
    const applied = await apply(await userToken("person-g"));
    const requestId = applied.body.data.requestId;
    // The admin types another customer's email: a real account, linked to a different person.
    await UserModel.create({ fullName: "Somebody Else", email: "someone-else@example.com", role: "User", personId: "person-h" });
    await withDocuments(requestId);
    await request(app).post(`/admin/${requestId}/approve`).send({});

    const res = await request(app)
      .post(`/admin/${requestId}/convert`)
      .send({ phonePrice: 1_200_000, monthlyPlan: 3, userEmail: "someone-else@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("person_mismatch");
    await expectNothingWritten(requestId);
  });

  it("refuses with 409 person_mismatch when the account matching the typed email is linked to nobody", async () => {
    const applied = await apply(await userToken("person-i"));
    const requestId = applied.body.data.requestId;
    const email = (await RequestModel.findOne({ requestId }).lean())!.email;
    // The email was typed on the Apply form, so it proves nothing about who owns this account
    // (AGENTS.md §1.4). The old code stamped person-i onto it.
    await UserModel.create({ fullName: "Ada Obi", email, role: "User" });
    await withDocuments(requestId);
    await request(app).post(`/admin/${requestId}/approve`).send({});

    const res = await request(app).post(`/admin/${requestId}/convert`).send({ phonePrice: 1_200_000, monthlyPlan: 3 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("person_mismatch");
    await expectNothingWritten(requestId);
  });

  it("still converts an anonymous application into the account its email resolves to", async () => {
    const applied = await apply(); // no token: the request carries no person
    const requestId = applied.body.data.requestId;
    const email = (await RequestModel.findOne({ requestId }).lean())!.email;
    await UserModel.create({ fullName: "Ada Obi", email, role: "User", personId: "person-j" });
    await withDocuments(requestId);
    await request(app).post(`/admin/${requestId}/approve`).send({});

    const res = await request(app).post(`/admin/${requestId}/convert`).send({ phonePrice: 1_200_000, monthlyPlan: 3 });
    expect(res.status).toBe(200);
    expect((await ItemModel.findOne({ sourceRequestId: requestId }).lean())?.personId).toBe("person-j");
  });

  it("converts into an older shadow account — _id is the person, no personId field yet", async () => {
    // What Service/AuthService.ts syncLocalShadowUser made before it stamped the field, and still the
    // shape in production until migrate-shadow-person-ids runs. The first version of the F-1 fix
    // refused it; the e2e conversion flow caught that.
    const person = new mongoose.Types.ObjectId().toString();
    const applied = await apply(await userToken(person));
    const requestId = applied.body.data.requestId;
    const email = (await RequestModel.findOne({ requestId }).lean())!.email;
    await UserModel.create({ _id: new mongoose.Types.ObjectId(person), fullName: "Ada Obi", email, role: "User" });
    await withDocuments(requestId);
    await request(app).post(`/admin/${requestId}/approve`).send({});

    const res = await request(app).post(`/admin/${requestId}/convert`).send({ phonePrice: 1_200_000, monthlyPlan: 3 });
    expect(res.status).toBe(200);
    expect((await ItemModel.findOne({ sourceRequestId: requestId }).lean())?.personId).toBe(person);
    expect((await outbox().findOne({ type: "easybuy.item.created" }))?.data?.personId).toBe(person);
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

  // E-2: a shadow customer's items that carry no personId of their own can only be found through the
  // account. Looking the account up by `personId` alone missed all of them.
  describe("a shadow customer's items", () => {
    const shadowPerson = (email: string) => ({ _id: new mongoose.Types.ObjectId().toString(), email, fullName: "Shadow Customer", role: "User" });
    // An item an admin created before accounts carried the person: it names only its account.
    const itemWithoutPerson = (accountId: string, email: string) =>
      ItemModel.create({
        provider: "aurapay",
        IphoneModel: "iPhone 13",
        IphoneImageUrl: "https://example.test/x.png",
        capacity: "128GB",
        Plan: "Monthly",
        monthlyPlan: 3,
        downPayment: 480_000,
        loanedAmount: 720_000,
        PhonePrice: 1_200_000,
        UserId: new mongoose.Types.ObjectId(accountId),
        UserEmail: email,
      });
    const journeyItems = async (personId: string) => {
      const res = await request(app)
        .get(`/api/v1/internal/people/${personId}/journey`)
        .set("authorization", await serviceToken(["easybuy:journey.read"]));
      expect(res.status).toBe(200);
      return res.body.items.map((item: { itemId: string }) => item.itemId);
    };

    it("finds a shadow customer's admin-created item through the stamped account, and shows it to nobody else", async () => {
      const { syncLocalShadowUser } = await import("../Service/AuthService.js");
      const person = shadowPerson("shadow-stamped@example.test");
      await syncLocalShadowUser(person);
      const item = await itemWithoutPerson(person._id, person.email);
      expect(item.personId).toBeUndefined();

      expect(await journeyItems(person._id)).toEqual([String(item._id)]);
      expect(await journeyItems(new mongoose.Types.ObjectId().toString())).toEqual([]);
    });

    it("finds it before the backfill has reached the shadow, by the account's _id", async () => {
      const person = shadowPerson("shadow-older@example.test");
      await UserModel.create({ _id: new mongoose.Types.ObjectId(person._id), fullName: person.fullName, email: person.email });
      const item = await itemWithoutPerson(person._id, person.email);

      expect(await journeyItems(person._id)).toEqual([String(item._id)]);
    });

    it("trusts the field over the _id once an account names someone else", async () => {
      const person = shadowPerson("shadow-relinked@example.test");
      const other = new mongoose.Types.ObjectId().toString();
      await UserModel.create({ _id: new mongoose.Types.ObjectId(person._id), fullName: person.fullName, email: person.email, personId: other });
      const item = await itemWithoutPerson(person._id, person.email);

      expect(await journeyItems(other)).toEqual([String(item._id)]);
      expect(await journeyItems(person._id)).toEqual([]);
    });

    it("shows both accounts' items when a linked account and an older shadow are one person", async () => {
      const person = shadowPerson("shadow-duplicate@example.test");
      await UserModel.create({ _id: new mongoose.Types.ObjectId(person._id), fullName: person.fullName, email: person.email });
      const holder = await UserModel.create({ fullName: "Linked", email: "linked-duplicate@example.test", personId: person._id });
      const shadowItem = await itemWithoutPerson(person._id, person.email);
      const holderItem = await itemWithoutPerson(String(holder._id), "linked-duplicate@example.test");

      expect((await journeyItems(person._id)).sort()).toEqual([String(shadowItem._id), String(holderItem._id)].sort());
    });

    it("an admin creating an item for a shadow customer now stamps the person on the item and its event", async () => {
      const { syncLocalShadowUser } = await import("../Service/AuthService.js");
      const person = shadowPerson("shadow-admin@example.test");
      await syncLocalShadowUser(person);

      const res = await request(app).post("/admin/items").send({
        provider: "aurapay",
        IphoneModel: "iPhone 13",
        capacity: "128GB",
        Plan: "Monthly",
        monthlyPlan: 3,
        PhonePrice: 1_200_000,
        UserEmail: person.email,
      });
      expect(res.status).toBe(200);

      const item = await ItemModel.findOne({ UserEmail: person.email }).lean();
      expect(item?.personId).toBe(person._id);
      expect(item?.UserId?.toString()).toBe(person._id);
      expect(await outbox().findOne({ type: "easybuy.item.created" })).toMatchObject({
        subject: { kind: "item", id: String(item!._id), personId: person._id },
        data: { personId: person._id },
      });
      expect(await journeyItems(person._id)).toEqual([String(item!._id)]);
    });
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
