import express, { type NextFunction, type Request, type Response } from "express";
import { requireServiceToken, type Scope, type TokenVerifier } from "@melvingadgets/platform-kit";
import { GetInternalCatalog, GetInternalPersonJourney, GetInternalQuote } from "../Controller/InternalController.js";

type Handler = (req: Request, res: Response, next: NextFunction) => void;

// Routes only other platform services may call, each needing its own scope
// (Shortwork/AGENTS.md §2.4). Not subject to the public per-IP limits.
export const createInternalRouter = (verifier: TokenVerifier | null) => {
  const router = express.Router();
  const scope = (required: Scope): Handler =>
    verifier
      ? (requireServiceToken(verifier, { audience: "easybuy", scope: required }) as unknown as Handler)
      : (_req, res) => {
          res.status(503).json({ message: "platform tokens are not configured" });
        };

  const wrap =
    (handler: (req: Request, res: Response) => Promise<unknown>): Handler =>
    (req, res, next) => {
      handler(req, res).catch(next);
    };

  router.get("/catalog", scope("easybuy:catalog.read"), wrap(GetInternalCatalog));
  router.get("/quote", scope("easybuy:quote.read"), wrap(GetInternalQuote));
  router.get("/people/:personId/journey", scope("easybuy:journey.read"), wrap(GetInternalPersonJourney));
  return router;
};
