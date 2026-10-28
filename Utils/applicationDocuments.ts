import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "crypto";
import { config } from "../config/Config.js";

// The documents an Apply request needs before it can be approved: a three-month bank statement,
// the applicant's NIN, and a photo of them holding their NIN. These are the most sensitive data
// EasyBuy holds: nothing here is ever logged (Shortwork/AGENTS.md §6.3), the NIN is encrypted at
// rest, and files are private (Utils/documentStorage.ts).

/** Apply forwards uploads through Vercel functions, which cap a request at about 4.5 MB. */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const MAX_BANK_STATEMENT_FILES = 3;
/** How long the upload key given to an anonymous applicant at submission stays valid. */
export const DOCUMENTS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Requests that can still take documents; approval or rejection locks them. */
export const DOCUMENTS_EDITABLE_STATUSES = ["pending_verification", "verified"] as const;

export type DocumentKind = "bank_statement" | "nin_selfie";
export type RequiredDocument = "bank_statement" | "nin" | "nin_selfie";

export interface SniffedFile {
  mime: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
  format: "pdf" | "jpg" | "png" | "webp";
}

/** Identifies a file from its first bytes, never from its name or the browser's claimed type. */
export const sniffFile = (buffer: Buffer): SniffedFile | null => {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", format: "pdf" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", format: "jpg" };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", format: "png" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return { mime: "image/webp", format: "webp" };
  }
  return null;
};

const ALLOWED_MIME: Record<DocumentKind, ReadonlySet<SniffedFile["mime"]>> = {
  bank_statement: new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]),
  nin_selfie: new Set(["image/jpeg", "image/png", "image/webp"]),
};

export const isAllowedFile = (kind: DocumentKind, sniffed: SniffedFile | null): sniffed is SniffedFile =>
  Boolean(sniffed && ALLOWED_MIME[kind].has(sniffed.mime));

/** An NIN is exactly 11 digits; spaces are ignored. */
export const normalizeNin = (value: unknown): string | null => {
  const digits = String(value ?? "").replace(/\s+/g, "");
  return /^\d{11}$/.test(digits) ? digits : null;
};

// ── NIN encryption: AES-256-GCM, stored as "v1:<iv>:<tag>:<ciphertext>" (base64 parts). ────────

const documentsKey = (): Buffer | null => {
  if (!config.documentsKey) return null;
  const key = Buffer.from(config.documentsKey, "base64");
  return key.length === 32 ? key : null;
};

export const documentsEncryptionReady = (): boolean => documentsKey() !== null;

export const encryptText = (plain: string): string => {
  const key = documentsKey();
  if (!key) throw new Error("documents encryption key is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
};

export const decryptText = (stored: string): string => {
  const key = documentsKey();
  if (!key) throw new Error("documents encryption key is not configured");
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("unrecognised encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
};

// ── The anonymous applicant's upload key: returned once at submission, stored only as a hash. ──

export const newDocumentsToken = (): string => randomBytes(32).toString("base64url");

export const hashDocumentsToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export const documentsTokenMatches = (candidate: string, storedHash: string | null | undefined): boolean => {
  if (!candidate || !storedHash) return false;
  const given = Buffer.from(hashDocumentsToken(candidate), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** What's still missing before the request can be approved. */
export const missingDocuments = (
  documents: { ninEncrypted?: string | null; ninLast4?: string | null; ninSelfie?: unknown; bankStatements?: unknown[] | null } | null | undefined,
): RequiredDocument[] => {
  const missing: RequiredDocument[] = [];
  if (!documents?.bankStatements?.length) missing.push("bank_statement");
  // ninLast4 is written with the ciphertext, so callers needn't read the encrypted NIN.
  if (!documents?.ninEncrypted && !documents?.ninLast4) missing.push("nin");
  if (!documents?.ninSelfie) missing.push("nin_selfie");
  return missing;
};
