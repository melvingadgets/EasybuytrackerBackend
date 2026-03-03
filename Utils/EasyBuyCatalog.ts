export type EasyBuyPlanType = "Monthly" | "Weekly";

export type EasyBuyCatalogEntry = {
  model: string;
  imageUrl: string;
  capacities: string[];
  allowedPlans: EasyBuyPlanType[];
  downPaymentPercentage: 40 | 60;
};

export type EasyBuyPlanRules = {
  monthlyDurations: number[];
  weeklyDurations: number[];
  monthlyMarkupMultipliers: Record<string, number>;
  weeklyMarkupMultipliers: Record<string, number>;
};

const catalog: EasyBuyCatalogEntry[] = [
  {
    model: "iPhone XR",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-xr-new.jpg",
    capacities: ["64GB", "128GB", "256GB"],
    allowedPlans: ["Weekly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone XS",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-xs-new.jpg",
    capacities: ["64GB", "256GB", "512GB"],
    allowedPlans: ["Weekly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone XS Max",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-xs-max-new1.jpg",
    capacities: ["64GB", "256GB", "512GB"],
    allowedPlans: ["Weekly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 11",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-11.jpg",
    capacities: ["64GB", "128GB", "256GB"],
    allowedPlans: ["Weekly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 11 Pro",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-11-pro.jpg",
    capacities: ["64GB", "256GB", "512GB"],
    allowedPlans: ["Weekly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 11 Pro Max",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-11-pro-max.jpg",
    capacities: ["64GB", "256GB", "512GB"],
    allowedPlans: ["Weekly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 12",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-12.jpg",
    capacities: ["64GB", "128GB", "256GB"],
    allowedPlans: ["Weekly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 12 mini",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-12-mini.jpg",
    capacities: ["64GB", "128GB", "256GB"],
    allowedPlans: ["Weekly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 12 Pro",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-12-pro--.jpg",
    capacities: ["128GB", "256GB", "512GB"],
    allowedPlans: ["Weekly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 12 Pro Max",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-12-pro-max-.jpg",
    capacities: ["128GB", "256GB", "512GB"],
    allowedPlans: ["Weekly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 13 mini",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-13-mini.jpg",
    capacities: ["128GB", "256GB", "512GB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 13",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-13.jpg",
    capacities: ["128GB", "256GB", "512GB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 13 Pro",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-13-pro.jpg",
    capacities: ["128GB", "256GB", "512GB", "1TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 13 Pro Max",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-13-pro-max.jpg",
    capacities: ["128GB", "256GB", "512GB", "1TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 14",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-14.jpg",
    capacities: ["128GB", "256GB", "512GB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 14 Plus",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-14-plus.jpg",
    capacities: ["128GB", "256GB", "512GB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 14 Pro",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-14-pro.jpg",
    capacities: ["128GB", "256GB", "512GB", "1TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 14 Pro Max",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-14-pro-max-.jpg",
    capacities: ["128GB", "256GB", "512GB", "1TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 15",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-15.jpg",
    capacities: ["128GB", "256GB", "512GB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 15 Plus",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-15-plus-.jpg",
    capacities: ["128GB", "256GB", "512GB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 15 Pro",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-15-pro.jpg",
    capacities: ["128GB", "256GB", "512GB", "1TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 15 Pro Max",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-15-pro-max.jpg",
    capacities: ["256GB", "512GB", "1TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 16",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-16.jpg",
    capacities: ["128GB", "256GB", "512GB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 16 Plus",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-16-plus.jpg",
    capacities: ["128GB", "256GB", "512GB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 16 Pro",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-16-pro.jpg",
    capacities: ["128GB", "256GB", "512GB", "1TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 16 Pro Max",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-16-pro-max.jpg",
    capacities: ["256GB", "512GB", "1TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 40,
  },
  {
    model: "iPhone 17",
    imageUrl:
      "https://www.apple.com/v/iphone-17/d/images/overview/highlights/cameras/cameras__c52mawt2c282_large.png",
    capacities: ["256GB", "512GB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 17 Air",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-air.jpg",
    capacities: ["256GB", "512GB", "1TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 17 Pro",
    imageUrl:
      "https://www.apple.com/v/iphone-17-pro/d/images/overview/highlights/camera/camera__by44zzv2fw7m_large_2x.png",
    capacities: ["256GB", "512GB", "1TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 60,
  },
  {
    model: "iPhone 17 Pro Max",
    imageUrl: "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-17-pro-max.jpg",
    capacities: ["256GB", "512GB", "1TB", "2TB"],
    allowedPlans: ["Weekly", "Monthly"],
    downPaymentPercentage: 60,
  },
];

export const EASYBUY_CATALOG = catalog.map((entry) => ({
  ...entry,
  capacities: [...entry.capacities],
  allowedPlans: [...entry.allowedPlans],
}));

export const EASYBUY_CATALOG_MAP = new Map(EASYBUY_CATALOG.map((entry) => [entry.model, entry] as const));

export const EASYBUY_PLAN_RULES: EasyBuyPlanRules = {
  monthlyDurations: [1, 2, 3],
  weeklyDurations: [4, 8, 12],
  monthlyMarkupMultipliers: {
    "1": 1.2,
    "2": 1.4,
    "3": 1.6,
  },
  weeklyMarkupMultipliers: {
    "4": 1.2,
    "8": 1.4,
    "12": 1.5,
  },
};

export const normalizeCapacityInput = (value: unknown): string => {
  const trimmed = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!trimmed) return "";
  if (/^\d+$/.test(trimmed)) {
    return `${trimmed}GB`;
  }
  return trimmed;
};
