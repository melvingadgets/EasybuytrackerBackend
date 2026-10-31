import express from "express";
import { requirePermission } from "@melvingadgets/platform-kit";
import { verifyToken } from "../Middleware/verify.js";
import {
  SuperAdminDeleteUserOrAdmin,
  SuperAdminGetAllUsers,
  SuperAdminGetLoginStats,
  SuperAdminGetPublicEasyBuyAnalytics,
  SuperAdminListAbandonedPublicEasyBuyDrafts,
  SuperAdminListPublicEasyBuyRequests,
  SuperAdminApprovePublicEasyBuyRequest,
  SuperAdminRejectPublicEasyBuyRequest,
  SuperAdminConvertPublicEasyBuyRequest,
  SuperAdminPreviewItemCreatedDate,
  SuperAdminPreviewReceiptUploadedDate,
  SuperAdminPreviewUserNextDueDate,
  SuperAdminGetEasyBuyPricing,
  SuperAdminUpdateEasyBuyPricing,
  SuperAdminUpdateItemCreatedDate,
  SuperAdminUpdateReceiptUploadedDate,
  SuperAdminUpdateUserNextDueDate,
  SuperAdminGetUsersWithEasyBoughtItems,
} from "../Controller/SuperAdminController.js";
import { SuperAdminGetApplicationDocuments } from "../Controller/ApplicationDocumentsController.js";

const router = express.Router();

router.get("/users", verifyToken, requirePermission("easybuy.superadmin.access"), SuperAdminGetAllUsers);
router.get(
  "/users-with-items",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminGetUsersWithEasyBoughtItems
);
router.delete(
  "/users/:userId",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminDeleteUserOrAdmin
);
router.get("/login-stats", verifyToken, requirePermission("easybuy.superadmin.access"), SuperAdminGetLoginStats);
router.get("/easybuy-pricing", verifyToken, requirePermission("easybuy.superadmin.access"), SuperAdminGetEasyBuyPricing);
router.patch("/easybuy-pricing", verifyToken, requirePermission("easybuy.superadmin.access"), SuperAdminUpdateEasyBuyPricing);
router.get(
  "/public-easybuy-analytics",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminGetPublicEasyBuyAnalytics
);
router.get(
  "/public-easybuy-abandoned-drafts",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminListAbandonedPublicEasyBuyDrafts
);
router.get(
  "/public-easybuy-requests",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminListPublicEasyBuyRequests
);
router.get(
  "/public-easybuy-requests/:requestId/documents",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  (req, res, next) => {
    SuperAdminGetApplicationDocuments(req, res).catch(next);
  }
);
router.patch(
  "/public-easybuy-requests/:requestId/approve",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminApprovePublicEasyBuyRequest
);
router.patch(
  "/public-easybuy-requests/:requestId/reject",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminRejectPublicEasyBuyRequest
);
router.post(
  "/public-easybuy-requests/:requestId/convert",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminConvertPublicEasyBuyRequest
);
router.get(
  "/maintenance/receipts/:receiptId/uploaded-date/preview",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminPreviewReceiptUploadedDate
);
router.patch(
  "/maintenance/receipts/:receiptId/uploaded-date",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminUpdateReceiptUploadedDate
);
router.get(
  "/maintenance/users/:userId/next-due-date/preview",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminPreviewUserNextDueDate
);
router.patch(
  "/maintenance/users/:userId/next-due-date",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminUpdateUserNextDueDate
);
router.get(
  "/maintenance/items/:itemId/created-date/preview",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminPreviewItemCreatedDate
);
router.patch(
  "/maintenance/items/:itemId/created-date",
  verifyToken,
  requirePermission("easybuy.superadmin.access"),
  SuperAdminUpdateItemCreatedDate
);

export default router;
