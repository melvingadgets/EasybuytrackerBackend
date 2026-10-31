import express from "express";
import { requirePermission } from "@melvingadgets/platform-kit";
import { verifyToken } from "../Middleware/verify.js";
import { upload } from "../Utils/Multer.js";
import {
  UploadReceipt,
  GetMyReceipts,
  GetPendingReceipts,
  ApproveReceiptPayment,
  RejectReceiptPayment,
} from "../Controller/ReceiptController.js";

const router = express.Router();

// Uploading is an ordinary customer action; approving is SuperAdmin work.
router.post("/upload", verifyToken, requirePermission("easybuy.receipts.upload"), upload, UploadReceipt);
router.get("/my", verifyToken, requirePermission("easybuy.receipts.upload"), GetMyReceipts);
router.get("/pending", verifyToken, requirePermission("easybuy.receipts.approve"), GetPendingReceipts);
router.patch("/:receiptId/approve", verifyToken, requirePermission("easybuy.receipts.approve"), ApproveReceiptPayment);
router.patch("/:receiptId/reject", verifyToken, requirePermission("easybuy.receipts.approve"), RejectReceiptPayment);

export default router;
