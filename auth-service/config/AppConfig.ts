import type { AuthApp } from "../types/auth.js";

type AppConfig = {
  slug: AuthApp;
  displayName: string;
  requiresEmailVerification: boolean;
};

export const APP_CONFIG: Record<AuthApp, AppConfig> = {
  easybuy: {
    slug: "easybuy",
    displayName: "EasyBuy",
    requiresEmailVerification: false,
  },
  ecommerce: {
    slug: "ecommerce",
    displayName: "Melasi Store",
    requiresEmailVerification: true,
  },
  "auth-service": {
    slug: "auth-service",
    displayName: "Auth Service",
    requiresEmailVerification: false,
  },
};

export const resolveAuthApp = (value: unknown): AppConfig => {
  const normalized = String(value ?? "").trim().toLowerCase() as AuthApp;
  return APP_CONFIG[normalized] || APP_CONFIG["auth-service"];
};
