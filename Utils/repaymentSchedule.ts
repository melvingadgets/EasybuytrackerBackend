import { multiplyKobo, splitInstalments, type Kobo } from "@melvingadgets/platform-kit";
import type { ReminderStage } from "../Model/RepaymentReminderModel.js";
import { getProvider } from "./providers/registry.js";
import { toKobo } from "./serviceFee.js";

// Which repayment reminders are due today (Shortwork/docs/notifications.md §13). Pure: no database
// and no clock, so every date and money rule here is tested directly.
//
// EasyBuy stores no instalment schedule. It is derived from the item the same way the customer's
// dashboard derives it (DashboardController.getNormalizedItemSchedule): the first instalment falls
// one interval after the item was created, then one every interval (7 days on a weekly plan, 30 on
// a monthly one). A reminder that named another date than the dashboard would be worse than none.

export const UPCOMING_DAYS = 3;

const LAGOS_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" });
const LAGOS_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", hourCycle: "h23" });

/** The calendar date in Lagos at this instant: "2026-11-05". */
export const lagosDate = (at: Date): string => LAGOS_DATE.format(at);

/** The hour in Lagos at this instant, 0–23. */
export const lagosHour = (at: Date): number => Number(LAGOS_HOUR.format(at));

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Calendar arithmetic on a "YYYY-MM-DD" date. Lagos has no daylight saving, so a day is always a day. */
export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);

export interface ScheduleItem {
  _id: unknown;
  createdAt: Date;
  provider?: string | null;
  Plan?: string | null;
  monthlyPlan?: number | null;
  weeklyPlan?: number | null;
  loanedAmount?: number | null;
  PhonePrice?: number | null;
  TotalPrice?: number | null;
  downPayment?: number | null;
}

export interface Instalment {
  itemId: string;
  instalment: number;
  dueOn: string;
  amountKobo: Kobo;
}

// The dashboard's fallback for items older than the loanedAmount field.
const financedNaira = (item: ScheduleItem): number =>
  typeof item.loanedAmount === "number" && Number.isFinite(item.loanedAmount)
    ? Math.max(item.loanedAmount, 0)
    : Math.max(Number(item.PhonePrice ?? item.TotalPrice ?? 0) - Number(item.downPayment ?? 0), 0);

/**
 * Every instalment of an item, or null when its plan can't be priced: no plan length, or a length
 * its provider doesn't offer. Nobody is told an amount this code had to guess.
 *
 * The markup is the item's own provider's. The dashboard applies AuraPay's table to Swift Device
 * loans too (a known bug, kept at the owner's request; EasybuytrackerBackend/AGENTS.md), and that
 * isn't copied here: a reminder asks a customer for money, so it uses the rate they signed up to.
 */
export const instalmentsOf = (item: ScheduleItem): Instalment[] | null => {
  const provider = getProvider(item.provider || "aurapay");
  if (!provider) return null;

  const weekly = item.Plan === "Weekly";
  if (!weekly && item.Plan !== "Monthly") return null;
  const count = Number(weekly ? item.weeklyPlan : item.monthlyPlan);
  const markup = (weekly ? provider.planRules.weeklyMarkupMultipliers : provider.planRules.monthlyMarkupMultipliers)[String(count)];
  if (!Number.isInteger(count) || count < 1 || markup === undefined) return null;

  const intervalDays = weekly ? 7 : 30;
  const start = lagosDate(item.createdAt);
  const total = multiplyKobo(toKobo(financedNaira(item)), String(markup));
  return splitInstalments(total, count).map((amountKobo, index) => ({
    itemId: String(item._id),
    instalment: index + 1,
    dueOn: addDays(start, (index + 1) * intervalDays),
    amountKobo,
  }));
};

export interface UnpaidInstalment extends Omit<Instalment, "amountKobo"> {
  /** What is still unpaid on this instalment, never more than the instalment and never zero. */
  amountKobo: number;
}

/**
 * Applies what one account has paid to its instalments, oldest due date first, and returns the ones
 * left with something unpaid. Receipts aren't tied to an instalment or an item, so this is the
 * dashboard's rule too: all of an account's payments count against all of its items.
 */
export const unpaidInstalments = (instalments: readonly Instalment[], paidKobo: number): UnpaidInstalment[] => {
  const ordered = [...instalments].sort(
    (a, b) => a.dueOn.localeCompare(b.dueOn) || a.itemId.localeCompare(b.itemId) || a.instalment - b.instalment
  );
  let left = Math.max(paidKobo, 0);
  const unpaid: UnpaidInstalment[] = [];
  for (const instalment of ordered) {
    const covered = Math.min(left, instalment.amountKobo);
    left -= covered;
    if (instalment.amountKobo > covered) unpaid.push({ ...instalment, amountKobo: instalment.amountKobo - covered });
  }
  return unpaid;
};

export interface PlannedReminder extends UnpaidInstalment {
  stage: ReminderStage;
}

/**
 * The reminders today calls for, across one account's unpaid instalments.
 *
 * Each instalment is judged by the stage it is in today, not the stages it passed, so a missed day
 * sends the current reminder only. Overdue goes to the most recently missed instalment of an item:
 * every instalment still gets its overdue notice as it lapses, but someone with four old ones when
 * reminders first start, or after an outage, hears about one rather than four at once.
 */
export const remindersFor = (unpaid: readonly UnpaidInstalment[], today: string): PlannedReminder[] => {
  const latestOverdue = new Map<string, UnpaidInstalment>();
  const reminders: PlannedReminder[] = [];
  for (const instalment of unpaid) {
    if (instalment.dueOn < today) {
      const seen = latestOverdue.get(instalment.itemId);
      if (!seen || seen.instalment < instalment.instalment) latestOverdue.set(instalment.itemId, instalment);
    } else if (instalment.dueOn === today) {
      reminders.push({ ...instalment, stage: "due" });
    } else if (instalment.dueOn <= addDays(today, UPCOMING_DAYS)) {
      reminders.push({ ...instalment, stage: "upcoming" });
    }
  }
  for (const instalment of latestOverdue.values()) reminders.push({ ...instalment, stage: "overdue" });
  return reminders;
};
