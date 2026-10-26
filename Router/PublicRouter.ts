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
import { optionalPlatformPerson } from "../Middleware/platformPerson.js";
import { platformVerifier } from "../Utils/platform.js";

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
  router.post("/events", TrackPublicEvent);
  return router;
};

export default createPublicRouter(platformVerifier);
