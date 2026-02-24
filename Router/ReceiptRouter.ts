import express from "express";
import { verifyToken, requireRole } from "../Middleware/verify.js";
import { upload } from "../Utils/Multer.js";
import {
  UploadReceipt,
  GetMyReceipts,
  GetPendingReceipts,
  ApproveReceiptPayment,
} from "../Controller/ReceiptController.js";

const router = express.Router();

router.post("/upload", verifyToken, requireRole(["User", "Admin"]), upload, UploadReceipt);
router.get("/my", verifyToken, requireRole(["User", "Admin"]), GetMyReceipts);
router.get("/pending", verifyToken, requireRole(["Admin"]), GetPendingReceipts);
router.patch("/:receiptId/approve", verifyToken, requireRole(["Admin"]), ApproveReceiptPayment);

export default router;
