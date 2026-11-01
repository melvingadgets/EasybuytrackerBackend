import { randomUUID } from "crypto";
import { inTransaction, isDuplicateKey } from "@melvingadgets/platform-kit";
import { config } from "../config/Config.js";
import EasyBoughtItemModel from "../Model/EasyBoughtitem.js";
import ReceiptModel from "../Model/ReceiptModel.js";
import RepaymentReminderModel, { type ReminderStage } from "../Model/RepaymentReminderModel.js";
import UserModel from "../Model/UserModel.js";
import { ConversionIdentityMismatchError, resolveConversionPersonId } from "../Utils/conversionIdentity.js";
import { publishRepaymentDue } from "../Utils/journeyEvents.js";
import { mongoClient } from "../Utils/messaging.js";
import {
  instalmentsOf,
  lagosDate,
  lagosHour,
  remindersFor,
  unpaidInstalments,
  type Instalment,
  type PlannedReminder,
  type ScheduleItem,
} from "../Utils/repaymentSchedule.js";
import { toKobo } from "../Utils/serviceFee.js";

// The daily repayment reminder job (Shortwork/docs/notifications.md §13). It works out which unpaid
// instalments reach a stage today and writes each reminder with its easybuy.repayment.due event in
// one transaction (Shortwork/AGENTS.md §3.1). The relay carries the event to auth, which turns it
// into the notice and the device alert.

export interface PersonReminder extends PlannedReminder {
  personId: string;
}

export type SkipReason = "no_person" | "person_mismatch" | "unknown_plan" | "on_hold";

export interface SkippedReminder {
  itemId: string;
  instalment: number | null;
  stage: ReminderStage | null;
  reason: SkipReason;
}

export interface ReminderPlan {
  today: string;
  items: number;
  reminders: PersonReminder[];
  skipped: SkippedReminder[];
}

type ItemRow = ScheduleItem & { UserId: unknown; personId?: string | null };

// A proof waiting for review counts too. Whoever uploaded one believes they have paid, and telling
// them they are overdue for the days an admin takes to look would be wrong. A rejected proof stops
// counting the moment it is rejected, so the next run reminds them.
const COUNTED_RECEIPTS = ["approved", "pending"];

const personOf = (item: ItemRow, account: { _id: unknown; personId?: unknown } | undefined): string | null | "mismatch" => {
  try {
    // The same rule that decided the item's person when it was converted (F-1), so a reminder can
    // only go to the person the account belongs to, and an item recorded under someone else gets none.
    return resolveConversionPersonId({ requestPersonId: item.personId, accountPersonId: account?.personId, accountId: account?._id });
  } catch (error) {
    if (error instanceof ConversionIdentityMismatchError) return "mismatch";
    throw error;
  }
};

/** Reads only: which reminders today calls for, and which it can't send and why. */
export const planRepaymentReminders = async (now: Date): Promise<ReminderPlan> => {
  const today = lagosDate(now);
  const rows = await EasyBoughtItemModel.find({})
    .select({ provider: 1, Plan: 1, monthlyPlan: 1, weeklyPlan: 1, loanedAmount: 1, PhonePrice: 1, TotalPrice: 1, downPayment: 1, createdAt: 1, UserId: 1, personId: 1 })
    .lean();
  const items: ItemRow[] = rows.map((row) => {
    const item = row as unknown as ItemRow & { _id: { getTimestamp(): Date } };
    return { ...item, createdAt: item.createdAt ?? item._id.getTimestamp() };
  });

  const accountIds = [...new Set(items.map((item) => String(item.UserId)))];
  const [accounts, receipts] = await Promise.all([
    UserModel.find({ _id: { $in: accountIds } } as never)
      .select({ personId: 1, manualNextDueDate: 1 })
      .lean(),
    ReceiptModel.find({ user: { $in: accountIds }, status: { $in: COUNTED_RECEIPTS } } as never)
      .select({ user: 1, amount: 1 })
      .lean(),
  ]);
  const accountById = new Map(accounts.map((account) => [String(account._id), account]));

  const paidByAccount = new Map<string, number>();
  for (const receipt of receipts) {
    const account = String(receipt.user);
    paidByAccount.set(account, (paidByAccount.get(account) ?? 0) + toKobo(receipt.amount));
  }

  const reminders: PersonReminder[] = [];
  const skipped: SkippedReminder[] = [];
  for (const accountId of accountIds) {
    const owned = items.filter((item) => String(item.UserId) === accountId);
    const account = accountById.get(accountId);

    const instalments: Instalment[] = [];
    for (const item of owned) {
      const schedule = instalmentsOf(item);
      if (schedule) instalments.push(...schedule);
      else skipped.push({ itemId: String(item._id), instalment: null, stage: null, reason: "unknown_plan" });
    }

    // manualNextDueDate is a SuperAdmin's correction for a legacy account. The dashboard doesn't read
    // it, so reminders keep the dashboard's dates, but while that date is ahead nothing due before it
    // is chased: an alert must not call someone overdue when an admin has given them until then.
    const manual = account?.manualNextDueDate instanceof Date ? lagosDate(account.manualNextDueDate) : null;
    const holdUntil = manual && manual > today ? manual : null;

    for (const reminder of remindersFor(unpaidInstalments(instalments, paidByAccount.get(accountId) ?? 0), today)) {
      const skip = (reason: SkipReason) =>
        skipped.push({ itemId: reminder.itemId, instalment: reminder.instalment, stage: reminder.stage, reason });
      if (holdUntil && reminder.dueOn < holdUntil) {
        skip("on_hold");
        continue;
      }
      const personId = personOf(owned.find((item) => String(item._id) === reminder.itemId) as ItemRow, account);
      if (personId === "mismatch") skip("person_mismatch");
      else if (personId === null) skip("no_person");
      else reminders.push({ ...reminder, personId });
    }
  }
  return { today, items: items.length, reminders, skipped };
};

const hasUniqueIndex = async (): Promise<boolean> => {
  const indexes = await RepaymentReminderModel.collection.indexes().catch((error: { code?: number }) => {
    if (error.code === 26) return []; // no such collection yet
    throw error;
  });
  return indexes.some((index) => index.unique && Object.keys(index.key).join() === "itemId,instalment,stage");
};

export const reminderIndexExists = hasUniqueIndex;

/** The index is what makes a reminder exactly-once, so nothing is sent without it. */
export const ensureReminderIndex = async (): Promise<void> => {
  await RepaymentReminderModel.createIndexes();
  if (!(await hasUniqueIndex())) throw new Error("the unique repayment reminder index could not be built");
};

/** "sent" is the only outcome that told anyone; "already_sent" means the unique index refused it. */
const sendReminder = async (reminder: PersonReminder, traceId: string): Promise<"sent" | "already_sent"> => {
  try {
    await inTransaction(mongoClient(), async (session) => {
      const event = await publishRepaymentDue(session, traceId, reminder);
      await RepaymentReminderModel.create(
        [
          {
            itemId: reminder.itemId,
            instalment: reminder.instalment,
            stage: reminder.stage,
            personId: reminder.personId,
            dueOn: reminder.dueOn,
            amountKobo: reminder.amountKobo,
            eventId: event.eventId,
          },
        ],
        { session: session as never }
      );
    });
    return "sent";
  } catch (error) {
    if (isDuplicateKey(error)) return "already_sent";
    throw error;
  }
};

export type ReminderOutcome = "sent" | "already_sent" | "failed" | "would_send";

export interface ReminderRunReport extends Omit<ReminderPlan, "reminders"> {
  traceId: string;
  reminders: (PersonReminder & { outcome: ReminderOutcome })[];
  counts: Record<ReminderOutcome | SkipReason, number>;
}

const log = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void => {
  // Ids and counts only (Shortwork/AGENTS.md §6.3).
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, svc: "easybuy", event, ...fields })}\n`);
};

const countsOf = (reminders: { outcome: ReminderOutcome }[], skipped: SkippedReminder[]): ReminderRunReport["counts"] => {
  const counts: ReminderRunReport["counts"] = { sent: 0, already_sent: 0, failed: 0, would_send: 0, no_person: 0, person_mismatch: 0, unknown_plan: 0, on_hold: 0 };
  for (const { outcome } of reminders) counts[outcome] += 1;
  for (const { reason } of skipped) counts[reason] += 1;
  return counts;
};

/**
 * One run. `write: false` is a dry run: it reads the same data and reports what a real run would
 * send, changing nothing. A real run can be repeated freely: the unique index refuses what has gone.
 */
export const runRepaymentReminders = async (options: { now?: Date; write: boolean; traceId?: string }): Promise<ReminderRunReport> => {
  const now = options.now ?? new Date();
  const traceId = options.traceId ?? randomUUID();
  if (options.write) await ensureReminderIndex();

  const plan = await planRepaymentReminders(now);
  const reminders: ReminderRunReport["reminders"] = [];
  if (options.write) {
    // One at a time, each in its own transaction, so one failure holds back nobody else's reminder.
    for (const reminder of plan.reminders) {
      try {
        reminders.push({ ...reminder, outcome: await sendReminder(reminder, traceId) });
      } catch (error) {
        reminders.push({ ...reminder, outcome: "failed" });
        log("error", "repayment_reminder_failed", { traceId, itemId: reminder.itemId, instalment: reminder.instalment, stage: reminder.stage, message: (error as Error).message.slice(0, 200) });
      }
    }
  } else {
    const sent = await RepaymentReminderModel.find({ itemId: { $in: [...new Set(plan.reminders.map((reminder) => reminder.itemId))] } } as never)
      .select({ itemId: 1, instalment: 1, stage: 1 })
      .lean();
    const keyOf = (key: { itemId: unknown; instalment: number; stage: string }) => `${String(key.itemId)}|${key.instalment}|${key.stage}`;
    const sentKeys = new Set(sent.map(keyOf));
    for (const reminder of plan.reminders) reminders.push({ ...reminder, outcome: sentKeys.has(keyOf(reminder)) ? "already_sent" : "would_send" });
  }

  const counts = countsOf(reminders, plan.skipped);
  log(counts.failed ? "warn" : "info", "repayment_reminders", { traceId, write: options.write, today: plan.today, items: plan.items, ...counts });
  return { ...plan, traceId, reminders, counts };
};

/**
 * When a day's run may start, in Lagos hours. A run starts at 08:00 so an alert never wakes anyone,
 * and one that is still owed at 20:00 (the service was down all day) waits for the next morning.
 */
export const SEND_FROM_HOUR = 8;
export const SEND_UNTIL_HOUR = 20;
const TICK_MS = 15 * 60 * 1000;

/**
 * Decides, each tick, whether today's run is still owed. A run with failures stays owed, so it is
 * tried again next tick. A restart forgets `doneOn` and runs once more, which sends nothing twice.
 * A tick never rejects: an unhandled rejection stops the whole API (Server.ts).
 */
export const createReminderSchedule = (options: {
  run: (now: Date) => Promise<Pick<ReminderRunReport, "counts">>;
  now?: () => Date;
}) => {
  const clock = options.now ?? (() => new Date());
  let doneOn: string | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    const now = clock();
    const today = lagosDate(now);
    const hour = lagosHour(now);
    if (running || doneOn === today || hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) return;
    running = true;
    try {
      const { counts } = await options.run(now);
      if (counts.failed === 0) doneOn = today;
    } catch (error) {
      log("error", "repayment_reminders_failed", { today, message: (error as Error).message.slice(0, 200) });
    } finally {
      running = false;
    }
  };
  return { tick };
};

/** Starts the daily job inside the API when it is switched on. Returns how to stop it, or null. */
export const startRepaymentReminders = (): (() => void) | null => {
  if (!config.repaymentRemindersEnabled) return null;
  if (!config.eventsEnabled) {
    log("warn", "repayment_reminders_off", { reason: "REPAYMENT_REMINDERS_ENABLED needs EVENTS_ENABLED, because a reminder is an event" });
    return null;
  }
  const schedule = createReminderSchedule({ run: (now) => runRepaymentReminders({ now, write: true }) });
  void schedule.tick();
  const timer = setInterval(() => void schedule.tick(), TICK_MS);
  timer.unref();
  log("info", "repayment_reminders_scheduled", { fromHourLagos: SEND_FROM_HOUR, untilHourLagos: SEND_UNTIL_HOUR, tickMs: TICK_MS });
  return () => clearInterval(timer);
};
