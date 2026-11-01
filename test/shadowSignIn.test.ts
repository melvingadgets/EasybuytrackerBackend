import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTokenSigner, generateSigningKey } from "@melvingadgets/platform-kit";
import UserModel from "../Model/UserModel.js";

// E-2 through the only live way into syncLocalShadowUser: a person's first request with a verified
// platform token (Middleware/verify.ts). Real RS256 tokens and the real verifier, which fetches its
// keys from a stand-in for auth that also answers /me. Nothing that imports Config may be imported
// statically here: the verifier is built from AUTH_ISSUER at import time. Runs against the local
// replica set (setup-env), dropped at the end.

type Person = { _id: string; email: string; fullName: string; role: string };

let server: Server;
let app: express.Application;
let signer: ReturnType<typeof createTokenSigner>;
let meCalls = 0;
const peopleByToken = new Map<string, Person>();

let sequence = 0;
const newPerson = (): Person => {
  sequence += 1;
  return { _id: new mongoose.Types.ObjectId().toString(), email: `signin${sequence}@example.test`, fullName: "Signing In", role: "User" };
};

const tokenFor = async (person: Person) => {
  const { token } = await signer.signUserToken({ personId: person._id, role: "User", sessionId: `s-${person._id}` });
  peopleByToken.set(token, person);
  return token;
};
const whoami = (token: string) => request(app).get("/whoami").set("authorization", `Bearer ${token}`);
const stored = (id: string) => UserModel.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/.well-known/jwks.json") return send(200, await signer.jwks());
    if (req.url === "/api/v1/auth/me") {
      meCalls += 1;
      const person = peopleByToken.get(String(req.headers.authorization).replace(/^Bearer /, ""));
      return person ? send(200, { data: { user: person, profile: null } }) : send(401, { message: "unauthorized" });
    }
    return send(404, { message: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  signer = createTokenSigner({ issuer, keys: [generateSigningKey("k1")], activeKid: "k1" });

  process.env.AUTH_ISSUER = issuer;
  process.env.AUTH_SERVICE_URL = issuer;
  delete process.env.AUTH_JWKS_URL;
  await (await import("../Database/Database.js")).default;
  await UserModel.syncIndexes();

  const { verifyToken } = await import("../Middleware/verify.js");
  app = express();
  app.get("/whoami", verifyToken, (req, res) => {
    res.json({ accountId: req.user?._id });
  });
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(async () => {
  await UserModel.deleteMany({});
  peopleByToken.clear();
  meCalls = 0;
});

describe("a person's first verified sign-in", () => {
  it("creates a shadow account carrying their person", async () => {
    const person = newPerson();

    const res = await whoami(await tokenFor(person));

    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe(person._id);
    expect(await stored(person._id)).toMatchObject({ personId: person._id, email: person.email });
  });

  it("leaves one account, carrying the person, when several first requests arrive together", async () => {
    const person = newPerson();
    const token = await tokenFor(person);

    const responses = await Promise.all(Array.from({ length: 6 }, () => whoami(token)));

    expect(responses.map((res) => res.status)).toEqual(Array(6).fill(200));
    expect(await UserModel.countDocuments({})).toBe(1);
    expect((await stored(person._id))?.personId).toBe(person._id);
  });

  it("uses the older account already linked to them, and makes no shadow, even under another email", async () => {
    const person = newPerson();
    const holder = await UserModel.create({ fullName: "Linked", email: "linked-elsewhere@example.test", personId: person._id });

    const res = await whoami(await tokenFor(person));

    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe(String(holder._id));
    expect(await stored(person._id)).toBeNull();
    expect(await UserModel.countDocuments({ personId: person._id })).toBe(1);
  });

  it("still links an unlinked older account by the auth-verified email, and makes no shadow", async () => {
    const person = newPerson();
    const older = await UserModel.create({ fullName: "Older", email: person.email });

    const res = await whoami(await tokenFor(person));

    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe(String(older._id));
    expect((await stored(String(older._id)))?.personId).toBe(person._id);
    expect(await stored(person._id)).toBeNull();
  });

  it("recognises an older shadow by its _id, so it never reaches the sync: stamping those is the backfill's job", async () => {
    const person = newPerson();
    await UserModel.create({ _id: new mongoose.Types.ObjectId(person._id), fullName: "Older Shadow", email: person.email });

    const res = await whoami(await tokenFor(person));

    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe(person._id);
    expect(meCalls).toBe(0);
    expect((await stored(person._id))?.personId).toBeUndefined();
  });

  it("creates nothing for a token auth didn't sign", async () => {
    const person = newPerson();
    const forger = createTokenSigner({ issuer: "http://auth.forged.test", keys: [generateSigningKey("k1")], activeKid: "k1" });
    const { token } = await forger.signUserToken({ personId: person._id, role: "User", sessionId: "forged" });
    peopleByToken.set(token, person);

    const res = await whoami(token);

    expect(res.status).toBe(401);
    expect(await UserModel.countDocuments({})).toBe(0);
  });
});
