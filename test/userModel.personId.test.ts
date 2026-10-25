import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import UserModel from "../Model/UserModel.js";

// The personId index must let any number of accounts exist without a personId (every account
// today) and still allow only one account per person. Runs the real schema against a throwaway
// database on the local MongoDB (a standalone server is enough), dropped at the end.

const base = process.env.MONGO_TEST_URL ?? "mongodb://127.0.0.1:27017";
let conn: mongoose.Connection;
let Users: mongoose.Model<any>;

beforeAll(async () => {
  conn = await mongoose.createConnection(`${base}/easybuy_personid_${randomUUID().slice(0, 8)}`).asPromise();
  Users = conn.model("user", UserModel.schema);
  await Users.init();
});

afterAll(async () => {
  await conn.dropDatabase();
  await conn.close();
});

const duplicateKey = (error: unknown) => (error as { code?: number }).code === 11000;

describe("personId index", () => {
  it("is a unique partial index on string values, not a sparse one", async () => {
    const index = (await Users.collection.indexes()).find((entry) => entry.key && "personId" in entry.key);
    expect(index).toBeDefined();
    expect(index).toMatchObject({ unique: true, partialFilterExpression: { personId: { $type: "string" } } });
    expect(index?.sparse).toBeUndefined();
  });

  it("lets any number of accounts exist without a personId", async () => {
    for (const n of [1, 2, 3]) {
      await Users.create({ fullName: `New ${n}`, email: `new${n}@example.test` });
    }
    expect(await Users.countDocuments({ email: /^new\d@/ })).toBe(3);
  });

  it("does not store a null personId, so nothing collides on it", async () => {
    const raw = await Users.collection.findOne({ email: "new1@example.test" });
    expect(raw).not.toBeNull();
    expect("personId" in (raw as object)).toBe(false);
  });

  it("lets the shadow-user upsert create several accounts (setDefaultsOnInsert)", async () => {
    for (const n of [1, 2]) {
      await Users.findOneAndUpdate(
        { _id: new mongoose.Types.ObjectId() },
        { $set: { fullName: `Shadow ${n}`, email: `shadow${n}@example.test` } },
        { upsert: true, setDefaultsOnInsert: true },
      );
    }
    expect(await Users.countDocuments({ email: /^shadow\d@/ })).toBe(2);
  });

  it("still allows only one account per person", async () => {
    await Users.create({ fullName: "Linked", email: "linked@example.test", personId: "person-1" });
    const second = await Users.create({ fullName: "Other", email: "other@example.test" });
    await expect(Users.updateOne({ _id: second._id }, { $set: { personId: "person-1" } })).rejects.toSatisfy(duplicateKey);
  });

  it("builds over rows that predate the field", async () => {
    await conn.collection("legacy_users").insertMany([
      { fullName: "Legacy 1", email: "legacy1@example.test" },
      { fullName: "Legacy 2", email: "legacy2@example.test" },
    ]);
    const Legacy = conn.model("legacy", UserModel.schema, "legacy_users");
    await Legacy.init();
    expect((await Legacy.collection.indexes()).some((entry) => entry.key && "personId" in entry.key)).toBe(true);
    await Legacy.create({ fullName: "After", email: "after@example.test" });
    expect(await Legacy.countDocuments()).toBe(3);
  });
});
