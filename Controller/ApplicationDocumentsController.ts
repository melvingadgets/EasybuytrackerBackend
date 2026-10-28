import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import mongoose from "mongoose";
import ApplicationDocumentsModel from "../Model/ApplicationDocumentsModel.js";
import AuditLogModel from "../Model/AuditLogModel.js";
import PublicEasyBuyRequestModel from "../Model/PublicEasyBuyRequestModel.js";
import {
  DOCUMENTS_EDITABLE_STATUSES,
  MAX_BANK_STATEMENT_FILES,
  MAX_DOCUMENT_BYTES,
  documentsTokenMatches,
  isAllowedFile,
  missingDocuments,
  normalizeNin,
  sniffFile,
  type DocumentKind,
} from "../Utils/applicationDocuments.js";
import { documentStorage, type StoredFile } from "../Utils/documentStorage.js";

// Application documents (Utils/applicationDocuments.ts). Applicants add them after submitting;
// a SuperAdmin needs all three to approve. Nothing here logs a NIN, a file or a link.

const TOKEN_HEADER = "x-documents-token";
type LeanRequest = { _id: mongoose.Types.ObjectId; requestId: string; status: string; personId?: string | null; documentsRequired?: boolean | null };
type Owned = { request: LeanRequest } | { status: number; message: string };

const requestIdOf = (req: Request): string => String(req.params?.requestId ?? "").trim().slice(0, 64);

/**
 * The applicant owns the request if they're the signed-in person it was created for (a verified
 * Melvin token, never a body field: AGENTS.md §2.5) or they hold its upload key. Anyone else gets
 * the same 404 as for a request that doesn't exist, so request ids can't be probed.
 */
const loadOwnedRequest = async (req: Request): Promise<Owned> => {
  const notFound = { status: 404, message: "Application not found" };
  const requestId = requestIdOf(req);
  if (!requestId) return notFound;
  const request = await PublicEasyBuyRequestModel.findOne({ requestId })
    .select("+documentsTokenHash +documentsTokenExpiresAt")
    .lean();
  if (!request) return notFound;
  const personId = req.person?.personId;
  const byPerson = Boolean(personId && request.personId && request.personId === personId);
  const token = String(req.get(TOKEN_HEADER) ?? "");
  const tokenValid = Boolean(request.documentsTokenExpiresAt && new Date(request.documentsTokenExpiresAt) > new Date());
  const byToken = tokenValid && documentsTokenMatches(token, request.documentsTokenHash);
  if (!byPerson && !byToken) return notFound;
  return { request: request as unknown as LeanRequest };
};

const isEditable = (status: string) => (DOCUMENTS_EDITABLE_STATUSES as readonly string[]).includes(status);

const lockedResponse = (res: Response) =>
  res.status(409).json({ code: "documents_locked", message: "This application has been reviewed, so its documents can no longer be changed." });

const publicFile = (file: { fileId: string; format: string; bytes: number; uploadedAt: Date }) => ({
  fileId: file.fileId,
  format: file.format,
  bytes: file.bytes,
  uploadedAt: file.uploadedAt,
});

const summaryFor = (request: LeanRequest, documents: Record<string, any> | null) => {
  const missing = missingDocuments(documents);
  return {
    requestId: request.requestId,
    // The applicant's own view of where the application stands. Added with the merged Apply app
    // (2026-10-28): the documents route is the one endpoint an upload-key holder can always reach,
    // so without this the browser could never tell "under review" from "approved".
    status: request.status,
    required: Boolean(request.documentsRequired),
    editable: isEditable(request.status),
    complete: missing.length === 0,
    missing,
    bankStatements: (documents?.bankStatements ?? []).map(publicFile),
    downPaymentConfirmed: Boolean(documents?.downPaymentConfirmedAt),
    nin: documents?.ninLast4 ? { provided: true, last4: documents.ninLast4 } : { provided: false },
    ninSelfie: documents?.ninSelfie ? { uploadedAt: documents.ninSelfie.uploadedAt } : null,
    limits: { maxFileBytes: MAX_DOCUMENT_BYTES, maxBankStatements: MAX_BANK_STATEMENT_FILES },
  };
};

const loadDocuments = (requestId: string, withNin = false) =>
  withNin
    ? ApplicationDocumentsModel.findOne({ requestId }).select("+nin").lean()
    : ApplicationDocumentsModel.findOne({ requestId }).lean();

// Reads, checks and stores an uploaded file. Returns the stored file, or sends the error.
const storeUpload = async (req: Request, res: Response, request: LeanRequest, kind: DocumentKind) => {
  const file = (req as Request & { file?: { buffer: Buffer; size: number } }).file;
  if (!file?.buffer?.length) {
    res.status(400).json({ code: "file_required", message: "Choose a file to upload." });
    return null;
  }
  const sniffed = sniffFile(file.buffer);
  if (!isAllowedFile(kind, sniffed)) {
    res.status(415).json({
      code: "file_type",
      message: kind === "bank_statement" ? "Upload a PDF or a photo (JPG, PNG or WebP)." : "Upload a photo (JPG, PNG or WebP).",
    });
    return null;
  }
  try {
    const stored = await documentStorage.put(file.buffer, { requestId: request.requestId, kind, sniffed });
    return {
      fileId: randomUUID(),
      ...stored,
      mime: sniffed.mime,
      uploadedAt: new Date(),
    };
  } catch {
    res.status(502).json({ code: "storage_unavailable", message: "We couldn't save your file. Please try again." });
    return null;
  }
};

const removeQuietly = async (file: StoredFile | null | undefined) => {
  if (!file?.publicId) return;
  try {
    await documentStorage.remove(file);
  } catch {
    // A leftover private file is harmless; it has no public URL.
  }
};

// ── Applicant routes (/api/v1/public/easybuy-requests/:requestId/documents...) ───────────────

export const GetApplicationDocuments = async (req: Request, res: Response) => {
  const owned = await loadOwnedRequest(req);
  if (!("request" in owned)) return res.status(owned.status).json({ message: owned.message });
  const documents = await loadDocuments(owned.request.requestId);
  res.set("Cache-Control", "no-store");
  return res.status(200).json({ data: summaryFor(owned.request, documents) });
};

export const SaveApplicationNin = async (req: Request, res: Response) => {
  const owned = await loadOwnedRequest(req);
  if (!("request" in owned)) return res.status(owned.status).json({ message: owned.message });
  if (!isEditable(owned.request.status)) return lockedResponse(res);
  const nin = normalizeNin(req.body?.nin);
  if (!nin) return res.status(400).json({ code: "invalid_nin", message: "Enter your 11-digit NIN." });
  const documents = await ApplicationDocumentsModel.findOneAndUpdate(
    { requestId: owned.request.requestId },
    { $set: { nin, ninLast4: nin.slice(-4), ninUpdatedAt: new Date() } },
    { upsert: true, returnDocument: "after" }
  ).lean();
  return res.status(200).json({ data: summaryFor(owned.request, documents) });
};

export const UploadBankStatement = async (req: Request, res: Response) => {
  const owned = await loadOwnedRequest(req);
  if (!("request" in owned)) return res.status(owned.status).json({ message: owned.message });
  if (!isEditable(owned.request.status)) return lockedResponse(res);
  // The statement only proves affordability if the down payment was already in the account.
  if (String(req.body?.downPaymentConfirmed ?? "").toLowerCase() !== "true") {
    return res.status(400).json({
      code: "down_payment_unconfirmed",
      message: "Confirm your down payment was in the account before you generated this statement.",
    });
  }
  const stored = await storeUpload(req, res, owned.request, "bank_statement");
  if (!stored) return;

  // At most MAX_BANK_STATEMENT_FILES, enforced by the update's own filter, so two uploads at once
  // can't both slip past the limit (AGENTS.md §3.8).
  const lastAllowedIndex = `bankStatements.${MAX_BANK_STATEMENT_FILES - 1}`;
  try {
    const documents = await ApplicationDocumentsModel.findOneAndUpdate(
      { requestId: owned.request.requestId, [lastAllowedIndex]: { $exists: false } },
      { $push: { bankStatements: stored }, $set: { downPaymentConfirmedAt: new Date() } },
      { upsert: true, returnDocument: "after" }
    ).lean();
    return res.status(201).json({ data: summaryFor(owned.request, documents) });
  } catch (error) {
    await removeQuietly(stored);
    if ((error as { code?: number }).code === 11000) {
      return res.status(409).json({ code: "too_many_files", message: `You can upload up to ${MAX_BANK_STATEMENT_FILES} statement files. Remove one first.` });
    }
    throw error;
  }
};

export const DeleteBankStatement = async (req: Request, res: Response) => {
  const owned = await loadOwnedRequest(req);
  if (!("request" in owned)) return res.status(owned.status).json({ message: owned.message });
  if (!isEditable(owned.request.status)) return lockedResponse(res);
  const fileId = String(req.params?.fileId ?? "");
  const before = await ApplicationDocumentsModel.findOneAndUpdate(
    { requestId: owned.request.requestId, "bankStatements.fileId": fileId },
    { $pull: { bankStatements: { fileId } } },
    { returnDocument: "before" }
  ).lean();
  const removed = before?.bankStatements?.find((file) => file.fileId === fileId);
  if (!removed) return res.status(404).json({ message: "File not found" });
  await removeQuietly(removed as StoredFile);
  const documents = await loadDocuments(owned.request.requestId);
  return res.status(200).json({ data: summaryFor(owned.request, documents) });
};

export const UploadNinSelfie = async (req: Request, res: Response) => {
  const owned = await loadOwnedRequest(req);
  if (!("request" in owned)) return res.status(owned.status).json({ message: owned.message });
  if (!isEditable(owned.request.status)) return lockedResponse(res);
  const stored = await storeUpload(req, res, owned.request, "nin_selfie");
  if (!stored) return;
  const before = await ApplicationDocumentsModel.findOneAndUpdate(
    { requestId: owned.request.requestId },
    { $set: { ninSelfie: stored } },
    { upsert: true, returnDocument: "before" }
  ).lean();
  await removeQuietly(before?.ninSelfie as StoredFile | null | undefined);
  const documents = await loadDocuments(owned.request.requestId);
  return res.status(201).json({ data: summaryFor(owned.request, documents) });
};

/**
 * Binds an application that was submitted anonymously to the signed-in person, so it shows up in
 * `GET /easybuy-requests/mine` and the merged Apply app can gate on it. `personId` is only ever
 * written at submission from a verified token (PublicEasyBuyController), so without this an
 * applicant who submitted before signing in is invisible to their own account.
 *
 * The caller must hold the request's upload key AND present a verified Melvin token: the key proves
 * they made the application, the token supplies the identity. Both come from credentials the
 * applicant already has, and identity itself is never read from the body (AGENTS.md §2.5).
 */
export const ClaimApplication = async (req: Request, res: Response) => {
  const personId = req.person?.personId;
  if (!personId) return res.status(401).json({ message: "Sign in to add this application to your account." });

  const requestId = requestIdOf(req);
  if (!requestId) return res.status(404).json({ message: "Application not found" });
  const request = await PublicEasyBuyRequestModel.findOne({ requestId })
    .select("+documentsTokenHash +documentsTokenExpiresAt")
    .lean();
  if (!request) return res.status(404).json({ message: "Application not found" });

  const tokenValid = Boolean(request.documentsTokenExpiresAt && new Date(request.documentsTokenExpiresAt) > new Date());
  if (!tokenValid || !documentsTokenMatches(String(req.get(TOKEN_HEADER) ?? ""), request.documentsTokenHash)) {
    return res.status(404).json({ message: "Application not found" });
  }

  // One atomic write. The filter only matches an unclaimed request or one already owned by this
  // person, so a second person's claim cannot take it over and a repeat claim by the same person
  // is a no-op (AGENTS.md §3.8: the rule is the filter, not a read-then-write).
  const claimed = await PublicEasyBuyRequestModel.findOneAndUpdate(
    {
      requestId,
      $or: [{ personId: { $exists: false } }, { personId: null }, { personId }],
    },
    { $set: { personId } },
    { returnDocument: "after" }
  )
    .select("requestId status personId documentsRequired")
    .lean();

  if (!claimed) {
    return res.status(409).json({
      code: "already_claimed",
      message: "This application is already linked to another account.",
    });
  }

  const documents = await loadDocuments(requestId);
  res.set("Cache-Control", "no-store");
  return res.status(200).json({ data: summaryFor(claimed as unknown as LeanRequest, documents) });
};

// ── SuperAdmin (/api/v1/superadmin/public-easybuy-requests/:requestId/documents) ─────────────

export const SuperAdminGetApplicationDocuments = async (req: Request, res: Response) => {
  const actorId = req.user?._id;
  if (!actorId || req.user?.role !== "SuperAdmin") return res.status(401).json({ message: "Access denied" });
  const requestId = requestIdOf(req);
  const request = await PublicEasyBuyRequestModel.findOne({ requestId }).select("requestId status personId documentsRequired").lean();
  if (!request) return res.status(404).json({ message: "Public request not found" });
  const documents = await loadDocuments(requestId, true);

  const nin = (documents?.nin as string | undefined) ?? null;

  // Viewing someone's ID documents is recorded (who, which request, when).
  await AuditLogModel.create({
    actor: new mongoose.Types.ObjectId(actorId),
    actorRole: "SuperAdmin",
    action: "PUBLIC_REQUEST_DOCUMENTS_VIEW",
    targetType: "publicrequest",
    targetId: request._id,
    reason: "Viewed application documents",
  });

  const withLink = (file: Record<string, any>) => ({ ...publicFile(file as never), mime: file.mime, url: documentStorage.signedLink(file as StoredFile) });
  res.set("Cache-Control", "no-store");
  return res.status(200).json({
    data: {
      ...summaryFor(request as unknown as LeanRequest, documents),
      nin: nin ? { provided: true, value: nin } : { provided: false },
      bankStatements: (documents?.bankStatements ?? []).map(withLink),
      ninSelfie: documents?.ninSelfie ? withLink(documents.ninSelfie) : null,
      linkExpiresInSeconds: 300,
    },
  });
};

/** Documents status for many requests at once, for the SuperAdmin list (no NINs or links). */
export const documentsSummaryByRequest = async (requestIds: string[]) => {
  if (!requestIds.length) return new Map<string, { count: number; complete: boolean; missing: string[] }>();
  const docs = await ApplicationDocumentsModel.find({ requestId: { $in: requestIds } })
    .select("requestId bankStatements.fileId ninLast4 ninSelfie.fileId")
    .lean();
  const byId = new Map(docs.map((doc) => [doc.requestId, doc]));
  return new Map(
    requestIds.map((requestId) => {
      const missing = missingDocuments(byId.get(requestId) as never);
      return [requestId, { count: 3 - missing.length, complete: missing.length === 0, missing }];
    })
  );
};

/** What a request still needs before approval; empty when complete or not required. */
export const missingForApproval = async (requestId: string): Promise<string[]> => {
  const request = await PublicEasyBuyRequestModel.findOne({ requestId }).select("documentsRequired").lean();
  if (!request?.documentsRequired) return [];
  return missingDocuments((await loadDocuments(requestId)) as never);
};
