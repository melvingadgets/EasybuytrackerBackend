export type PlanType = "Monthly" | "Weekly";

export type CatalogEntry = {
  model: string;
  imageUrl: string;
  capacities: string[];
  allowedPlans: PlanType[];
  downPaymentPercentage: number;
};

export type DownPaymentThreshold = {
  minPrice: number;
  percentage: number;
};

export type DownPaymentRule =
  | {
      type: "fixed_per_model";
    }
  | {
      type: "price_threshold";
      thresholds: DownPaymentThreshold[];
    }
  | {
      type: "flat";
      percentage: number;
    };

export type PlanRules = {
  monthlyDurations: number[];
  weeklyDurations: number[];
  monthlyMarkupMultipliers: Record<string, number>;
  weeklyMarkupMultipliers: Record<string, number>;
  downPaymentRule?: DownPaymentRule;
};

export type PricingDocLike = {
  model?: unknown;
  capacity?: unknown;
  price?: unknown;
};

export type PriceLookup = Map<string, Record<string, number>>;

export interface FinanceProvider {
  slug: string;
  displayName: string;
  catalog: CatalogEntry[];
  catalogMap: Map<string, CatalogEntry>;
  planRules: PlanRules;
  pricingProviderSlugs: string[];
  isValidModelCapacity(model: string, capacity: string): boolean;
  buildPriceLookup(docs: PricingDocLike[]): PriceLookup;
  getModelPrices(lookup: PriceLookup, model: string): Record<string, number>;
  normalizeCapacityInput(value: unknown): string;
  resolveDownPaymentPercentage(model: string, price: number): number;
}

export const createProvider = ({
  slug,
  displayName,
  catalog,
  planRules,
  pricingProviderSlugs,
}: {
  slug: string;
  displayName: string;
  catalog: CatalogEntry[];
  planRules: PlanRules;
  pricingProviderSlugs?: string[];
}): FinanceProvider => {
  const frozenCatalog = catalog.map((entry) => ({
    ...entry,
    capacities: [...entry.capacities],
    allowedPlans: [...entry.allowedPlans],
  }));

  const frozenPlanRules: PlanRules = {
    monthlyDurations: [...planRules.monthlyDurations],
    weeklyDurations: [...planRules.weeklyDurations],
    monthlyMarkupMultipliers: { ...planRules.monthlyMarkupMultipliers },
    weeklyMarkupMultipliers: { ...planRules.weeklyMarkupMultipliers },
    ...(planRules.downPaymentRule
      ? {
          downPaymentRule:
            planRules.downPaymentRule.type === "price_threshold"
              ? {
                  type: "price_threshold" as const,
                  thresholds: planRules.downPaymentRule.thresholds.map((threshold) => ({
                    minPrice: threshold.minPrice,
                    percentage: threshold.percentage,
                  })),
                }
              : planRules.downPaymentRule.type === "flat"
                ? {
                    type: "flat" as const,
                    percentage: planRules.downPaymentRule.percentage,
                  }
              : { type: "fixed_per_model" as const },
        }
      : {}),
  };

  const resolvedPricingProviderSlugs = Array.from(
    new Set(
      (pricingProviderSlugs?.length ? pricingProviderSlugs : [slug]).map((providerSlug) =>
        String(providerSlug || "").trim().toLowerCase()
      )
    )
  ).filter(Boolean);

  const catalogMap = new Map<string, CatalogEntry>(
    frozenCatalog.map((e) => [e.model, e])
  );

  const normalizeCapacityInput = (value: unknown): string => {
    const trimmed = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!trimmed) return "";
    if (/^\d+$/.test(trimmed)) {
      return `${trimmed}GB`;
    }
    return trimmed;
  };

  const isValidModelCapacity = (model: string, capacity: string): boolean => {
    const entry = catalogMap.get(model);
    if (!entry) return false;
    return entry.capacities.includes(capacity);
  };

  const buildPriceLookup = (docs: PricingDocLike[]): PriceLookup => {
    const lookup: PriceLookup = new Map();

    for (const doc of docs || []) {
      const model = String(doc?.model ?? "").trim();
      const capacity = normalizeCapacityInput(doc?.capacity);
      const price = Number(doc?.price);

      if (!model || !capacity) continue;
      if (!Number.isFinite(price) || price <= 0) continue;
      if (!isValidModelCapacity(model, capacity)) continue;

      const modelPrices = lookup.get(model) || {};
      modelPrices[capacity] = Number(price.toFixed(2));
      lookup.set(model, modelPrices);
    }

    return lookup;
  };

  const getModelPrices = (
    lookup: PriceLookup,
    model: string
  ): Record<string, number> => ({
    ...(lookup.get(model) || {}),
  });

  const resolveDownPaymentPercentage = (model: string, price: number): number => {
    const rule = frozenPlanRules.downPaymentRule;

    if (rule?.type === "flat") {
      const flat = Number(rule.percentage);
      return Number.isFinite(flat) && flat > 0 ? flat : 0;
    }

    if (rule?.type === "price_threshold") {
      const matchedThreshold = [...rule.thresholds]
        .sort((a, b) => b.minPrice - a.minPrice)
        .find((threshold) => price >= threshold.minPrice);

      const thresholdPercentage = Number(matchedThreshold?.percentage);
      return Number.isFinite(thresholdPercentage) && thresholdPercentage > 0
        ? thresholdPercentage
        : 0;
    }

    const catalogEntry = catalogMap.get(model);
    const fixedPercentage = Number(catalogEntry?.downPaymentPercentage);
    return Number.isFinite(fixedPercentage) && fixedPercentage > 0 ? fixedPercentage : 0;
  };

  return {
    slug,
    displayName,
    catalog: frozenCatalog,
    catalogMap,
    planRules: frozenPlanRules,
    pricingProviderSlugs: resolvedPricingProviderSlugs,
    isValidModelCapacity,
    buildPriceLookup,
    getModelPrices,
    normalizeCapacityInput,
    resolveDownPaymentPercentage,
  };
};
