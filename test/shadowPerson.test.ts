import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import UserModel from "../Model/UserModel.js";
import { syncLocalShadowUser, type AuthServiceUser } from "../Service/AuthService.js";
import { isLocalDatabase } from "../Utils/localDatabase.js";
import { backfillShadowPersonIds, isDuplicateKeyError, stampPersonId } from "../Utils/shadowPerson.js";

// E-2: a shadow account's `_id` is its auth person, but everything downstream reads the `personId`
// field, so a shadow without it looks unlinked. A shadow now carries the field, the backfill reaches
// the existing ones, and in both cases the unique index is what stops two accounts claiming one person
// (AGENTS.md §3.8). Runs against the local replica set (setup-env), dropped at the end.

beforeAll(async () => {
  await (await import("../Database/Database.js")).default;
  await UserModel.syncIndexes();
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

afterEach(async () => {
  await UserModel.deleteMany({});
});

const newId = () => new mongoose.Types.ObjectId().toString();
const objectId = (id: string) => new mongoose.Types.ObjectId(id);

let sequence = 0;
const nextEmail = () => `account${(sequence += 1)}@example.test`;

const authPerson = (overrides: Partial<AuthServiceUser> = {}): AuthServiceUser => ({
  _id: newId(),
  email: nextEmail(),
  fullName: "Someone",
  role: "User",
  ...overrides,
});

/** A shadow as syncLocalShadowUser made it before it stamped the field: `_id` only. */
const olderShadow = async (personId = newId()) => {
  await UserModel.create({ _id: objectId(personId), fullName: "Older Shadow", email: nextEmail() });
  return personId;
};

/** An older EasyBuy account with its own `_id`, linked to a person or not. */
const olderAccount = async (personId?: string, email = nextEmail()) => {
  const account = await UserModel.create({ fullName: "Older Account", email, ...(personId ? { personId } : {}) });
  return String(account._id);
};

const stored = (id: string) => UserModel.collection.findOne({ _id: objectId(id) });
const holders = (personId: string) => UserModel.countDocuments({ personId });

describe("syncLocalShadowUser stamps the person", () => {
  it("gives a new shadow its person, as a string the unique index covers", async () => {
    const person = authPerson();
    const shadow = await syncLocalShadowUser(person);

    expect(shadow?._id).toBe(person._id);
    expect((await stored(person._id))?.personId).toBe(person._id);
  });

  it("stamps an older shadow the next time it syncs, and still updates it", async () => {
    const personId = await olderShadow();
    expect((await stored(personId))?.personId).toBeUndefined();

    await syncLocalShadowUser(authPerson({ _id: personId, fullName: "Renamed" }));

    expect(await stored(personId)).toMatchObject({ personId, fullName: "Renamed" });
  });

  it("leaves one account however often, and however concurrently, a person syncs", async () => {
    const person = authPerson();
    const shadows = await Promise.all(Array.from({ length: 8 }, () => syncLocalShadowUser(person)));
    await syncLocalShadowUser(person);

    expect(new Set(shadows.map((shadow) => shadow?._id))).toEqual(new Set([person._id]));
    expect(await UserModel.countDocuments({})).toBe(1);
    expect(await holders(person._id)).toBe(1);
  });

  it("never overwrites a person the account already holds", async () => {
    // Middleware/verify.ts links an account by its auth-verified email, so a person who deleted their
    // auth account and registered again gets their old shadow back under their new personId.
    const other = newId();
    const personId = newId();
    await UserModel.create({ _id: objectId(personId), fullName: "Relinked", email: nextEmail(), personId: other });

    await syncLocalShadowUser(authPerson({ _id: personId }));

    expect((await stored(personId))?.personId).toBe(other);
  });
});

describe("one person, one account", () => {
  it("a shadow can't take a personId a linked older account holds: no second account, the holder comes back", async () => {
    const person = authPerson();
    const holderId = await olderAccount(person._id);

    const result = await syncLocalShadowUser(person);

    expect(result?._id).toBe(holderId);
    expect(await stored(person._id)).toBeNull();
    expect(await UserModel.countDocuments({})).toBe(1);
    expect(await holders(person._id)).toBe(1);
  });

  it("does the same when the holder also has the person's email, so both unique indexes object", async () => {
    const person = authPerson();
    const holderId = await olderAccount(person._id, person.email);

    expect((await syncLocalShadowUser(person))?._id).toBe(holderId);
    expect(await UserModel.countDocuments({})).toBe(1);
  });

  it("an existing shadow can't take it either: it stays unstamped, and the holder keeps the person", async () => {
    const personId = await olderShadow();
    const holderId = await olderAccount(personId);

    const result = await syncLocalShadowUser(authPerson({ _id: personId }));

    expect(result?._id).toBe(holderId);
    expect((await stored(personId))?.personId).toBeUndefined();
    expect((await stored(holderId))?.personId).toBe(personId);
    expect(await holders(personId)).toBe(1);
  });

  it("lets exactly one of several racing accounts claim a person: the index decides, not a read", async () => {
    const personId = newId();
    const accounts = await Promise.all(Array.from({ length: 6 }, () => olderAccount()));

    const results = await Promise.allSettled(accounts.map((account) => stampPersonId(account, personId)));

    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(results.filter((result) => result.status === "fulfilled" && result.value === true)).toHaveLength(1);
    expect(refused).toHaveLength(5);
    expect(refused.every((result) => isDuplicateKeyError(result.reason))).toBe(true);
    expect(await holders(personId)).toBe(1);
  });

  it("doesn't link by email: an unlinked account with the person's email still refuses the shadow", async () => {
    // An email alone is never proof of identity (AGENTS.md §1.4). Only Middleware/verify.ts links by
    // email, and only with a verified token in hand.
    const person = authPerson();
    const unlinkedId = await olderAccount(undefined, person.email);

    await expect(syncLocalShadowUser(person)).rejects.toSatisfy(isDuplicateKeyError);

    expect((await stored(unlinkedId))?.personId).toBeUndefined();
    expect(await stored(person._id)).toBeNull();
  });

  it("stamps nothing over a person already set", async () => {
    const other = newId();
    const accountId = await olderAccount(other);

    expect(await stampPersonId(accountId, newId())).toBe(false);
    expect((await stored(accountId))?.personId).toBe(other);
  });
});

describe("backfillShadowPersonIds", () => {
  /** One account of each kind the backfill can meet, plus the answers auth gives for them. */
  const seedAccounts = async () => {
    const shadow = await olderShadow();
    const shadowWithNull = newId();
    // Older code stored an explicit null (b696861), which the model no longer writes.
    await UserModel.collection.insertOne({ _id: objectId(shadowWithNull), fullName: "Null", email: nextEmail(), personId: null });
    const linkedPerson = newId();
    const linked = await olderAccount(linkedPerson);
    const unlinked = await olderAccount();
    const duplicated = await olderShadow();
    const holder = await olderAccount(duplicated);
    const unreachable = await olderShadow();

    const asked: string[] = [];
    const isPerson = async (id: string) => {
      asked.push(id);
      if (id === unreachable) throw new Error("auth answered HTTP 503");
      return id !== unlinked;
    };
    return { shadow, shadowWithNull, linked, linkedPerson, unlinked, duplicated, holder, unreachable, isPerson, asked };
  };
  const snapshot = () => UserModel.collection.find({}).sort({ _id: 1 }).toArray();

  it("writes nothing in a dry run, and says what it would do", async () => {
    const { duplicated, holder, unreachable, isPerson } = await seedAccounts();
    const before = await snapshot();

    const report = await backfillShadowPersonIds({ isPerson, write: false });

    expect(report).toEqual({
      candidates: 5,
      stamped: 2,
      notAPerson: 1,
      alreadySet: 0,
      heldElsewhere: [{ personId: duplicated, holderId: holder }],
      lookupFailed: [{ accountId: unreachable, reason: "auth answered HTTP 503" }],
    });
    expect(await snapshot()).toEqual(before);
  });

  it("stamps only what auth confirms, and the dry run's forecast matches what it does", async () => {
    const { shadow, shadowWithNull, linked, linkedPerson, unlinked, duplicated, holder, unreachable, isPerson, asked } = await seedAccounts();
    const forecast = await backfillShadowPersonIds({ isPerson, write: false });
    asked.length = 0;

    const report = await backfillShadowPersonIds({ isPerson, write: true });

    expect(report).toEqual(forecast);
    // Confirmed: stamped with their own _id, as a string.
    expect((await stored(shadow))?.personId).toBe(shadow);
    expect((await stored(shadowWithNull))?.personId).toBe(shadowWithNull);
    // Everyone else is exactly as they were.
    expect((await stored(linked))?.personId).toBe(linkedPerson);
    expect((await stored(unlinked))?.personId).toBeUndefined();
    expect((await stored(unreachable))?.personId).toBeUndefined();
    // The index refused the second claim; the holder keeps the person.
    expect((await stored(duplicated))?.personId).toBeUndefined();
    expect((await stored(holder))?.personId).toBe(duplicated);
    // An account that already has a person isn't a candidate, so auth is never asked about it.
    expect(asked).not.toContain(linked);
    expect(asked).not.toContain(holder);
  });

  it("is safe to re-run: stamped accounts stop being candidates, and a failed lookup gets another go", async () => {
    const { shadow, unreachable, isPerson } = await seedAccounts();
    await backfillShadowPersonIds({ isPerson, write: true });

    const asked: string[] = [];
    const second = await backfillShadowPersonIds({
      isPerson: async (id) => {
        asked.push(id);
        return isPerson(id).catch(() => true);
      },
      write: true,
    });

    expect(second).toMatchObject({ candidates: 3, stamped: 1, notAPerson: 1, lookupFailed: [] });
    expect(second.heldElsewhere).toHaveLength(1);
    expect(asked).not.toContain(shadow);
    expect((await stored(unreachable))?.personId).toBe(unreachable);
  });

  it("counts an account that got its person while the run was going, and overwrites nothing", async () => {
    const personId = await olderShadow();
    const other = newId();

    const report = await backfillShadowPersonIds({
      isPerson: async () => {
        await UserModel.updateOne({ _id: personId }, { $set: { personId: other } });
        return true;
      },
      write: true,
    });

    expect(report).toMatchObject({ candidates: 1, stamped: 0, alreadySet: 1 });
    expect((await stored(personId))?.personId).toBe(other);
  });
});

describe("isLocalDatabase", () => {
  it.each([
    "mongodb://127.0.0.1:27028/EasybuyTracker?replicaSet=rs0",
    "mongodb://localhost/EasybuyTracker",
    "mongodb://user:secret@localhost:27017/EasybuyTracker",
    "mongodb://[::1]:27017/EasybuyTracker",
    "mongodb://127.0.0.1:27028,127.0.0.1:27029/EasybuyTracker",
    "  mongodb://LOCALHOST:27017  ",
  ])("accepts %s", (uri) => {
    expect(isLocalDatabase(uri)).toBe(true);
  });

  it.each([
    "mongodb+srv://user:secret@cluster0.example.mongodb.net/EasybuyTracker",
    "mongodb://ac-example-shard-00-00.example.mongodb.net:27017/EasybuyTracker",
    "mongodb://mongo.railway.internal:27017/EasybuyTracker",
    // A password that looks like the host mustn't fool it, and neither must one remote member.
    "mongodb://localhost:secret@db.example.com:27017/EasybuyTracker",
    "mongodb://127.0.0.1:27028,db.example.com:27017/EasybuyTracker",
    "mongodb://localhost.example.com/EasybuyTracker",
    "not a connection string",
    "",
  ])("refuses %s", (uri) => {
    expect(isLocalDatabase(uri)).toBe(false);
  });
});
