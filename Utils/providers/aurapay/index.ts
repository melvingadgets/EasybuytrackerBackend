import { createProvider } from "../types.js";
import { AURAPAY_CATALOG, AURAPAY_PLAN_RULES } from "./catalog.js";

export const aurapay = createProvider({
  slug: "aurapay",
  displayName: "AuraPay",
  catalog: AURAPAY_CATALOG,
  planRules: AURAPAY_PLAN_RULES,
});
