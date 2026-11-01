import express from "express";
import cors from "cors";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildPlatformCorsOptions } from "../Utils/corsHelper.js";

// Browsers call EasyBuy directly (AGENTS.md §5.4), so every header a client sends must pass the
// preflight. On 2026-11-01 the documents step failed for every applicant because the upload key's
// header was missing from the list: the submission succeeded, and the next call never left the browser.

const app = express();
app.use(cors(buildPlatformCorsOptions()));
app.get("/api/v1/public/easybuy-requests/:requestId/documents", (_req, res) => res.json({ ok: true }));

const preflight = (origin: string, headers: string) =>
  request(app)
    .options("/api/v1/public/easybuy-requests/EBR-1/documents")
    .set("Origin", origin)
    .set("Access-Control-Request-Method", "GET")
    .set("Access-Control-Request-Headers", headers);

const allowedHeaders = (res: request.Response) =>
  String(res.headers["access-control-allow-headers"] ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase());

describe("CORS for browser clients", () => {
  it("lets the finance app send the documents upload key", async () => {
    const res = await preflight("https://aurapaytracker.vercel.app", "authorization,x-documents-token");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://aurapaytracker.vercel.app");
    expect(allowedHeaders(res)).toEqual(expect.arrayContaining(["authorization", "x-documents-token"]));
  });

  it("still allows the hub's own headers", async () => {
    const res = await preflight("https://melvingadgets.app", "authorization,x-melvin-device,idempotency-key");
    expect(res.headers["access-control-allow-origin"]).toBe("https://melvingadgets.app");
    expect(allowedHeaders(res)).toEqual(expect.arrayContaining(["authorization", "x-melvin-device", "idempotency-key"]));
  });

  it("gives an unknown origin nothing", async () => {
    const res = await preflight("https://evil.example", "x-documents-token");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
