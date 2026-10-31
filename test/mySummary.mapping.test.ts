import { describe, expect, it } from "vitest";
import { toSummaryItem, toSummaryReceipt } from "../Controller/MySummaryController.js";

// The two rules that must not drift in the Profile app's EasyBuy summary (2026-10-30), tested as a
// pure function so they need no database:
//   1. Money leaves as integer kobo (AGENTS.md §4.1). EasyBuy stores naira FLOATS, so this is the
//      one place the conversion happens.
//   2. The privacy boundary: no receipt file URL, no NIN, no statement, no email.
//
// The query side (which items belong to a person) lives in the handler and is covered by the
// route's own test when a replica set is available.

const baseItem = {
  _id: "65f000000000000000000001",
  IphoneModel: "iPhone 13",
  IphoneImageUrl: "https://cdn.test/iphone13.png",
  capacity: "128GB",
  Plan: "Monthly",
  PhonePrice: 1_200_000.5,
  downPayment: 480_000.25,
  loanedAmount: 720_000,
  serviceFeeKobo: 5_760_000,
  monthlyPlan: 12,
  sourceRequestId: "EBR-test-1",
  createdAt: new Date("2026-10-01T10:00:00.000Z"),
};

describe("toSummaryItem", () => {
  it("converts every naira field to integer kobo", () => {
    const item = toSummaryItem(baseItem);
    expect(item.phonePriceKobo).toBe(120_000_050);
    expect(item.downPaymentKobo).toBe(48_000_025);
    expect(item.financedKobo).toBe(72_000_000);
    // An already-kobo field is passed through untouched.
    expect(item.serviceFeeKobo).toBe(5_760_000);
  });

  it("never emits a non-integer number anywhere", () => {
    const item = toSummaryItem(baseItem);
    // Every numeric field, by name — an ISO timestamp legitimately contains "10:00:00.000", so a
    // blanket regex over the JSON would flag the clock rather than a money leak.
    const numericKeys = ["phonePriceKobo", "downPaymentKobo", "financedKobo", "serviceFeeKobo", "monthlyPlan", "weeklyPlan"] as const;
    for (const key of numericKeys) {
      const value = item[key];
      if (typeof value === "number") expect(Number.isSafeInteger(value), key).toBe(true);
    }
    // And the money fields specifically are integers, whatever else changes.
    for (const key of ["phonePriceKobo", "downPaymentKobo", "financedKobo", "serviceFeeKobo"] as const) {
      expect(Number.isSafeInteger(item[key]), key).toBe(true);
    }
  });

  it("defaults a missing money field to 0 rather than NaN or undefined", () => {
    const item = toSummaryItem({ _id: "x", IphoneModel: "iPhone 12" });
    expect(item.phonePriceKobo).toBe(0);
    expect(item.downPaymentKobo).toBe(0);
    expect(item.financedKobo).toBe(0);
    expect(item.serviceFeeKobo).toBe(0);
    expect(Number.isNaN(item.phonePriceKobo)).toBe(false);
  });

  it("treats a legacy item without a service fee as zero, not a missing key", () => {
    const item = toSummaryItem({ _id: "x", IphoneModel: "iPhone 11", PhonePrice: 500_000, downPayment: 200_000, loanedAmount: 300_000 });
    expect(item.serviceFeeKobo).toBe(0);
  });

  it("carries the customer-recognisable fields and nothing sensitive", () => {
    const item = toSummaryItem(baseItem);
    expect(item.model).toBe("iPhone 13");
    expect(item.capacity).toBe("128GB");
    expect(item.plan).toBe("Monthly");
    expect(item.requestId).toBe("EBR-test-1");
    expect(item.createdAt).toBe("2026-10-01T10:00:00.000Z");
    // The NIN and the documents live in another collection and must never ride along.
    expect(JSON.stringify(item).toLowerCase()).not.toContain("nin");
    expect(JSON.stringify(item).toLowerCase()).not.toContain("statement");
  });
});

describe("toSummaryReceipt", () => {
  const baseReceipt = {
    _id: "65f000000000000000000002",
    amount: 86_400.5,
    status: "pending",
    createdAt: new Date("2026-10-02T09:00:00.000Z"),
    rejectionReason: undefined,
  };

  it("converts the naira amount to kobo", () => {
    expect(toSummaryReceipt(baseReceipt).amountKobo).toBe(8_640_050);
  });

  it("drops the file URL even if the document carries one", () => {
    const receipt = toSummaryReceipt({ ...baseReceipt, fileUrl: "https://res.cloudinary.test/secret.png", cloudinaryPublicId: "secret" } as never);
    expect(receipt).not.toHaveProperty("fileUrl");
    expect(JSON.stringify(receipt)).not.toContain("cloudinary");
  });

  it("keeps the decision, so the app can explain a rejection", () => {
    const receipt = toSummaryReceipt({ ...baseReceipt, status: "rejected", rejectedAt: new Date("2026-10-03T09:00:00.000Z"), rejectionReason: "Blurry photo" });
    expect(receipt.status).toBe("rejected");
    expect(receipt.rejectedAt).toBe("2026-10-03T09:00:00.000Z");
    expect(receipt.rejectionReason).toBe("Blurry photo");
  });

  it("defaults a missing amount to 0, not NaN", () => {
    expect(toSummaryReceipt({ _id: "x" }).amountKobo).toBe(0);
  });
});
