import { afterEach, describe, expect, it, vi } from "vitest";

// Where EasyBuy calls the auth service. It defaults to the token issuer (that same service), so
// production doesn't need a second variable, while an explicit AUTH_SERVICE_URL still wins.

const saved = { AUTH_ISSUER: process.env.AUTH_ISSUER, AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL };

const authConfig = async (env: { AUTH_ISSUER?: string; AUTH_SERVICE_URL?: string }) => {
  for (const key of ["AUTH_ISSUER", "AUTH_SERVICE_URL"] as const) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  vi.resetModules();
  return (await import("../config/Config.js")).config.auth;
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("auth service URL", () => {
  it("falls back to AUTH_ISSUER when AUTH_SERVICE_URL is not set", async () => {
    const auth = await authConfig({ AUTH_ISSUER: "https://auth.example.test/" });
    expect(auth.serviceUrl).toBe("https://auth.example.test");
    expect(auth.jwksUrl).toBe("https://auth.example.test/.well-known/jwks.json");
  });

  it("treats a blank AUTH_SERVICE_URL as unset", async () => {
    const auth = await authConfig({ AUTH_ISSUER: "https://auth.example.test", AUTH_SERVICE_URL: "  " });
    expect(auth.serviceUrl).toBe("https://auth.example.test");
  });

  it("lets an explicit AUTH_SERVICE_URL win", async () => {
    const auth = await authConfig({ AUTH_ISSUER: "https://auth.example.test", AUTH_SERVICE_URL: "http://auth.internal:8080/" });
    expect(auth.serviceUrl).toBe("http://auth.internal:8080");
  });

  it("keeps the local development default when neither is set", async () => {
    const auth = await authConfig({});
    expect(auth.serviceUrl).toBe("http://localhost:5500");
  });
});
