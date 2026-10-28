import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import UserModel from "../Model/UserModel.js";
import { syncLocalShadowUser, toLegacyRole, type AuthServiceUser } from "../Service/AuthService.js";

// Auth returns the platform roles (`User | Admin | SuperAdmin`), while this service's older code
// and its `AuthServiceRole` type name them in lowercase. A mismatch is not loud: the shadow user is
// simply written as `User`, so a platform admin silently loses their staff rights in EasyBuy — and
// with the Apply approval gate (which staff bypass) that would strand them on the customer screen.
// Both spellings are accepted; anything unrecognised falls back to `User`, never to a staff role.
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

describe("toLegacyRole", () => {
  it.each([
    ["Admin", "Admin"],
    ["admin", "Admin"],
    ["SuperAdmin", "SuperAdmin"],
    ["superadmin", "SuperAdmin"],
    ["User", "User"],
    ["user", "User"],
  ])("maps %s to %s", (input, expected) => {
    expect(toLegacyRole(input)).toBe(expected);
  });

  it("never promotes an unknown or missing role to staff", () => {
    for (const value of ["", "  ", "root", "owner", null, undefined]) {
      expect(toLegacyRole(value)).toBe("User");
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
