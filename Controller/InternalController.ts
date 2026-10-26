import type { Request, Response } from "express";
import { MoneyError, isKobo, kobo, nairaToKobo, quoteInstalments, type Kobo } from "@melvingadgets/platform-kit";
import EasyBoughtItemModel from "../Model/EasyBoughtitem.js";
import PublicEasyBuyRequestModel from "../Model/PublicEasyBuyRequestModel.js";
import UserModel from "../Model/UserModel.js";
import { getProvider } from "../Utils/providers/registry.js";
import { toKobo } from "../Utils/serviceFee.js";
import type { PlanType } from "../Utils/providers/types.js";
import { buildSafePublicCatalog } from "./PublicEasyBuyController.js";

// Service-token routes for other platform services (Shortwork/AGENTS.md §2, §4.1).
// Money leaves this service only as integer kobo.

const providerFrom = (value: unknown) => getProvider(String(value ?? "aurapay"));

// GET /api/v1/internal/catalog?provider=aurapay  (scope easybuy:catalog.read)
export const GetInternalCatalog = async (req: Request, res: Response) => {
  const provider = providerFrom(req.query.provider);
  if (!provider) return res.status(400).json({ message: "unknown provider" });

  const catalog = await buildSafePublicCatalog(provider);
  return res.status(200).json({
    provider: catalog.provider,
    currency: "NGN",
    unit: "kobo",
    models: catalog.models.map((model) => ({
      model: model.model,
      imageUrl: model.imageUrl,
      capacities: model.capacities,
      allowedPlans: model.allowedPlans,
      downPaymentPercentage: model.downPaymentPercentage,
      pricesByCapacity: Object.fromEntries(
        Object.entries(model.pricesByCapacity).map(([capacity, naira]) => [capacity, nairaToKobo(String(naira))])
      ),
    })),
    planRules: {
      monthlyDurations: catalog.planRules.monthlyDurations,
      weeklyDurations: catalog.planRules.weeklyDurations,
      monthlyMarkupMultipliers: catalog.planRules.monthlyMarkupMultipliers,
      weeklyMarkupMultipliers: catalog.planRules.weeklyMarkupMultipliers,
    },
  });
};

const PLANS: readonly PlanType[] = ["Monthly", "Weekly"];

// GET /api/v1/internal/quote?provider&model&capacity&plan&duration[&downPayment=<kobo>]
// (scope easybuy:quote.read). The one instalment formula, from the platform kit
// (INTEGRATION-PLAN.md §5), so the store and every UI show the same numbers as EasyBuy.
export const GetInternalQuote = async (req: Request, res: Response) => {
  const provider = providerFrom(req.query.provider);
  if (!provider) return res.status(400).json({ message: "unknown provider" });

  const model = String(req.query.model ?? "").trim();
  const capacity = provider.normalizeCapacityInput(req.query.capacity);
  const plan = String(req.query.plan ?? "") as PlanType;
  const duration = Number(req.query.duration);

  const entry = provider.catalogMap.get(model);
  if (!entry || !provider.isValidModelCapacity(model, capacity)) {
    return res.status(400).json({ message: "unknown model or capacity for this provider" });
  }
  if (!PLANS.includes(plan) || !entry.allowedPlans.includes(plan)) {
    return res.status(400).json({ message: "plan not offered for this model" });
  }
  const durations = plan === "Weekly" ? provider.planRules.weeklyDurations : provider.planRules.monthlyDurations;
  const multipliers = plan === "Weekly" ? provider.planRules.weeklyMarkupMultipliers : provider.planRules.monthlyMarkupMultipliers;
  const markup = multipliers[String(duration)];
  if (!Number.isInteger(duration) || !durations.includes(duration) || markup === undefined) {
    return res.status(400).json({ message: "duration not offered for this plan" });
  }

  let requestedDownPayment: Kobo | undefined;
  if (req.query.downPayment !== undefined) {
    const raw = Number(req.query.downPayment);
    if (!isKobo(raw)) return res.status(400).json({ message: "downPayment must be a whole number of kobo" });
    requestedDownPayment = kobo(raw);
  }

  const catalog = await buildSafePublicCatalog(provider);
  const priceNaira = catalog.models.find((candidate) => candidate.model === model)?.pricesByCapacity[capacity];
  if (priceNaira === undefined) return res.status(404).json({ message: "no price set for this model and capacity" });

  const downPaymentPercentage = provider.resolveDownPaymentPercentage(model, priceNaira);
  try {
    const quote = quoteInstalments({
      phonePrice: nairaToKobo(String(priceNaira)),
      downPaymentPercent: String(downPaymentPercentage),
      requestedDownPayment,
      markup: String(markup),
      instalmentCount: duration,
    });
    return res.status(200).json({
      provider: provider.slug,
      model,
      capacity,
      plan,
      duration,
      currency: "NGN",
      unit: "kobo",
      downPaymentPercentage,
      markupMultiplier: markup,
      ...quote,
    });
  } catch (error) {
    if (error instanceof MoneyError) return res.status(400).json({ message: error.message });
    throw error;
  }
};

const PERSON_ID = /^[A-Za-z0-9_-]{1,64}$/;

// GET /api/v1/internal/people/:personId/journey  (scope easybuy:journey.read)
// One person's EasyBuy applications and financed items, for the reseller service's stages and
// its reconciliation check (RESELLER-PLAN.md §14). The same facts the journey events carry:
// IDs, device, plan, dates and kobo. No phone, email or name.
export const GetInternalPersonJourney = async (req: Request, res: Response) => {
  const personId = String(req.params.personId ?? "");
  if (!PERSON_ID.test(personId)) return res.status(400).json({ message: "invalid personId" });

  // Items made before items carried personId belong to the person's linked EasyBuy account.
  const accounts = await UserModel.find({ personId }).select({ _id: 1 }).lean();
  const [requests, items] = await Promise.all([
    PublicEasyBuyRequestModel.find({ personId })
      .sort({ createdAt: 1 })
      .limit(200)
      .select({ _id: 0, requestId: 1, provider: 1, iphoneModel: 1, capacity: 1, plan: 1, status: 1, createdAt: 1, approvedAt: 1, rejectedAt: 1, convertedAt: 1 })
      .lean(),
    EasyBoughtItemModel.find({ $or: [{ personId }, { UserId: { $in: accounts.map((account) => account._id) } }] })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean(),
  ]);

  res.set("Cache-Control", "no-store");
  return res.status(200).json({
    personId,
    currency: "NGN",
    unit: "kobo",
    asOf: new Date().toISOString(),
    requests: requests.map((request) => ({
      requestId: request.requestId,
      provider: request.provider,
      model: request.iphoneModel,
      capacity: request.capacity,
      plan: request.plan,
      status: request.status,
      // timestamps: true adds createdAt, which the model's hand-written type doesn't list.
      createdAt: (request as { createdAt?: Date }).createdAt ?? null,
      approvedAt: request.approvedAt ?? null,
      rejectedAt: request.rejectedAt ?? null,
      convertedAt: request.convertedAt ?? null,
    })),
    items: items.map((item: any) => ({
      itemId: String(item._id),
      requestId: item.sourceRequestId ?? null,
      provider: item.provider,
      model: item.IphoneModel,
      capacity: item.capacity,
      plan: item.Plan,
      phonePriceKobo: toKobo(item.PhonePrice),
      downPaymentKobo: toKobo(item.downPayment),
      financedKobo: toKobo(item.loanedAmount),
      // Items created before the service charge existed have none.
      serviceFeeKobo: Number.isSafeInteger(item.serviceFeeKobo) ? item.serviceFeeKobo : 0,
      serviceFeeBps: Number.isInteger(item.serviceFeeBps) ? item.serviceFeeBps : 0,
      createdAt: item.createdAt,
    })),
  });
};
