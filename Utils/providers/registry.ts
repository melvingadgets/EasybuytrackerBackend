import type { FinanceProvider } from "./types.js";
import { aurapay } from "./aurapay/index.js";
import { swiftdevice } from "./swiftdevice/index.js";

const PROVIDERS = new Map<string, FinanceProvider>([
  [aurapay.slug, aurapay],
  [swiftdevice.slug, swiftdevice],
]);

export const getProvider = (slug: string): FinanceProvider | undefined =>
  PROVIDERS.get(String(slug || "").trim().toLowerCase());

export const getDefaultProvider = (): FinanceProvider => aurapay;

export const getAllProviderSlugs = (): string[] => Array.from(PROVIDERS.keys());

export const resolveProvider = (slug: unknown): FinanceProvider => {
  const normalized = String(slug || "").trim().toLowerCase();
  if (!normalized) return getDefaultProvider();
  return getProvider(normalized) || getDefaultProvider();
};
