import type { PriceLookup, PricingDocLike } from "./providers/types.js";
import { aurapay } from "./providers/aurapay/index.js";

export type EasyBuyPricingDocLike = PricingDocLike;

export type EasyBuyPriceLookup = PriceLookup;

const normalizeModelInput = (value: unknown): string => String(value ?? "").trim();

export const buildEasyBuyPriceLookup = aurapay.buildPriceLookup;

export const getModelPricesByCapacity = aurapay.getModelPrices;

export const isValidCatalogModelCapacity = aurapay.isValidModelCapacity;

export const normalizePricingUpdateInput = (payload: {
  model?: unknown;
  capacity?: unknown;
  price?: unknown;
}) => {
  const model = normalizeModelInput(payload?.model);
  const capacity = aurapay.normalizeCapacityInput(payload?.capacity);
  const price = Number(payload?.price);

  return { model, capacity, price };
};
