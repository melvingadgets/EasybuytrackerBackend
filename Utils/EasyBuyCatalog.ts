import type { CatalogEntry, PlanRules, PlanType } from "./providers/types.js";
import { aurapay } from "./providers/aurapay/index.js";

export type EasyBuyPlanType = PlanType;
export type EasyBuyCatalogEntry = CatalogEntry;
export type EasyBuyPlanRules = PlanRules;

export const EASYBUY_CATALOG = aurapay.catalog;

export const EASYBUY_CATALOG_MAP = aurapay.catalogMap;

export const EASYBUY_PLAN_RULES = aurapay.planRules;

export const normalizeCapacityInput = aurapay.normalizeCapacityInput;
