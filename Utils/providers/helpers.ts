import type { FinanceProvider } from "./types.js";
import { getAllProviderSlugs, getDefaultProvider, getProvider, resolveProvider } from "./registry.js";

export const normalizeProviderSlug = (value: unknown): string =>
  String(value ?? "").trim().toLowerCase();

export const getReadProvider = (value: unknown): FinanceProvider =>
  resolveProvider(normalizeProviderSlug(value));

export const getWriteProvider = (value: unknown): FinanceProvider => {
  const slug = normalizeProviderSlug(value);
  if (!slug) return getDefaultProvider();

  const provider = getProvider(slug);
  if (!provider) {
    throw new Error(`Unsupported provider. Expected one of: ${getAllProviderSlugs().join(", ")}`);
  }

  return provider;
};

export const buildProviderQueryConditions = (
  provider: Pick<FinanceProvider, "slug">
): Array<Record<string, unknown>> => {
  const defaultProvider = getDefaultProvider();

  if (provider.slug === defaultProvider.slug) {
    return [{ provider: provider.slug }, { provider: { $exists: false } }, { provider: null }];
  }

  return [{ provider: provider.slug }];
};

export const appendProviderFilter = <T extends Record<string, any>>(
  filter: T,
  provider: Pick<FinanceProvider, "slug">
): T => {
  const mutableFilter = filter as Record<string, unknown>;
  const conditions = buildProviderQueryConditions(provider);

  if (conditions.length === 1) {
    mutableFilter.provider = provider.slug;
    return filter;
  }

  const currentAnd = Array.isArray(mutableFilter.$and) ? (mutableFilter.$and as unknown[]) : [];
  mutableFilter.$and = [...currentAnd, { $or: conditions }];
  return filter;
};

export const buildPricingProviderQueryConditions = (
  provider: Pick<FinanceProvider, "slug" | "pricingProviderSlugs">
): Array<Record<string, unknown>> => {
  const defaultProvider = getDefaultProvider();
  const seen = new Set<string>();
  const conditions: Array<Record<string, unknown>> = [];

  for (const pricingProviderSlug of provider.pricingProviderSlugs || [provider.slug]) {
    const normalizedSlug = normalizeProviderSlug(pricingProviderSlug);
    if (!normalizedSlug || seen.has(normalizedSlug)) continue;

    seen.add(normalizedSlug);
    conditions.push({ provider: normalizedSlug });

    if (normalizedSlug === defaultProvider.slug) {
      conditions.push({ provider: { $exists: false } }, { provider: null });
    }
  }

  return conditions.length ? conditions : [{ provider: provider.slug }];
};

export const appendPricingProviderFilter = <T extends Record<string, any>>(
  filter: T,
  provider: Pick<FinanceProvider, "slug" | "pricingProviderSlugs">
): T => {
  const mutableFilter = filter as Record<string, unknown>;
  const conditions = buildPricingProviderQueryConditions(provider);

  if (conditions.length === 1 && typeof conditions[0]?.provider === "string") {
    mutableFilter.provider = conditions[0].provider;
    return filter;
  }

  const currentAnd = Array.isArray(mutableFilter.$and) ? (mutableFilter.$and as unknown[]) : [];
  mutableFilter.$and = [...currentAnd, { $or: conditions }];
  return filter;
};

export const sortPricingDocsByProviderPrecedence = <
  T extends {
    provider?: unknown;
  },
>(
  docs: T[],
  provider: Pick<FinanceProvider, "pricingProviderSlugs">
): T[] => {
  const precedence = new Map<string, number>();

  for (const [index, providerSlug] of (provider.pricingProviderSlugs || []).entries()) {
    precedence.set(normalizeProviderSlug(providerSlug), index);
  }

  return [...docs].sort((left, right) => {
    const leftProvider = normalizeProviderSlug(left.provider);
    const rightProvider = normalizeProviderSlug(right.provider);
    const leftRank = precedence.get(leftProvider) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = precedence.get(rightProvider) ?? Number.MAX_SAFE_INTEGER;

    return rightRank - leftRank;
  });
};
