import { EASYBUY_CATALOG_MAP, normalizeCapacityInput } from "./EasyBuyCatalog.js";

export type EasyBuyPricingDocLike = {
  model?: unknown;
  capacity?: unknown;
  price?: unknown;
};

export type EasyBuyPriceLookup = Map<string, Record<string, number>>;

const normalizeModelInput = (value: unknown): string => String(value ?? "").trim();

export const isValidCatalogModelCapacity = (model: string, capacity: string): boolean => {
  const entry = EASYBUY_CATALOG_MAP.get(model);
  if (!entry) return false;
  return entry.capacities.includes(capacity);
};

export const buildEasyBuyPriceLookup = (docs: EasyBuyPricingDocLike[]): EasyBuyPriceLookup => {
  const lookup: EasyBuyPriceLookup = new Map();

  for (const doc of docs || []) {
    const model = normalizeModelInput(doc?.model);
    const capacity = normalizeCapacityInput(doc?.capacity);
    const price = Number(doc?.price);

    if (!model || !capacity) continue;
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!isValidCatalogModelCapacity(model, capacity)) continue;

    const modelPrices = lookup.get(model) || {};
    modelPrices[capacity] = Number(price.toFixed(2));
    lookup.set(model, modelPrices);
  }

  return lookup;
};

export const getModelPricesByCapacity = (
  lookup: EasyBuyPriceLookup,
  model: string
): Record<string, number> => ({
  ...(lookup.get(model) || {}),
});

export const normalizePricingUpdateInput = (payload: {
  model?: unknown;
  capacity?: unknown;
  price?: unknown;
}) => {
  const model = normalizeModelInput(payload?.model);
  const capacity = normalizeCapacityInput(payload?.capacity);
  const price = Number(payload?.price);

  return { model, capacity, price };
};
