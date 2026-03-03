import express from "express";
import {
  CreatePublicEasyBuyRequest,
  GetPublicEasyBuyCatalog,
  ResendPublicEasyBuyVerification,
  SavePublicEasyBuyDraftStep,
  VerifyPublicEasyBuyRequest,
} from "../Controller/PublicEasyBuyController.js";

const router = express.Router();

router.get("/easybuy-catalog", GetPublicEasyBuyCatalog);
router.post("/easybuy-drafts/step", SavePublicEasyBuyDraftStep);
router.post("/easybuy-requests", CreatePublicEasyBuyRequest);
router.post("/easybuy-requests/resend-verification", ResendPublicEasyBuyVerification);
router.get("/easybuy-requests/verify", VerifyPublicEasyBuyRequest);

export default router;
