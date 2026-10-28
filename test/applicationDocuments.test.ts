import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTokenSigner, createTokenVerifier, generateSigningKey, requireUserToken } from "@melvingadgets/platform-kit";

// Application documents: a three-month bank statement, the NIN, and a photo holding the NIN.
// Added after submitting, by the signed-in owner or the holder of the request's upload key; all
// three are needed before a SuperAdmin can approve. Storage is replaced by an in-memory fake.
// Runs against the local replica set (setup-env), dropped at the end.

const stored = new Map<string, Buffer>();
vi.mock("../Utils/documentStorage.js", () => ({
  documentStorage: {
    put: async (buffer: Buffer, options: { requestId: string; kind: string; sniffed: { format: string } }) => {
      const publicId = `${options.requestId}/${options.kind}/${stored.size + 1}`;
      stored.set(publicId, buffer);
      return { publicId, resourceType: options.sniffed.format === "pdf" ? "raw" : "image", format: options.sniffed.format, bytes: buffer.length };
    },
    signedLink: (file: { publicId: string }) => `https://signed.example/${file.publicId}?expires=300`,
    remove: async (file: { publicId: string }) => {
      stored.delete(file.publicId);
    },
  },
}));

const ISSUER = "http://auth.test";
const signer = createTokenSigner({ issuer: ISSUER, keys: [generateSigningKey("k1")], activeKid: "k1" });
const SUPERADMIN = "60a000000000000000000009";
const PDF = Buffer.from("%PDF-1.7\n%statement\n");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const EXE = Buffer.from("MZ\x90\x00not-a-document");
let app: express.Application;
let RequestModel: typeof import("../Model/PublicEasyBuyRequestModel.js").default;
let DocumentsModel: typeof import("../Model/ApplicationDocumentsModel.js").default;
let AuditLogModel: typeof import("../Model/AuditLogModel.js").default;
let applicant = 0;

const userToken = async (personId: string) =>
  `Bearer ${(await signer.signUserToken({ personId, role: "User", sessionId: `s-${personId}` })).token}`;

beforeAll(async () => {
  await (await import("../Database/Database.js")).default;
  RequestModel = (await import("../Model/PublicEasyBuyRequestModel.js")).default;
  DocumentsModel = (await import("../Model/ApplicationDocumentsModel.js")).default;
  AuditLogModel = (await import("../Model/AuditLogModel.js")).default;
  await Promise.all([RequestModel.syncIndexes(), DocumentsModel.syncIndexes()]);
  const { initOutbox } = await import("../Utils/messaging.js");
  await initOutbox();

  const verifier = createTokenVerifier({ issuer: ISSUER, jwks: await signer.jwks() });
  const { createPublicRouter } = await import("../Router/PublicRouter.js");
  const admin = await import("../Controller/SuperAdminController.js");
  const documents = await import("../Controller/ApplicationDocumentsController.js");
  const asSuperAdmin: express.RequestHandler = (req, _res, next) => {
    (req as unknown as { user: unknown }).user = { _id: SUPERADMIN, role: "SuperAdmin" };
    (req as unknown as { traceId: string }).traceId = "trace-documents-test";
    next();
  };

  app = express();
  app.use(express.json());
  app.use("/api/v1/public", createPublicRouter(verifier));
  // The real "mine" controller behind the real RS256 guard (verifier already built above), so a
  // claim's effect on the gate is asserted through the endpoint and token type production uses.
  app.get(
    "/mine",
    requireUserToken(verifier) as unknown as express.RequestHandler,
    (await import("../Controller/PublicEasyBuyController.js")).GetMyPublicEasyBuyRequests
  );
  app.post("/admin/:requestId/approve", asSuperAdmin, admin.SuperAdminApprovePublicEasyBuyRequest);
  app.post("/admin/:requestId/reject", asSuperAdmin, admin.SuperAdminRejectPublicEasyBuyRequest);
  app.get("/admin/requests", asSuperAdmin, admin.SuperAdminListPublicEasyBuyRequests);
  app.get("/admin/:requestId/documents", asSuperAdmin, documents.SuperAdminGetApplicationDocuments);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([RequestModel.deleteMany({}), DocumentsModel.deleteMany({}), AuditLogModel.deleteMany({})]);
  stored.clear();
});

const apply = (token?: string) => {
  applicant += 1;
  const call = request(app)
    .post("/api/v1/public/easybuy-requests")
    .set("user-agent", `vitest-docs-${applicant}`)
    .send({
      fullName: "Ada Obi",
      email: `ada.docs${applicant}@example.com`,
      phone: "+2348030000000",
      iphoneModel: "iPhone 13",
      capacity: "128GB",
      plan: "Monthly",
    });
  return token ? call.set("authorization", token) : call;
};

const docsPath = (requestId: string, suffix = "") => `/api/v1/public/easybuy-requests/${requestId}/documents${suffix}`;

const submitAnonymously = async () => {
  const res = await apply();
  expect(res.status).toBe(201);
  return { requestId: res.body.data.requestId as string, key: res.body.data.documentsToken as string };
};

const uploadStatement = (requestId: string, key: string, file: Buffer, confirmed = true) =>
  request(app)
    .post(docsPath(requestId, "/bank-statement"))
    .set("x-documents-token", key)
    .field("downPaymentConfirmed", confirmed ? "true" : "false")
    .attach("file", file, "statement.pdf");

const completeDocuments = async (requestId: string, key: string) => {
  expect((await request(app).put(docsPath(requestId, "/nin")).set("x-documents-token", key).send({ nin: "123 4567 8901" })).status).toBe(200);
  expect((await uploadStatement(requestId, key, PDF)).status).toBe(201);
  expect((await request(app).post(docsPath(requestId, "/nin-selfie")).set("x-documents-token", key).attach("file", JPEG, "me.jpg")).status).toBe(201);
};

describe("pure rules", () => {
  it("accepts only 11-digit NINs and identifies files by their bytes", async () => {
    const lib = await import("../Utils/applicationDocuments.js");
    expect(lib.normalizeNin("123 4567 8901")).toBe("12345678901");
    expect(lib.normalizeNin("1234567890")).toBeNull();
    expect(lib.normalizeNin("1234567890a")).toBeNull();
    expect(lib.sniffFile(PDF)?.mime).toBe("application/pdf");
    expect(lib.sniffFile(JPEG)?.mime).toBe("image/jpeg");
    expect(lib.sniffFile(EXE)).toBeNull();
    expect(lib.isAllowedFile("nin_selfie", lib.sniffFile(PDF))).toBe(false);
  });

  it("takes an 11-digit NIN and nothing else", async () => {
    const lib = await import("../Utils/applicationDocuments.js");
    expect(lib.normalizeNin("12345678901")).toBe("12345678901");
    expect(lib.normalizeNin("1234-5678-901")).toBeNull();
    expect(lib.normalizeNin("")).toBeNull();
    expect(lib.normalizeNin(null)).toBeNull();
  });
});

describe("who can add documents", () => {
  it("returns an upload key once, keeps only its hash, and refuses anyone without it", async () => {
    const { requestId, key } = await submitAnonymously();
    expect(key).toBeTruthy();
    const saved = await RequestModel.findOne({ requestId }).select("+documentsTokenHash").lean();
    expect(saved?.documentsRequired).toBe(true);
    expect(saved?.documentsTokenHash).toBeTruthy();
    expect(saved?.documentsTokenHash).not.toBe(key);

    expect((await request(app).get(docsPath(requestId))).status).toBe(404);
    expect((await request(app).get(docsPath(requestId)).set("x-documents-token", "wrong")).status).toBe(404);
    expect((await request(app).get(docsPath("EBR-NOPE")).set("x-documents-token", key)).status).toBe(404);

    const res = await request(app).get(docsPath(requestId)).set("x-documents-token", key);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ required: true, editable: true, complete: false, missing: ["bank_statement", "nin", "nin_selfie"] });
  });

  it("lets the signed-in owner in without a key, and nobody else", async () => {
    const res = await apply(await userToken("person-owner"));
    const requestId = res.body.data.requestId;
    expect((await request(app).get(docsPath(requestId)).set("authorization", await userToken("person-owner"))).status).toBe(200);
    expect((await request(app).get(docsPath(requestId)).set("authorization", await userToken("person-other"))).status).toBe(404);
  });

  it("refuses an expired key", async () => {
    const { requestId, key } = await submitAnonymously();
    await RequestModel.updateOne({ requestId }, { $set: { documentsTokenExpiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get(docsPath(requestId)).set("x-documents-token", key)).status).toBe(404);
  });
});

describe("the documents", () => {
  it("stores the NIN and shows the applicant only its last four digits", async () => {
    const { requestId, key } = await submitAnonymously();
    expect((await request(app).put(docsPath(requestId, "/nin")).set("x-documents-token", key).send({ nin: "12345" })).status).toBe(400);
    const res = await request(app).put(docsPath(requestId, "/nin")).set("x-documents-token", key).send({ nin: "12345678901" });
    expect(res.status).toBe(200);
    expect(res.body.data.nin).toEqual({ provided: true, last4: "8901" });
    expect(JSON.stringify(res.body)).not.toContain("12345678901");
    // Stored as typed, by the owner's decision of 2026-10-28: no encryption, no key.
    const raw = await DocumentsModel.findOne({ requestId }).select("+nin").lean();
    expect(raw?.nin).toBe("12345678901");
  });

  it("needs the down-payment confirmation, real document bytes, and at most three statement files", async () => {
    const { requestId, key } = await submitAnonymously();
    const unconfirmed = await uploadStatement(requestId, key, PDF, false);
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.code).toBe("down_payment_unconfirmed");
    expect((await uploadStatement(requestId, key, EXE)).status).toBe(415);

    for (let i = 0; i < 3; i += 1) expect((await uploadStatement(requestId, key, PDF)).status).toBe(201);
    const fourth = await uploadStatement(requestId, key, PDF);
    expect(fourth.status).toBe(409);
    expect(fourth.body.code).toBe("too_many_files");
    expect(stored.size).toBe(3); // the refused file was removed from storage

    const summary = (await request(app).get(docsPath(requestId)).set("x-documents-token", key)).body.data;
    expect(summary.bankStatements).toHaveLength(3);
    expect(summary.downPaymentConfirmed).toBe(true);
    const removed = await request(app).delete(docsPath(requestId, `/bank-statement/${summary.bankStatements[0].fileId}`)).set("x-documents-token", key);
    expect(removed.status).toBe(200);
    expect(removed.body.data.bankStatements).toHaveLength(2);
    expect(stored.size).toBe(2);
  });

  it("takes a photo for the NIN selfie, not a PDF, and replaces the previous one", async () => {
    const { requestId, key } = await submitAnonymously();
    expect((await request(app).post(docsPath(requestId, "/nin-selfie")).set("x-documents-token", key).attach("file", PDF, "id.pdf")).status).toBe(415);
    expect((await request(app).post(docsPath(requestId, "/nin-selfie")).set("x-documents-token", key).attach("file", JPEG, "a.jpg")).status).toBe(201);
    expect((await request(app).post(docsPath(requestId, "/nin-selfie")).set("x-documents-token", key).attach("file", JPEG, "b.jpg")).status).toBe(201);
    expect(stored.size).toBe(1);
  });

  it("refuses a file over 4 MB", async () => {
    const { requestId, key } = await submitAnonymously();
    const big = Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024)]);
    const res = await request(app).post(docsPath(requestId, "/nin-selfie")).set("x-documents-token", key).attach("file", big, "big.jpg");
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("file_too_large");
  });
});

describe("approval needs all three documents", () => {
  it("refuses approval until complete, then locks the documents", async () => {
    const { requestId, key } = await submitAnonymously();
    const early = await request(app).post(`/admin/${requestId}/approve`).send({});
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "documents_incomplete", missing: ["bank_statement", "nin", "nin_selfie"] });

    await completeDocuments(requestId, key);
    expect((await request(app).post(`/admin/${requestId}/approve`).send({})).status).toBe(200);
    const locked = await request(app).put(docsPath(requestId, "/nin")).set("x-documents-token", key).send({ nin: "10987654321" });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe("documents_locked");
  });

  it("keeps approving older requests that never needed documents", async () => {
    const { requestId } = await submitAnonymously();
    await RequestModel.updateOne({ requestId }, { $unset: { documentsRequired: 1 } });
    expect((await request(app).post(`/admin/${requestId}/approve`).send({})).status).toBe(200);
  });

  it("shows the review list a documents count, never the NIN or links", async () => {
    const { requestId, key } = await submitAnonymously();
    await request(app).put(docsPath(requestId, "/nin")).set("x-documents-token", key).send({ nin: "12345678901" });
    const list = await request(app).get("/admin/requests");
    const row = list.body.data.find((item: { requestId: string }) => item.requestId === requestId);
    expect(row.documents).toMatchObject({ required: true, count: 1, complete: false });
    expect(JSON.stringify(list.body)).not.toContain("12345678901");
    expect(JSON.stringify(list.body)).not.toContain("documentsTokenHash");
  });
});

// Submitted before signing in, then linked to the account: without this the application never shows
// up in /mine and the merged Apply app can never gate on it.
describe("claiming an anonymous application", () => {
  const claim = (requestId: string, key: string, token: string) =>
    request(app).post(docsPath(requestId, "/claim")).set("x-documents-token", key).set("authorization", token);

  const mine = (token: string) => request(app).get("/mine").set("authorization", token);

  it("links it to the signed-in person, and it then appears in their applications", async () => {
    const { requestId, key } = await submitAnonymously();
    const token = await userToken("person-claimant");
    expect((await mine(token)).body.data).toHaveLength(0);

    const res = await claim(requestId, key, token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ requestId, status: "verified" });

    const listed = (await mine(token)).body.data;
    expect(listed.map((row: { requestId: string }) => row.requestId)).toContain(requestId);
  });

  it("is idempotent for the same person", async () => {
    const { requestId, key } = await submitAnonymously();
    const token = await userToken("person-repeat");
    expect((await claim(requestId, key, token)).status).toBe(200);
    expect((await claim(requestId, key, token)).status).toBe(200);
    expect(await RequestModel.countDocuments({ requestId, personId: "person-repeat" })).toBe(1);
  });

  it("cannot be taken over by someone else", async () => {
    const { requestId, key } = await submitAnonymously();
    expect((await claim(requestId, key, await userToken("person-first"))).status).toBe(200);
    const stolen = await claim(requestId, key, await userToken("person-second"));
    expect(stolen.status).toBe(409);
    expect(stolen.body.code).toBe("already_claimed");
    const saved = await RequestModel.findOne({ requestId }).lean();
    expect(saved?.personId).toBe("person-first");
  });

  it("needs the upload key as well as a token: the key proves who made it", async () => {
    const { requestId, key } = await submitAnonymously();
    const token = await userToken("person-nokey");
    expect((await request(app).post(docsPath(requestId, "/claim")).set("authorization", token)).status).toBe(404);
    expect((await request(app).post(docsPath(requestId, "/claim")).set("x-documents-token", key)).status).toBe(401);
    expect((await claim(requestId, "wrong-key", token)).status).toBe(404);
    const saved = await RequestModel.findOne({ requestId }).lean();
    expect(saved?.personId).toBeUndefined();
  });

  it("refuses an expired key", async () => {
    const { requestId, key } = await submitAnonymously();
    await RequestModel.updateOne({ requestId }, { $set: { documentsTokenExpiresAt: new Date(Date.now() - 1000) } });
    expect((await claim(requestId, key, await userToken("person-late"))).status).toBe(404);
  });

  it("reports the application's status to the applicant, but never the full NIN", async () => {
    const { requestId, key } = await submitAnonymously();
    await request(app).put(docsPath(requestId, "/nin")).set("x-documents-token", key).send({ nin: "12345678901" });
    const res = await request(app).get(docsPath(requestId)).set("x-documents-token", key);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("verified");
    expect(JSON.stringify(res.body)).not.toContain("12345678901");
  });
});

describe("SuperAdmin review", () => {
  it("shows the full NIN and short-lived links, and records the view", async () => {
    const { requestId, key } = await submitAnonymously();
    await completeDocuments(requestId, key);
    const res = await request(app).get(`/admin/${requestId}/documents`);
    expect(res.status).toBe(200);
    expect(res.body.data.nin).toEqual({ provided: true, value: "12345678901" });
    expect(res.body.data.bankStatements[0].url).toMatch(/^https:\/\/signed\.example\//);
    expect(res.body.data.ninSelfie.url).toMatch(/^https:\/\/signed\.example\//);
    expect(res.body.data.complete).toBe(true);
    expect(await AuditLogModel.countDocuments({ action: "PUBLIC_REQUEST_DOCUMENTS_VIEW" })).toBe(1);
  });
});
