/**
 * run-repayment-reminders: run the daily repayment reminder job once by hand, and show what it does
 * (Shortwork/docs/notifications.md §13). The service runs the same job itself when
 * REPAYMENT_REMINDERS_ENABLED=true; this is how a run is previewed before switching that on.
 *
 * A dry run is the default: it reads, lists each reminder and writes nothing, not even the index.
 * --write sends, and prints a before/after count (Shortwork/AGENTS.md §7.3). Safe to repeat: the
 * unique index on (itemId, instalment, stage) refuses anything already sent.
 *
 * Run:
 *   DATABASE_URL=... PORT=0 JWT_SECRET=... npx tsx run-repayment-reminders.ts
 *   ...then add --write, which also needs EVENTS_ENABLED=true.
 * --today=YYYY-MM-DD previews another day, and is refused with --write: a reminder is only sent on
 * the day it is true. A database that isn't on this machine is refused unless --allow-remote is
 * given as well. Against production, dry-run first and write only with the owner's approval (§7.4).
 *
 * It finds its database in the environment and connects before anything reads .env, so it can't pick
 * up a shared cluster by accident. It prints ids, stages and amounts, never a name, email or phone.
 */
import mongoose from "mongoose";
import { isLocalDatabase } from "./Utils/localDatabase.js";

const env = (name: string) => String(process.env[name] ?? "").trim();
const databaseUrl = env("Database_url") || env("DATABASE_URL");
const WRITE = process.argv.includes("--write") && !process.argv.includes("--dry-run");
const ALLOW_REMOTE = process.argv.includes("--allow-remote");
const TODAY = process.argv.find((arg) => arg.startsWith("--today="))?.slice("--today=".length);
const MAX_LISTED = 50;

async function run(): Promise<void> {
  if (!databaseUrl) throw new Error("Database_url (or DATABASE_URL) is required");
  if (!ALLOW_REMOTE && !isLocalDatabase(databaseUrl)) {
    throw new Error("refusing a database that isn't on this machine; pass --allow-remote only if that is deliberate");
  }
  if (TODAY && WRITE) throw new Error("--today only previews; a real run always uses today's date");
  if (TODAY && !/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) throw new Error("--today must look like 2026-11-05");

  // autoIndex and autoCreate off, and the models imported only after connecting: a model compiled any
  // earlier would build its indexes on connect, and a dry run must not change the database at all.
  await mongoose.connect(databaseUrl, { autoIndex: false, autoCreate: false });
  console.log(`target: ${mongoose.connection.name} at ${mongoose.connection.host}${WRITE ? "" : " (dry run: nothing is written)"}`);

  const { config } = await import("./config/Config.js");
  if (WRITE && !config.eventsEnabled) throw new Error("--write needs EVENTS_ENABLED=true, because a reminder is an event");
  const { reminderIndexExists, runRepaymentReminders } = await import("./Service/RepaymentReminders.js");
  const RepaymentReminderModel = (await import("./Model/RepaymentReminderModel.js")).default;
  const { OUTBOX_COLLECTION } = await import("@melvingadgets/platform-kit");

  const counts = async () => ({
    reminders: await RepaymentReminderModel.countDocuments({}),
    events: await mongoose.connection.db!.collection(OUTBOX_COLLECTION).countDocuments({ type: "easybuy.repayment.due" }),
  });

  const before = await counts();
  console.log("before:", before);
  console.log(`reminder index: ${(await reminderIndexExists()) ? "present and unique" : WRITE ? "missing (building it first)" : "MISSING (--write builds it before sending)"}`);

  const report = await runRepaymentReminders({
    write: WRITE,
    ...(TODAY ? { now: new Date(`${TODAY}T12:00:00.000+01:00`) } : {}),
  });

  console.log(`today (Africa/Lagos): ${report.today}, ${report.items} financed item(s)`);
  console.log(`  ${WRITE ? "sent" : "would send"}: ${WRITE ? report.counts.sent : report.counts.would_send}`);
  console.log(`  already sent: ${report.counts.already_sent}`);
  console.log(`  failed: ${report.counts.failed}`);
  console.log(`  no platform person (left alone): ${report.counts.no_person}`);
  console.log(`  item's person isn't the account's (left alone): ${report.counts.person_mismatch}`);
  console.log(`  plan can't be priced (left alone): ${report.counts.unknown_plan}`);
  console.log(`  admin set a later due date (held): ${report.counts.on_hold}`);
  for (const reminder of report.reminders.slice(0, MAX_LISTED)) {
    console.log(`  ${reminder.outcome} ${reminder.stage} item ${reminder.itemId} instalment ${reminder.instalment} due ${reminder.dueOn} ${reminder.amountKobo} kobo person ${reminder.personId}`);
  }
  for (const skip of report.skipped.slice(0, MAX_LISTED)) {
    console.warn(`  ~ ${skip.reason}: item ${skip.itemId}${skip.instalment ? ` instalment ${skip.instalment} ${skip.stage}` : ""}`);
  }
  if (Math.max(report.reminders.length, report.skipped.length) > MAX_LISTED) console.log(`  (lists stop at ${MAX_LISTED}; the counts above are complete)`);

  const after = await counts();
  console.log("after:", after);
  // A reminder and its event commit together, so both move by the same amount. The service's own job
  // can add more while this runs, which isn't a fault.
  const reminders = after.reminders - before.reminders;
  const events = after.events - before.events;
  const reconciled = reminders === events && reminders >= (WRITE ? report.counts.sent : 0) && (WRITE || reminders === 0);
  console.log(reconciled ? `reconciliation: OK (${WRITE ? `${reminders} written, each with its event` : "no documents changed"})` : `reconciliation: MISMATCH (${reminders} reminders, ${events} events)`);

  await mongoose.disconnect();
  if (!reconciled || report.counts.failed > 0) process.exitCode = 1;
}

run().catch(async (error) => {
  console.error("run-repayment-reminders failed:", (error as Error).message);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
