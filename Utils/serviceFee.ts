import { nairaToKobo, percentOfKobo, type Kobo } from "@melvingadgets/platform-kit";
import { config } from "../config/Config.js";

// The EasyBuy service charge (RESELLER-PLAN.md §8b). One place computes it, in integer kobo
// with the kit's half-up rounding (Shortwork/AGENTS.md §4.1, §4.2). EasyBuy still stores
// naira amounts as plain numbers, so they are fixed to two decimals before conversion.

export type ServiceFeeBase = "financed" | "price";

export interface ServiceFee {
  serviceFeeKobo: Kobo;
  serviceFeeBps: number;
  serviceFeeBase: ServiceFeeBase;
  /** The amount the rate was applied to. */
  baseKobo: Kobo;
}

export const toKobo = (naira: number): Kobo => nairaToKobo(Number(naira).toFixed(2));

export const computeServiceFee = (
  amounts: { phonePrice: number; loanedAmount: number },
  rule: { bps: number; base: ServiceFeeBase } = config.serviceFee,
): ServiceFee => {
  const baseKobo = toKobo(rule.base === "price" ? amounts.phonePrice : amounts.loanedAmount);
  return {
    serviceFeeKobo: percentOfKobo(baseKobo, (rule.bps / 100).toString()),
    serviceFeeBps: rule.bps,
    serviceFeeBase: rule.base,
    baseKobo,
  };
};

/** What Apply shows before someone applies: the rate and what it's charged on. */
export const publicServiceFeeRule = () => ({
  bps: config.serviceFee.bps,
  base: config.serviceFee.base,
  refundable: false,
});
