import express, { type NextFunction, type Request, type Response } from "express";
import { requireUserToken, type TokenVerifier } from "@melvingadgets/platform-kit";
import {
  CreatePublicEasyBuyRequest,
  GetMyPublicEasyBuyRequests,
  GetPublicEasyBuyCatalog,
  GetPublicProviders,
  ResendPublicEasyBuyVerification,
  SavePublicEasyBuyDraftStep,
  TrackPublicEvent,
  VerifyPublicEasyBuyRequest,
} from "../Controller/PublicEasyBuyController.js";
import {
  DeleteBankStatement,
  GetApplicationDocuments,
  SaveApplicationNin,
  UploadBankStatement,
  UploadNinSelfie,
} from "../Controller/ApplicationDocumentsController.js";
import { optionalPlatformPerson } from "../Middleware/platformPerson.js";
import { MAX_DOCUMENT_BYTES } from "../Utils/applicationDocuments.js";
import { platformVerifier } from "../Utils/platform.js";
import multer from "multer";

// Documents are read into memory (never written to disk), one file per request, 4 MB at most.
const documentUpload: Handler = (req, res, next) => {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } }).single("file")(req, res, (error: unknown) => {
    if (!error) return next();
    const code = (error as { code?: string }).code;
    if (code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ code: "file_too_large", message: "That file is over 4 MB. Upload a smaller file." });
      return;
    }
    res.status(400).json({ code: "bad_upload", message: "Upload one file at a time." });
  });
};

// Async handlers: an unexpected error becomes a 500 instead of an unhandled rejection.
const safe =
  (handler: (req: Request, res: Response) => Promise<unknown>): Handler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };

type Handler = (req: Request, res: Response, next: NextFunction) => void;

// Public (anonymous) routes. Creating a request also records the applicant's person when a
// Melvin user token comes with it; "mine" requires that token.
export const createPublicRouter = (verifier: TokenVerifier | null) => {
  const router = express.Router();
  const signedIn: Handler = verifier
    ? (requireUserToken(verifier) as unknown as Handler)
    : (_req, res) => {
        res.status(503).json({ message: "platform tokens are not configured" });
      };

  router.get("/providers", GetPublicProviders);
  router.get("/easybuy-catalog", GetPublicEasyBuyCatalog);
  router.post("/easybuy-drafts/step", SavePublicEasyBuyDraftStep);
  router.post("/easybuy-requests", optionalPlatformPerson(verifier), CreatePublicEasyBuyRequest);
  router.get("/easybuy-requests/mine", signedIn, GetMyPublicEasyBuyRequests);
  router.post("/easybuy-requests/resend-verification", ResendPublicEasyBuyVerification);
  router.get("/easybuy-requests/verify", VerifyPublicEasyBuyRequest);
  // Application documents: the signed-in owner, or the holder of the request's upload key.
  const owner = optionalPlatformPerson(verifier);
  router.get("/easybuy-requests/:requestId/documents", owner, safe(GetApplicationDocuments));
  router.put("/easybuy-requests/:requestId/documents/nin", owner, safe(SaveApplicationNin));
  router.post("/easybuy-requests/:requestId/documents/bank-statement", owner, documentUpload, safe(UploadBankStatement));
  router.delete("/easybuy-requests/:requestId/documents/bank-statement/:fileId", owner, safe(DeleteBankStatement));
  router.post("/easybuy-requests/:requestId/documents/nin-selfie", owner, documentUpload, safe(UploadNinSelfie));
  router.post("/events", TrackPublicEvent);
  return router;
};

export default createPublicRouter(platformVerifier);
