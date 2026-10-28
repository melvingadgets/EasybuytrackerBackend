import { createHash, randomBytes, timingSafeEqual } from "crypto";

// The documents an Apply request needs before it can be approved: a three-month bank statement,
// the applicant's NIN, and a photo of them holding their NIN. These are the most sensitive data
// EasyBuy holds: nothing here is ever logged (Shortwork/AGENTS.md §6.3), the NIN is never returned
// outside the SuperAdmin route, and files are private (Utils/documentStorage.ts).
//
// The NIN is stored as typed, not encrypted: the owner asked for the encryption and its key to be
// removed on 2026-10-28. Anything that reads this collection later must not assume otherwise.

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
  documents: { nin?: string | null; ninLast4?: string | null; ninSelfie?: unknown; bankStatements?: unknown[] | null } | null | undefined,
): RequiredDocument[] => {
  const missing: RequiredDocument[] = [];
  if (!documents?.bankStatements?.length) missing.push("bank_statement");
  // ninLast4 is written with the NIN, so a summary that excludes the number still knows it's set.
  if (!documents?.nin && !documents?.ninLast4) missing.push("nin");
  if (!documents?.ninSelfie) missing.push("nin_selfie");
  return missing;
};
