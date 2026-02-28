import express from "express";
import { verifyToken, requireRole } from "../Middleware/verify.js";
import {
  SuperAdminDeleteUserOrAdmin,
  SuperAdminGetAllUsers,
  SuperAdminGetLoginStats,
  SuperAdminPreviewItemCreatedDate,
  SuperAdminPreviewReceiptUploadedDate,
  SuperAdminPreviewUserNextDueDate,
  SuperAdminUpdateItemCreatedDate,
  SuperAdminUpdateReceiptUploadedDate,
  SuperAdminUpdateUserNextDueDate,
  SuperAdminGetUsersWithEasyBoughtItems,
} from "../Controller/SuperAdminController.js";

const router = express.Router();

router.get("/users", verifyToken, requireRole(["SuperAdmin"]), SuperAdminGetAllUsers);
router.get(
  "/users-with-items",
  verifyToken,
  requireRole(["SuperAdmin"]),
  SuperAdminGetUsersWithEasyBoughtItems
);
router.delete(
  "/users/:userId",
  verifyToken,
  requireRole(["SuperAdmin"]),
  SuperAdminDeleteUserOrAdmin
);
router.get("/login-stats", verifyToken, requireRole(["SuperAdmin"]), SuperAdminGetLoginStats);
router.get(
  "/maintenance/receipts/:receiptId/uploaded-date/preview",
  verifyToken,
  requireRole(["SuperAdmin"]),
  SuperAdminPreviewReceiptUploadedDate
);
router.patch(
  "/maintenance/receipts/:receiptId/uploaded-date",
  verifyToken,
  requireRole(["SuperAdmin"]),
  SuperAdminUpdateReceiptUploadedDate
);
router.get(
  "/maintenance/users/:userId/next-due-date/preview",
  verifyToken,
  requireRole(["SuperAdmin"]),
  SuperAdminPreviewUserNextDueDate
);
router.patch(
  "/maintenance/users/:userId/next-due-date",
  verifyToken,
  requireRole(["SuperAdmin"]),
  SuperAdminUpdateUserNextDueDate
);
router.get(
  "/maintenance/items/:itemId/created-date/preview",
  verifyToken,
  requireRole(["SuperAdmin"]),
  SuperAdminPreviewItemCreatedDate
);
router.patch(
  "/maintenance/items/:itemId/created-date",
  verifyToken,
  requireRole(["SuperAdmin"]),
  SuperAdminUpdateItemCreatedDate
);

export default router;
