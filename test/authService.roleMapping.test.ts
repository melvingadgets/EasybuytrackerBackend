import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import UserModel from "../Model/UserModel.js";
import { parsePlatformRole, syncLocalShadowUser, type AuthServiceUser } from "../Service/AuthService.js";

// Auth returns the platform roles (`User | Admin | SuperAdmin`); older deployments answer in
// lowercase. Both spellings resolve to the canonical one, so neither casing can demote a platform
// admin to a customer in EasyBuy — and with the Apply approval gate (which staff bypass) that
// would strand them on the customer screen.
//
// Nothing unrecognised is coerced. `toLegacyRole` used to fall back to `"User"`, which made a
// malformed role look like a working account; `parsePlatformRole` throws instead, so the request
// fails loudly and an operator sees it (docs/rbac-unification.md, "fail closed").
// Runs against the local replica set (setup-env), dropped at the end.

beforeAll(async () => {
  await (await import("../Database/Database.js")).default;
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

afterEach(async () => {
  await UserModel.deleteMany({});
});

const authUser = (role: string): AuthServiceUser => ({
  _id: new mongoose.Types.ObjectId().toString(),
  email: `someone.${role.toLowerCase()}@example.test`,
  fullName: "Someone",
  role,
});

describe("parsePlatformRole", () => {
  it.each([
    ["Admin", "Admin"],
    ["admin", "Admin"],
    ["SuperAdmin", "SuperAdmin"],
    ["superadmin", "SuperAdmin"],
    ["User", "User"],
    ["user", "User"],
    ["  Admin  ", "Admin"],
  ])("resolves %s to %s", (input, expected) => {
    expect(parsePlatformRole(input)).toBe(expected);
  });

  it("refuses an unknown or missing role instead of calling it a customer", () => {
    for (const value of ["", "  ", "root", "owner", "salesperson", null, undefined, 1, {}]) {
      expect(() => parsePlatformRole(value)).toThrow(/unknown role from auth/);
    }
  });
});

describe("syncLocalShadowUser role", () => {
  it("keeps a platform admin an admin, whatever the casing auth used", async () => {
    for (const [casing, expected] of [
      ["Admin", "Admin"],
      ["admin", "Admin"],
      ["SuperAdmin", "SuperAdmin"],
      ["superadmin", "SuperAdmin"],
    ] as const) {
      const user = authUser(casing);
      // Unique per case: "Admin" and "admin" would otherwise share an address.
      user.email = `staff.${user._id}@example.test`;
      const shadow = await syncLocalShadowUser(user);
      expect(shadow?.role).toBe(expected);

      const stored = await UserModel.findById(user._id).lean();
      expect(stored?.role).toBe(expected);
    }
  });

  it("keeps an ordinary person a customer", async () => {
    const user = authUser("User");
    expect((await syncLocalShadowUser(user))?.role).toBe("User");
    expect((await UserModel.findById(user._id).lean())?.role).toBe("User");
  });

  it("promotes an existing customer when auth promotes them, and demotes them back", async () => {
    const user = authUser("User");
    await syncLocalShadowUser(user);

    await syncLocalShadowUser({ ...user, role: "Admin" });
    expect((await UserModel.findById(user._id).lean())?.role).toBe("Admin");

    await syncLocalShadowUser({ ...user, role: "User" });
    expect((await UserModel.findById(user._id).lean())?.role).toBe("User");
  });
});
