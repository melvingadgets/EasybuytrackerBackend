import { describe, expect, it } from "vitest";
import {
  UPCOMING_DAYS,
  addDays,
  instalmentsOf,
  lagosDate,
  lagosHour,
  remindersFor,
  unpaidInstalments,
  type Instalment,
  type ScheduleItem,
  type UnpaidInstalment,
} from "../Utils/repaymentSchedule.js";

// The date and money rules of a repayment reminder (Shortwork/docs/notifications.md §13). A wrong
// answer here is a customer told the wrong amount, or told they're overdue when they aren't.

const item = (overrides: Partial<ScheduleItem> = {}): ScheduleItem => ({
  _id: "item-1",
  createdAt: new Date("2026-10-06T09:00:00.000+01:00"),
  provider: "aurapay",
  Plan: "Monthly",
  monthlyPlan: 3,
  loanedAmount: 300_000,
  ...overrides,
});

const sum = (amounts: readonly { amountKobo: number }[]) => amounts.reduce((total, { amountKobo }) => total + amountKobo, 0);

describe("Lagos dates", () => {
  it("rolls to the next day an hour before UTC does", () => {
    expect(lagosDate(new Date("2026-11-01T22:59:59.000Z"))).toBe("2026-11-01");
    expect(lagosDate(new Date("2026-11-01T23:00:00.000Z"))).toBe("2026-11-02");
    expect(lagosHour(new Date("2026-11-01T06:59:00.000Z"))).toBe(7);
    expect(lagosHour(new Date("2026-11-01T07:00:00.000Z"))).toBe(8);
    expect(lagosHour(new Date("2026-11-01T23:00:00.000Z"))).toBe(0);
  });

  it("adds days across a month, a year and a leap day", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-11-05", 0)).toBe("2026-11-05");
  });
});

describe("instalmentsOf", () => {
  it("prices a plan with the provider's markup, in kobo, one interval apart from the creation date", () => {
    // ₦300,000 financed × 1.6 for 3 months = ₦480,000 = 3 × ₦160,000.
    expect(instalmentsOf(item())).toEqual([
      { itemId: "item-1", instalment: 1, dueOn: "2026-11-05", amountKobo: 16_000_000 },
      { itemId: "item-1", instalment: 2, dueOn: "2026-12-05", amountKobo: 16_000_000 },
      { itemId: "item-1", instalment: 3, dueOn: "2027-01-04", amountKobo: 16_000_000 },
    ]);
  });

  it("makes a weekly plan's instalments a week apart", () => {
    const schedule = instalmentsOf(item({ Plan: "Weekly", weeklyPlan: 4, monthlyPlan: null, loanedAmount: 100_000 }));
    expect(schedule?.map(({ dueOn }) => dueOn)).toEqual(["2026-10-13", "2026-10-20", "2026-10-27", "2026-11-03"]);
    // ₦100,000 × 1.2 = ₦120,000 over 4 weeks.
    expect(schedule?.every(({ amountKobo }) => amountKobo === 3_000_000)).toBe(true);
  });

  it("counts the due date from the Lagos day the item was created, not the UTC day", () => {
    // 23:30 UTC on 8 October is already 9 October in Lagos.
    const schedule = instalmentsOf(item({ createdAt: new Date("2026-10-08T23:30:00.000Z") }));
    expect(schedule?.[0]?.dueOn).toBe("2026-11-08");
  });

  it("lets the last instalment absorb the remainder, so they add up exactly (AGENTS.md §4.2)", () => {
    // ₦100,000.01 × 1.4 = 14_000_001.4 kobo → 14_000_001 over 8 weeks: 1_750_000 × 7 + 1_750_001.
    const schedule = instalmentsOf(item({ Plan: "Weekly", weeklyPlan: 8, loanedAmount: 100_000.01 })) as Instalment[];
    expect(schedule.map(({ amountKobo }) => amountKobo)).toEqual([...Array(7).fill(1_750_000), 1_750_001]);
    expect(sum(schedule)).toBe(14_000_001);
  });

  it("always adds up to the total in integer kobo, whatever the financed amount", () => {
    // Seeded so a failure repeats.
    let seed = 20261101;
    const next = () => (seed = (seed * 48271) % 2147483647);
    const plans = [
      { Plan: "Monthly", monthlyPlan: 1, markup: 120 },
      { Plan: "Monthly", monthlyPlan: 2, markup: 140 },
      { Plan: "Monthly", monthlyPlan: 3, markup: 160 },
      { Plan: "Weekly", weeklyPlan: 4, markup: 120 },
      { Plan: "Weekly", weeklyPlan: 8, markup: 140 },
      { Plan: "Weekly", weeklyPlan: 12, markup: 150 },
    ];
    for (let run = 0; run < 2_000; run += 1) {
      const financedKobo = next() % 300_000_000;
      const { markup, ...plan } = plans[next() % plans.length]!;
      const schedule = instalmentsOf(item({ ...plan, loanedAmount: financedKobo / 100 })) as Instalment[];
      expect(sum(schedule)).toBe(Math.round((financedKobo * markup) / 100));
      expect(schedule.every(({ amountKobo }) => Number.isSafeInteger(amountKobo) && amountKobo >= 0)).toBe(true);
      const [first] = schedule;
      expect(schedule.slice(0, -1).every(({ amountKobo }) => amountKobo === first!.amountKobo)).toBe(true);
    }
  });

  it("uses Swift Device's own rate, not the AuraPay table the dashboard applies to it", () => {
    // ₦300,000 × 1.16 = ₦348,000 over 3 months. The dashboard's table would say ₦480,000.
    const schedule = instalmentsOf(item({ provider: "swiftdevice" })) as Instalment[];
    expect(schedule.map(({ amountKobo }) => amountKobo)).toEqual([11_600_000, 11_600_000, 11_600_000]);
  });

  it("treats an item with no provider as AuraPay, the schema's default", () => {
    expect(instalmentsOf(item({ provider: null }))?.[0]?.amountKobo).toBe(16_000_000);
  });

  it("falls back to price minus down payment for an item older than loanedAmount", () => {
    const schedule = instalmentsOf(item({ loanedAmount: null, PhonePrice: 500_000, downPayment: 200_000 })) as Instalment[];
    expect(sum(schedule)).toBe(48_000_000);
    const older = instalmentsOf(item({ loanedAmount: null, TotalPrice: 500_000, downPayment: 200_000 })) as Instalment[];
    expect(sum(older)).toBe(48_000_000);
  });

  it("refuses to guess at a plan it can't price", () => {
    expect(instalmentsOf(item({ monthlyPlan: 12 }))).toBeNull();
    expect(instalmentsOf(item({ monthlyPlan: 0 }))).toBeNull();
    expect(instalmentsOf(item({ monthlyPlan: null }))).toBeNull();
    expect(instalmentsOf(item({ Plan: "Weekly", weeklyPlan: 5 }))).toBeNull();
    expect(instalmentsOf(item({ Plan: "Daily" }))).toBeNull();
    expect(instalmentsOf(item({ Plan: null }))).toBeNull();
    expect(instalmentsOf(item({ provider: "nobody" }))).toBeNull();
    // Swift Device offers no weekly plan.
    expect(instalmentsOf(item({ provider: "swiftdevice", Plan: "Weekly", weeklyPlan: 4 }))).toBeNull();
  });
});

const instalment = (itemId: string, n: number, dueOn: string, amountKobo = 100): Instalment => ({
  itemId,
  instalment: n,
  dueOn,
  amountKobo: amountKobo as Instalment["amountKobo"],
});

describe("unpaidInstalments", () => {
  const three = [instalment("a", 1, "2026-11-05"), instalment("a", 2, "2026-12-05"), instalment("a", 3, "2027-01-04")];

  it("leaves everything owing when nothing is paid", () => {
    expect(unpaidInstalments(three, 0)).toEqual(three);
  });

  it("covers the oldest first, and an exact payment clears that instalment", () => {
    expect(unpaidInstalments(three, 100).map(({ instalment: n }) => n)).toEqual([2, 3]);
    expect(unpaidInstalments(three, 200).map(({ instalment: n }) => n)).toEqual([3]);
  });

  it("asks only for what is left of a part-paid instalment", () => {
    expect(unpaidInstalments(three, 130)).toEqual([
      { ...three[1], amountKobo: 70 },
      { ...three[2], amountKobo: 100 },
    ]);
  });

  it("owes nothing once everything is covered, and an overpayment changes nothing", () => {
    expect(unpaidInstalments(three, 300)).toEqual([]);
    expect(unpaidInstalments(three, 5_000)).toEqual([]);
  });

  it("spreads one account's payments across its items by due date, as the dashboard does", () => {
    const older = instalment("b", 1, "2026-10-20");
    expect(unpaidInstalments([...three, older], 100).map(({ itemId, instalment: n }) => `${itemId}${n}`)).toEqual(["a1", "a2", "a3"]);
  });

  it("never loses or invents a kobo, for any payment", () => {
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647);
    for (let run = 0; run < 2_000; run += 1) {
      const instalments = Array.from({ length: 1 + (next() % 12) }, (_, index) =>
        instalment(`i${next() % 3}`, index + 1, addDays("2026-11-01", next() % 200), 1 + (next() % 5_000_000))
      );
      const paid = next() % 30_000_000;
      const unpaid = unpaidInstalments(instalments, paid);
      expect(sum(unpaid)).toBe(Math.max(sum(instalments) - paid, 0));
      expect(unpaid.every(({ amountKobo }) => amountKobo > 0)).toBe(true);
    }
  });
});

describe("remindersFor", () => {
  const unpaid = (itemId: string, n: number, dueOn: string): UnpaidInstalment => instalment(itemId, n, dueOn);
  const stagesOn = (dueOn: string, today: string) => remindersFor([unpaid("a", 1, dueOn)], today).map(({ stage }) => stage);

  it("says nothing until three days before, then the stage for the day", () => {
    expect(UPCOMING_DAYS).toBe(3);
    expect(stagesOn("2026-11-05", "2026-11-01")).toEqual([]);
    expect(stagesOn("2026-11-05", "2026-11-02")).toEqual(["upcoming"]);
    expect(stagesOn("2026-11-05", "2026-11-05")).toEqual(["due"]);
    expect(stagesOn("2026-11-05", "2026-11-06")).toEqual(["overdue"]);
    expect(stagesOn("2026-11-05", "2027-03-01")).toEqual(["overdue"]);
  });

  it("still sends the current stage after a missed day, and only that one", () => {
    expect(stagesOn("2026-11-05", "2026-11-04")).toEqual(["upcoming"]);
  });

  it("works across a month end", () => {
    expect(stagesOn("2026-12-01", "2026-11-28")).toEqual(["upcoming"]);
    expect(stagesOn("2026-12-01", "2026-11-27")).toEqual([]);
  });

  it("chases only the latest missed instalment of an item, so old ones don't arrive in a burst", () => {
    const reminders = remindersFor(
      [unpaid("a", 1, "2026-10-01"), unpaid("a", 2, "2026-10-08"), unpaid("a", 3, "2026-10-15"), unpaid("b", 1, "2026-10-20")],
      "2026-11-01"
    );
    expect(reminders.map(({ itemId, instalment: n, stage }) => `${itemId}${n} ${stage}`).sort()).toEqual(["a3 overdue", "b1 overdue"]);
  });

  it("announces an overdue instalment and the next one's own stage side by side", () => {
    const reminders = remindersFor([unpaid("a", 1, "2026-10-29"), unpaid("a", 2, "2026-11-05")], "2026-11-03");
    expect(reminders.map(({ instalment: n, stage }) => `${n} ${stage}`).sort()).toEqual(["1 overdue", "2 upcoming"]);
  });

  it("sends nothing for an instalment that isn't in the unpaid list", () => {
    expect(remindersFor([], "2026-11-05")).toEqual([]);
  });

  it("carries the unpaid amount and the date through unchanged", () => {
    const [reminder] = remindersFor([{ ...unpaid("a", 2, "2026-11-05"), amountKobo: 70 }], "2026-11-05");
    expect(reminder).toEqual({ itemId: "a", instalment: 2, dueOn: "2026-11-05", amountKobo: 70, stage: "due" });
  });
});
