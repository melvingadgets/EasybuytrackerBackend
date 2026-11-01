import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OUTBOX_COLLECTION, parseEvent } from "@melvingadgets/platform-kit";

// The repayment reminder job against a real replica set (Shortwork/docs/notifications.md §13): real
// models, real transactions, the real unique index. Nothing under test is mocked. What it guards:
// a reminder and its event commit together, each goes out exactly once however many runs race, and
// nobody who has paid, or who the item doesn't provably belong to, hears about it.

let ItemModel: typeof import("../Model/EasyBoughtitem.js").default;
let ReceiptModel: typeof import("../Model/ReceiptModel.js").default;
let UserModel: typeof import("../Model/UserModel.js").default;
let ReminderModel: typeof import("../Model/RepaymentReminderModel.js").default;
let AuditModel: typeof import("../Model/AuditLogModel.js").default;
let job: typeof import("../Service/RepaymentReminders.js");
let schedule: typeof import("../Utils/repaymentSchedule.js");

const ADMIN = "60a000000000000000000001";

// 09:00 in Lagos on 5 November 2026.
const NOW = new Date("2026-11-05T09:00:00.000+01:00");
const TODAY = "2026-11-05";

beforeAll(async () => {
  await (await import("../Database/Database.js")).default;
  ItemModel = (await import("../Model/EasyBoughtitem.js")).default;
  ReceiptModel = (await import("../Model/ReceiptModel.js")).default;
  UserModel = (await import("../Model/UserModel.js")).default;
  ReminderModel = (await import("../Model/RepaymentReminderModel.js")).default;
  AuditModel = (await import("../Model/AuditLogModel.js")).default;
  job = await import("../Service/RepaymentReminders.js");
  schedule = await import("../Utils/repaymentSchedule.js");
  await Promise.all([ItemModel.syncIndexes(), ReceiptModel.syncIndexes(), UserModel.syncIndexes(), ReminderModel.syncIndexes()]);
  await (await import("../Utils/messaging.js")).initOutbox();
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const db = () => mongoose.connection.db!;
const outbox = () => db().collection(OUTBOX_COLLECTION);

afterEach(async () => {
  await Promise.all([
    ItemModel.deleteMany({}),
    ReceiptModel.deleteMany({}),
    UserModel.deleteMany({}),
    ReminderModel.deleteMany({}),
    AuditModel.deleteMany({}),
    outbox().deleteMany({}),
    db().collection("event_seqs").deleteMany({}),
  ]);
});

let accounts = 0;
const seedAccount = async (fields: { personId?: string | null; manualNextDueDate?: Date } = {}) => {
  accounts += 1;
  const _id = new mongoose.Types.ObjectId();
  const account = await UserModel.create({
    _id,
    fullName: `Customer ${accounts}`,
    email: `customer${accounts}@example.test`,
    password: "not-used-in-this-test",
    role: "User",
    ...(fields.personId === null ? {} : { personId: fields.personId ?? `person-${accounts}` }),
    ...(fields.manualNextDueDate ? { manualNextDueDate: fields.manualNextDueDate } : {}),
  });
  return { _id, email: account.email, personId: account.personId ?? null };
};

/** A ₦300,000 loan on 3 months: 1.6 × = ₦480,000, so ₦160,000 an instalment, one every 30 days. */
const seedItem = async (account: { _id: mongoose.Types.ObjectId; email: string }, firstDueOn: string, fields: Record<string, unknown> = {}) =>
  ItemModel.create({
    provider: "aurapay",
    IphoneModel: "iPhone 13",
    IphoneImageUrl: "https://example.test/x.png",
    capacity: "128GB",
    Plan: "Monthly",
    monthlyPlan: 3,
    downPayment: 200_000,
    loanedAmount: 300_000,
    PhonePrice: 500_000,
    UserId: account._id,
    UserEmail: account.email,
    // Created 30 days before the first instalment, mid-afternoon in Lagos.
    createdAt: new Date(`${schedule.addDays(firstDueOn, -30)}T15:00:00.000+01:00`),
    ...fields,
  });

const seedReceipt = (account: { _id: mongoose.Types.ObjectId }, amount: number, status: "approved" | "pending" | "rejected" = "approved") =>
  ReceiptModel.create({
    user: account._id,
    plan: "Monthly",
    amount,
    fileUrl: "https://example.test/proof.jpg",
    fileType: "image",
    cloudinaryPublicId: "proof",
    status,
  });

const send = (now: Date = NOW) => job.runRepaymentReminders({ now, write: true });
const on = (date: string) => new Date(`${date}T09:00:00.000+01:00`);

describe("a reminder", () => {
  it("commits with its event, in kobo, for the person, on a Lagos date", async () => {
    const account = await seedAccount();
    const item = await seedItem(account, schedule.addDays(TODAY, 3));
    const report = await send();

    expect(report.today).toBe(TODAY);
    expect(report.counts).toMatchObject({ sent: 1, already_sent: 0, failed: 0 });

    const events = await outbox().find({}).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "easybuy.repayment.due",
      source: "easybuy",
      status: "pending",
      seq: 1,
      subject: { kind: "instalment", id: `${item._id}:1`, personId: account.personId },
      data: {
        itemId: String(item._id),
        personId: account.personId,
        instalment: 1,
        dueOn: "2026-11-08",
        amountKobo: 16_000_000,
        stage: "upcoming",
      },
    });
    // What a consumer will do with it: the kit's own contract accepts exactly what was written.
    const { _id, status, createdAt, ...envelope } = events[0] as Record<string, unknown>;
    void status;
    void createdAt;
    expect(parseEvent(envelope).eventId).toBe(_id);

    const reminders = await ReminderModel.find({}).lean();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ instalment: 1, stage: "upcoming", personId: account.personId, dueOn: "2026-11-08", amountKobo: 16_000_000, eventId: _id });
    expect(String(reminders[0]!.itemId)).toBe(String(item._id));
  });

  it("goes out once, however often the job runs", async () => {
    await seedItem(await seedAccount(), schedule.addDays(TODAY, 3));
    expect((await send()).counts).toMatchObject({ sent: 1, already_sent: 0 });
    expect((await send()).counts).toMatchObject({ sent: 0, already_sent: 1 });
    expect((await send()).counts).toMatchObject({ sent: 0, already_sent: 1 });

    expect(await ReminderModel.countDocuments({})).toBe(1);
    expect(await outbox().countDocuments({})).toBe(1);
  });

  it("goes out once when runs race: the unique index decides, not a read", async () => {
    await seedItem(await seedAccount(), schedule.addDays(TODAY, 3));
    const reports = await Promise.all(Array.from({ length: 5 }, () => send()));

    const total = (key: "sent" | "already_sent" | "failed") => reports.reduce((sum, { counts }) => sum + counts[key], 0);
    expect(total("sent")).toBe(1);
    expect(total("already_sent")).toBe(4);
    expect(total("failed")).toBe(0);
    expect(await ReminderModel.countDocuments({})).toBe(1);
    expect(await outbox().countDocuments({})).toBe(1);
  });

  it("walks an unpaid instalment through each stage, with the instalment's seq moving forward", async () => {
    await seedItem(await seedAccount(), TODAY);
    await send(on("2026-11-02"));
    await send(on("2026-11-05"));
    await send(on("2026-11-06"));
    // The days between have nothing new to say.
    expect((await send(on("2026-11-07"))).counts.sent).toBe(0);

    const events = await outbox().find({}).sort({ seq: 1 }).toArray();
    expect(events.map((event) => [(event.data as { stage: string }).stage, event.seq])).toEqual([
      ["upcoming", 1],
      ["due", 2],
      ["overdue", 3],
    ]);
    expect(new Set(events.map((event) => (event.subject as { id: string }).id)).size).toBe(1);
  });

  it("names the next instalment once the first has gone by", async () => {
    await seedItem(await seedAccount(), TODAY);
    await send(on("2026-11-06"));
    await send(on("2026-12-02"));
    const events = await outbox().find({}).sort({ createdAt: 1 }).toArray();
    expect(events.map((event) => [(event.data as { instalment: number }).instalment, (event.data as { stage: string }).stage, (event.data as { dueOn: string }).dueOn])).toEqual([
      [1, "overdue", "2026-11-05"],
      [2, "upcoming", "2026-12-05"],
    ]);
  });

  it("leaves nothing behind when its event can't be written", async () => {
    await seedItem(await seedAccount(), schedule.addDays(TODAY, 3));
    await db().command({ collMod: OUTBOX_COLLECTION, validator: { type: { $eq: "something-else" } } });
    try {
      expect((await send()).counts).toMatchObject({ sent: 0, failed: 1 });
      expect(await ReminderModel.countDocuments({})).toBe(0);
    } finally {
      await db().command({ collMod: OUTBOX_COLLECTION, validator: {} });
    }
    expect((await send()).counts.sent).toBe(1);
  });

  it("takes its event back when its own record can't be written, and the retry starts the seq clean", async () => {
    await seedItem(await seedAccount(), schedule.addDays(TODAY, 3));
    await db().command({ collMod: ReminderModel.collection.name, validator: { eventId: { $eq: "something-else" } } });
    try {
      expect((await send()).counts).toMatchObject({ sent: 0, failed: 1 });
      expect(await outbox().countDocuments({})).toBe(0);
      expect(await db().collection("event_seqs").countDocuments({})).toBe(0);
    } finally {
      await db().command({ collMod: ReminderModel.collection.name, validator: {} });
    }
    expect((await send()).counts.sent).toBe(1);
    expect((await outbox().findOne({}))?.seq).toBe(1);
  });

  it("holds nobody else's back when one fails, and the failed one goes on the next run", async () => {
    const failing = await seedItem(await seedAccount(), schedule.addDays(TODAY, 3));
    const fine = await seedItem(await seedAccount(), schedule.addDays(TODAY, 3));
    await db().command({ collMod: ReminderModel.collection.name, validator: { itemId: { $ne: failing._id } } });
    try {
      const report = await send();
      expect(report.counts).toMatchObject({ sent: 1, failed: 1 });
      expect(report.reminders.find(({ itemId }) => itemId === String(fine._id))?.outcome).toBe("sent");
      expect(report.reminders.find(({ itemId }) => itemId === String(failing._id))?.outcome).toBe("failed");
    } finally {
      await db().command({ collMod: ReminderModel.collection.name, validator: {} });
    }
    expect((await send()).counts).toMatchObject({ sent: 1, already_sent: 1, failed: 0 });
    expect(await outbox().countDocuments({})).toBe(2);
  });
});

describe("who hears nothing", () => {
  it("someone who has paid the instalment", async () => {
    const account = await seedAccount();
    await seedItem(account, schedule.addDays(TODAY, 3));
    await seedReceipt(account, 160_000);
    const report = await send();
    expect(report.reminders).toEqual([]);
    expect(await outbox().countDocuments({})).toBe(0);
  });

  it("someone whose proof is waiting for review, until it is rejected", async () => {
    const account = await seedAccount();
    await seedItem(account, schedule.addDays(TODAY, 3));
    const receipt = await seedReceipt(account, 160_000, "pending");
    expect((await send()).counts.sent).toBe(0);

    await ReceiptModel.updateOne({ _id: receipt._id }, { $set: { status: "rejected" } });
    expect((await send()).counts.sent).toBe(1);
  });

  it("an account whose items are all paid, after paying them across several receipts", async () => {
    const account = await seedAccount();
    await seedItem(account, "2026-08-01");
    await seedReceipt(account, 200_000.5);
    await seedReceipt(account, 279_999.5);
    expect((await send()).reminders).toEqual([]);
  });

  it("an account with no platform person, counted so it can be chased", async () => {
    await seedItem(await seedAccount({ personId: null }), schedule.addDays(TODAY, 3));
    const report = await send();
    expect(report.counts).toMatchObject({ sent: 0, no_person: 1 });
    expect(await outbox().countDocuments({})).toBe(0);
  });

  it("anyone at all when the item names another person than the account (F-1)", async () => {
    await seedItem(await seedAccount({ personId: "person-a" }), schedule.addDays(TODAY, 3), { personId: "person-b" });
    const report = await send();
    expect(report.counts).toMatchObject({ sent: 0, person_mismatch: 1 });
    expect(report.skipped[0]).toMatchObject({ instalment: 1, stage: "upcoming", reason: "person_mismatch" });
    expect(await outbox().countDocuments({})).toBe(0);
  });

  it("anyone when the item names a person and the account belongs to nobody", async () => {
    await seedItem(await seedAccount({ personId: null }), schedule.addDays(TODAY, 3), { personId: "person-b" });
    expect((await send()).counts).toMatchObject({ sent: 0, person_mismatch: 1 });
  });

  it("anyone when the item's account no longer exists", async () => {
    await seedItem({ _id: new mongoose.Types.ObjectId(), email: "gone@example.test" }, schedule.addDays(TODAY, 3));
    expect((await send()).counts).toMatchObject({ sent: 0, no_person: 1 });
  });

  it("someone on a plan that can't be priced, rather than being told a guess", async () => {
    await seedItem(await seedAccount(), schedule.addDays(TODAY, 3), { monthlyPlan: 12 });
    const report = await send();
    expect(report.counts).toMatchObject({ sent: 0, unknown_plan: 1 });
    expect(await outbox().countDocuments({})).toBe(0);
  });

  it("someone an admin gave more time, until that date passes", async () => {
    const account = await seedAccount({ manualNextDueDate: new Date("2026-11-20T12:00:00.000+01:00") });
    await seedItem(account, "2026-11-01");
    const held = await send();
    expect(held.counts).toMatchObject({ sent: 0, on_hold: 1 });
    expect(await outbox().countDocuments({})).toBe(0);
    expect((await send(on("2026-11-19"))).counts).toMatchObject({ sent: 0, on_hold: 1 });

    const after = await send(on("2026-11-20"));
    expect(after.counts).toMatchObject({ sent: 1, on_hold: 0 });
    expect(after.reminders[0]).toMatchObject({ instalment: 1, stage: "overdue", dueOn: "2026-11-01" });
  });

  it("nothing due on or after the date an admin set is held", async () => {
    const account = await seedAccount({ manualNextDueDate: new Date("2026-11-08T12:00:00.000+01:00") });
    await seedItem(account, "2026-11-08");
    expect((await send()).counts).toMatchObject({ sent: 1, on_hold: 0 });
  });

  it("a date an admin set in the past changes nothing", async () => {
    const account = await seedAccount({ manualNextDueDate: new Date("2026-01-01T12:00:00.000+01:00") });
    await seedItem(account, schedule.addDays(TODAY, 3));
    expect((await send()).counts).toMatchObject({ sent: 1, on_hold: 0 });
  });
});

describe("what a part payment does", () => {
  it("asks for what is left of the instalment", async () => {
    const account = await seedAccount();
    await seedItem(account, schedule.addDays(TODAY, 3));
    await seedReceipt(account, 60_000);
    const report = await send();
    expect(report.reminders[0]).toMatchObject({ instalment: 1, amountKobo: 10_000_000, stage: "upcoming" });
  });

  it("converts each receipt's naira float exactly, so no kobo is lost in the sum", async () => {
    const account = await seedAccount();
    await seedItem(account, schedule.addDays(TODAY, 3));
    // Three of these add up to 0.30000000000000004 as floats.
    await Promise.all([seedReceipt(account, 0.1), seedReceipt(account, 0.1), seedReceipt(account, 0.1)]);
    const report = await send();
    expect(report.reminders[0]?.amountKobo).toBe(16_000_000 - 30);
  });
});

describe("who the reminder finds", () => {
  it("an older shadow, whose _id is the person the item names", async () => {
    const account = await seedAccount({ personId: null });
    const person = String(account._id);
    await seedItem(account, schedule.addDays(TODAY, 3), { personId: person });
    const report = await send();
    expect(report.counts.sent).toBe(1);
    expect(report.reminders[0]?.personId).toBe(person);
  });

  it("an older item with no person of its own, through its linked account", async () => {
    const account = await seedAccount({ personId: "person-linked" });
    await seedItem(account, schedule.addDays(TODAY, 3));
    expect((await send()).reminders[0]?.personId).toBe("person-linked");
  });
});

describe("a dry run", () => {
  it("lists what a real run would send and writes nothing", async () => {
    const account = await seedAccount();
    const item = await seedItem(account, schedule.addDays(TODAY, 3));
    await db().collection("event_seqs").deleteMany({});
    const report = await job.runRepaymentReminders({ now: NOW, write: false });

    expect(report.reminders).toEqual([
      { itemId: String(item._id), instalment: 1, dueOn: "2026-11-08", amountKobo: 16_000_000, stage: "upcoming", personId: account.personId, outcome: "would_send" },
    ]);
    expect(report.counts).toMatchObject({ would_send: 1, sent: 0 });
    expect(await ReminderModel.countDocuments({})).toBe(0);
    expect(await outbox().countDocuments({})).toBe(0);
    expect(await db().collection("event_seqs").countDocuments({})).toBe(0);
  });

  it("tells a reminder already sent from a new one", async () => {
    await seedItem(await seedAccount(), schedule.addDays(TODAY, 3));
    await send();
    const report = await job.runRepaymentReminders({ now: NOW, write: false });
    expect(report.counts).toMatchObject({ would_send: 0, already_sent: 1 });
  });
});

describe("the unique index", () => {
  it("is rebuilt before a real run writes anything", async () => {
    await seedItem(await seedAccount(), schedule.addDays(TODAY, 3));
    await ReminderModel.collection.dropIndex("itemId_1_instalment_1_stage_1");
    expect(await job.reminderIndexExists()).toBe(false);

    await send();

    expect(await job.reminderIndexExists()).toBe(true);
    expect((await send()).counts).toMatchObject({ sent: 0, already_sent: 1 });
  });

  it("is on exactly (itemId, instalment, stage), so each stage of an instalment gets one", async () => {
    const itemId = new mongoose.Types.ObjectId();
    const reminder = { itemId, instalment: 1, stage: "due" as const, personId: "p", dueOn: TODAY, amountKobo: 1, eventId: "e" };
    await ReminderModel.create(reminder);
    await expect(ReminderModel.create(reminder)).rejects.toMatchObject({ code: 11000 });
    await expect(ReminderModel.create({ ...reminder, instalment: 2 })).resolves.toBeTruthy();
    await expect(ReminderModel.create({ ...reminder, stage: "overdue" })).resolves.toBeTruthy();
  });

  it("refuses an amount that isn't whole kobo", async () => {
    const reminder = { itemId: new mongoose.Types.ObjectId(), instalment: 1, stage: "due" as const, personId: "p", dueOn: TODAY, eventId: "e" };
    await expect(ReminderModel.create({ ...reminder, amountKobo: 10.5 })).rejects.toThrow(/integer kobo/);
    await expect(ReminderModel.create({ ...reminder, amountKobo: 0 })).rejects.toThrow();
  });
});

describe("matching what the customer sees", () => {
  it("names the date and the amount their dashboard shows as next", async () => {
    const { GetDashboard } = await import("../Controller/DashboardController.js");
    const account = await seedAccount();
    // Relative to the real clock, because the dashboard reads it. First instalment three days away.
    const created = new Date(Date.now() - 27 * 24 * 60 * 60 * 1000);
    await seedItem(account, TODAY, { createdAt: created });

    const app = express();
    app.get("/dashboard", (req, _res, next) => {
      (req as unknown as { user: unknown }).user = { _id: String(account._id), role: "User" };
      next();
    }, GetDashboard);
    const dashboard = await request(app).get("/dashboard");
    expect(dashboard.status).toBe(200);

    const report = await job.runRepaymentReminders({ write: false });
    expect(report.reminders).toHaveLength(1);
    expect(schedule.lagosDate(new Date(dashboard.body.nextPaymentDue))).toBe(report.reminders[0]!.dueOn);
    expect(Math.round(dashboard.body.nextPaymentAmount * 100)).toBe(report.reminders[0]!.amountKobo);
  });
});

describe("deleting an account", () => {
  it("removes its reminders along with its items", async () => {
    const { SuperAdminDeleteUserOrAdmin } = await import("../Controller/SuperAdminController.js");
    const account = await seedAccount();
    const other = await seedAccount();
    await seedItem(account, schedule.addDays(TODAY, 3));
    await seedItem(other, schedule.addDays(TODAY, 3));
    await send();
    expect(await ReminderModel.countDocuments({})).toBe(2);

    const app = express();
    app.use(express.json());
    app.delete("/users/:userId", (req, _res, next) => {
      (req as unknown as { user: unknown }).user = { _id: ADMIN, role: "SuperAdmin" };
      next();
    }, SuperAdminDeleteUserOrAdmin);
    const res = await request(app).delete(`/users/${account._id}`).send({ reason: "closed at the customer's request" });
    expect(res.status).toBe(200);

    const left = await ReminderModel.find({}).lean();
    expect(left).toHaveLength(1);
    expect(left[0]?.personId).toBe(other.personId);
  });
});

describe("the daily schedule", () => {
  const counts = (failed = 0) => ({ counts: { sent: 0, already_sent: 0, failed, would_send: 0, no_person: 0, person_mismatch: 0, unknown_plan: 0, on_hold: 0 } });
  const at = (date: string, time: string) => new Date(`${date}T${time}:00.000+01:00`);
  const scheduleWith = (run: (now: Date) => Promise<ReturnType<typeof counts>>, clock: { now: Date }) =>
    job.createReminderSchedule({ run, now: () => clock.now });

  it("runs once a day, from 08:00 Lagos", async () => {
    const run = vi.fn(async () => counts());
    const clock = { now: at("2026-11-05", "07:59") };
    const { tick } = scheduleWith(run, clock);

    await tick();
    expect(run).not.toHaveBeenCalled();

    clock.now = at("2026-11-05", "08:00");
    await tick();
    clock.now = at("2026-11-05", "08:15");
    await tick();
    expect(run).toHaveBeenCalledTimes(1);

    clock.now = at("2026-11-06", "08:00");
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("doesn't start one after 20:00, so a late restart wakes nobody", async () => {
    const run = vi.fn(async () => counts());
    const clock = { now: at("2026-11-05", "19:59") };
    const late = scheduleWith(run, { now: at("2026-11-05", "20:00") });
    await late.tick();
    await scheduleWith(run, { now: at("2026-11-05", "23:30") }).tick();
    await scheduleWith(run, { now: at("2026-11-05", "02:00") }).tick();
    expect(run).not.toHaveBeenCalled();

    await scheduleWith(run, clock).tick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("tries again next tick after a run with failures, and stops once one is clean", async () => {
    const run = vi.fn<() => Promise<ReturnType<typeof counts>>>().mockResolvedValueOnce(counts(2)).mockResolvedValue(counts());
    const { tick } = scheduleWith(run, { now: at("2026-11-05", "09:00") });
    await tick();
    await tick();
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never lets a failed run reject, because that would stop the API, and tries again", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const run = vi.fn<() => Promise<ReturnType<typeof counts>>>().mockRejectedValueOnce(new Error("no primary")).mockResolvedValue(counts());
      const { tick } = scheduleWith(run, { now: at("2026-11-05", "09:00") });
      await expect(tick()).resolves.toBeUndefined();
      await tick();
      expect(run).toHaveBeenCalledTimes(2);
      expect(write.mock.calls.join("")).toContain("repayment_reminders_failed");
    } finally {
      write.mockRestore();
    }
  });

  it("doesn't start a second run while one is going", async () => {
    let finish: (value: ReturnType<typeof counts>) => void = () => undefined;
    const run = vi.fn(() => new Promise<ReturnType<typeof counts>>((resolve) => (finish = resolve)));
    const { tick } = scheduleWith(run, { now: at("2026-11-05", "09:00") });
    const first = tick();
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    finish(counts());
    await first;
  });

  it("isn't started unless it is switched on, and never without events", async () => {
    const { config } = await import("../config/Config.js");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const was = { reminders: config.repaymentRemindersEnabled, events: config.eventsEnabled };
    try {
      config.repaymentRemindersEnabled = false;
      expect(job.startRepaymentReminders()).toBeNull();

      config.repaymentRemindersEnabled = true;
      config.eventsEnabled = false;
      expect(job.startRepaymentReminders()).toBeNull();
      expect(write.mock.calls.join("")).toContain("repayment_reminders_off");
    } finally {
      config.repaymentRemindersEnabled = was.reminders;
      config.eventsEnabled = was.events;
      write.mockRestore();
    }
  });
});
