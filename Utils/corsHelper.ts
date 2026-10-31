import type { CorsOptions } from "cors";

const explicitOrigins = String(process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const isAllowedOrigin = (
  origin: string | undefined
): boolean => {
  if (!origin) return true;
  const cleanOrigin = origin.trim().replace(/\/+$/, "");
  if (explicitOrigins.includes(cleanOrigin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(cleanOrigin)) return true;
  if (/^https?:\/\/([a-z0-9-]+\.)*melvingadgets\.(com|app)$/i.test(cleanOrigin)) return true;
  if (
    /^https:\/\/([a-z0-9-]+)\.melvingadgets-projects\.vercel\.app$/i.test(cleanOrigin) ||
    /^https:\/\/melvin-os(-[a-z0-9-]+)?\.vercel\.app$/i.test(cleanOrigin) ||
    /^https:\/\/aurapaytrack(er)?(-[a-z0-9-]+)?\.vercel\.app$/i.test(cleanOrigin) ||
    /^https:\/\/easybuy(-[a-z0-9-]+)?\.vercel\.app$/i.test(cleanOrigin) ||
    /^https:\/\/store(-[a-z0-9-]+)?\.vercel\.app$/i.test(cleanOrigin)
  ) {
    return true;
  }
  return false;
};

export const buildPlatformCorsOptions = (): CorsOptions => ({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, origin || true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
    "x-melvin-device",
    "x-melvin-user",
    "x-request-id",
    "x-service-key",
    "Idempotency-Key",
  ],
  exposedHeaders: ["x-request-id"],
  optionsSuccessStatus: 204,
});
