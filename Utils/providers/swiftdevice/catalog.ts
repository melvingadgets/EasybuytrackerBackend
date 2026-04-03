import type { CatalogEntry, PlanRules, PlanType } from "../types.js";
import { AURAPAY_CATALOG } from "../aurapay/catalog.js";

const SWIFTDEVICE_ALLOWED_PLANS: PlanType[] = ["Monthly"];

export const SWIFTDEVICE_CATALOG: CatalogEntry[] = AURAPAY_CATALOG.map((entry) => ({
  ...entry,
  capacities: [...entry.capacities],
  allowedPlans: [...SWIFTDEVICE_ALLOWED_PLANS],
  downPaymentPercentage: 0,
}));

export const SWIFTDEVICE_PLAN_RULES: PlanRules = {
  monthlyDurations: [1, 2, 3, 4, 5],
  weeklyDurations: [],
  monthlyMarkupMultipliers: {
    "1": 1.14,
    "2": 1.15,
    "3": 1.16,
    "4": 1.17,
    "5": 1.18,
  },
  weeklyMarkupMultipliers: {},
  downPaymentRule: {
    type: "flat",
    percentage: 50,
  },
};
