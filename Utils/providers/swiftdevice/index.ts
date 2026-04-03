import { createProvider } from "../types.js";
import { SWIFTDEVICE_CATALOG, SWIFTDEVICE_PLAN_RULES } from "./catalog.js";

export const swiftdevice = createProvider({
  slug: "swiftdevice",
  displayName: "Swift Device",
  catalog: SWIFTDEVICE_CATALOG,
  planRules: SWIFTDEVICE_PLAN_RULES,
  pricingProviderSlugs: ["swiftdevice", "aurapay"],
});
