import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requirePermission } from "@melvingadgets/platform-kit";
import UserModel from "../Model/UserModel.js";
import { verifyToken } from "../Middleware/verify.js";
import { CreateUser, GetAllUsers } from "../Controller/UserController.js";
import { config } from "../config/Config.js";

// The EasyBuy half of the RBAC rollout (docs/rbac-unification.md, Phase 3).
//
// The bug this suite exists for: `requireRole(["Admin"])` compared a *list* of role strings,
// so a SuperAdmin — who outranks an Admin — got a 403 on createuser, getallusers, the
// catalog and item creation. The in-handler `checkrole !== "Admin"` compares reproduced it
// a second time, so fixing the routes alone would not have fixed the lockout.
//
// The second rule: nothing falls back. A token with no role, a lowercase role, or an
// unknown role is refused rather than treated as an ordinary `User`.
//
// Runs against the throwaway database from setup-env and drops it afterwards.

type Fixture = { _id: string; token: string };

const app = express();
app.use(express.json());
app.post("/createuser", verifyToken, requirePermission("easybuy.users.create"), CreateUser);
app.get("/getallusers", verifyToken, requirePermission("easybuy.users.read"), GetAllUsers);
app.get("/receipts/pending", verifyToken, requirePermission("easybuy.receipts.approve"), (_req, res) => {
  res.status(200).json({ ok: true });
});
app.get("/superadmin/overview", verifyToken, requirePermission("easybuy.superadmin.access"), (_req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * A legacy (HS256) EasyBuy token, shaped like the ones this service still issues. `role` is
 * deliberately `unknown` so a test can put a value the type system would refuse into a token
 * a real attacker could also mint — the point is that `verifyToken` rejects it.
 */
const legacyToken = (userId: string, role?: unknown): string => {
  const payload: Record<string, unknown> = { _id: userId, email: "someone@example.test" };
  if (role !== undefined) payload.role = role;
  return jwt.sign(payload, config.auth.jwtSecret, { expiresIn: "10m" });
};

const makeUser = async (role: "User" | "Admin" | "SuperAdmin"): Promise<Fixture> => {
  const user = await UserModel.create({
    fullName: `Test ${role}`,
    email: `rbac.${role.toLowerCase()}.${new mongoose.Types.ObjectId()}@example.test`,
    password: "not-used-in-this-test",
    role,
  });
  return { _id: String(user._id), token: legacyToken(String(user._id), role) };
};

beforeAll(async () => {
  await (await import("../Database/Database.js")).default;
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe("route guards never lock a SuperAdmin out", () => {
  it("lets a SuperAdmin through every Admin-or-lower route", async () => {
    const superAdmin = await makeUser("SuperAdmin");
    const auth = { authorization: `Bearer ${superAdmin.token}` };

    expect((await request(app).get("/getallusers").set(auth)).status).toBe(200);
    expect((await request(app).get("/receipts/pending").set(auth)).status).toBe(200);
    expect((await request(app).get("/superadmin/overview").set(auth)).status).toBe(200);
  });

  it("lets an Admin through the Admin routes but not the SuperAdmin ones", async () => {
    const admin = await makeUser("Admin");
    const auth = { authorization: `Bearer ${admin.token}` };

    expect((await request(app).get("/getallusers").set(auth)).status).toBe(200);
    expect((await request(app).get("/superadmin/overview").set(auth)).status).toBe(403);
  });

  it("refuses an ordinary user with 403, not a redirect to login", async () => {
    const user = await makeUser("User");
    const auth = { authorization: `Bearer ${user.token}` };

    expect((await request(app).get("/getallusers").set(auth)).status).toBe(403);
    expect((await request(app).get("/receipts/pending").set(auth)).status).toBe(403);
    expect((await request(app).get("/superadmin/overview").set(auth)).status).toBe(403);
  });
});

describe("the in-handler role compares match the route guards", () => {
  it("creates a user for a SuperAdmin instead of 403ing them out of their own service", async () => {
    const superAdmin = await makeUser("SuperAdmin");
    const res = await request(app)
      .post("/createuser")
      .set("authorization", `Bearer ${superAdmin.token}`)
      .send({ fullName: "New Person", email: `created.${new mongoose.Types.ObjectId()}@example.test`, Password: "CorrectHorse9" });

    expect(res.status).not.toBe(403);
    expect([200, 201]).toContain(res.status);
  });

  it("creates a user for an Admin", async () => {
    const admin = await makeUser("Admin");
    const res = await request(app)
      .post("/createuser")
      .set("authorization", `Bearer ${admin.token}`)
      .send({ fullName: "New Person", email: `created.${new mongoose.Types.ObjectId()}@example.test`, Password: "CorrectHorse9" });

    expect(res.status).not.toBe(403);
    expect([200, 201]).toContain(res.status);
  });

  it("still refuses an ordinary user at the handler, even if a future route forgets its guard", async () => {
    const user = await makeUser("User");
    const res = await request(app)
      .post("/createuser")
      .set("authorization", `Bearer ${user.token}`)
      .send({ fullName: "New Person", email: "should-not-exist@example.test", Password: "CorrectHorse9" });

    expect(res.status).toBe(403);
    expect(await UserModel.findOne({ email: "should-not-exist@example.test" }).lean()).toBeNull();
  });
});

describe("fail closed: a stored role this service cannot read is a 401, never a silent User", () => {
  // The legacy dialect reads the role from the user row, not the claim (see the escalation
  // suite below), so the only way to reach this check is a row whose role is bad. The raw
  // driver writes it because the schema's enum would refuse it — this is the shape a
  // half-finished migration or a hand-edit leaves behind.
  const insertRaw = async (role: unknown) => {
    const _id = new mongoose.Types.ObjectId();
    const email = `raw.${_id}@example.test`;
    await UserModel.collection.insertOne({ _id, fullName: "Raw Row", email, password: null, role });
    return { _id: String(_id), token: legacyToken(String(_id), undefined) };
  };

  it.each([
    ["a lowercase role", "admin"],
    ["a mixed-case role", "SuperAdmin "],
    ["an unknown role", "owner"],
    ["a role that is not a string", 1],
    ["no role field at all", undefined],
  ])("refuses a row holding %s", async (_label, role) => {
    const { token } = await insertRaw(role);
    expect((await request(app).get("/getallusers").set("authorization", `Bearer ${token}`)).status).toBe(401);
  });

  it("refuses a request with no token at all", async () => {
    expect((await request(app).get("/getallusers")).status).toBe(401);
  });

  it("refuses a token signed with the wrong secret", async () => {
    const user = await makeUser("SuperAdmin");
    const forged = jwt.sign({ _id: user._id, role: "SuperAdmin" }, "not-the-secret", { expiresIn: "10m" });
    expect((await request(app).get("/superadmin/overview").set("authorization", `Bearer ${forged}`)).status).toBe(401);
  });
});

describe("an Admin cannot escalate by minting a token", () => {
  it("ignores a role claim that disagrees with the stored row", async () => {
    const admin = await makeUser("Admin");
    // A junk claim on an otherwise valid legacy token is ignored rather than fatal: the
    // stored row is the source of truth here, so the request proceeds as that Admin.
    const junk = legacyToken(admin._id, "not-a-role");
    expect((await request(app).get("/getallusers").set("authorization", `Bearer ${junk}`)).status).toBe(200);
  });

  it("uses the stored role, not the one inside the token", async () => {
    const admin = await makeUser("Admin");
    // An Admin who signs their own token claiming SuperAdmin still only *is* an Admin: the
    // legacy path reads the role from the user row, never from the claim it was handed.
    const escalated = legacyToken(admin._id, "SuperAdmin");
    expect((await request(app).get("/superadmin/overview").set("authorization", `Bearer ${escalated}`)).status).toBe(403);
  });
});
