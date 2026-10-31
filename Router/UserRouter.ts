import express from "express";
const router = express.Router()
import { CreateAdmin, CreateUser, LoginUser,GetAllUsers,GetEasyBoughtItems, CreateEasyBoughtItem,GetCurrentUser, LogoutUser, GetEasyBuyCatalog, GetEasyBuyCatalogImage} from "../Controller/UserController.js";
import { GetProfileName } from "../Controller/ProfileController.js";
import { GetMySummary } from "../Controller/MySummaryController.js";
import { requirePermission } from "@melvingadgets/platform-kit";
import { verifyToken } from "../Middleware/verify.js";
// Permissions, not role lists (docs/rbac-unification.md). `requireRole(["Admin"])` used
// to *exclude* a SuperAdmin from createuser/getallusers/catalog/item, which is the
// lockout this fixes.
router.post("/createadmin", verifyToken, requirePermission("easybuy.admins.create"), CreateAdmin);
router.post("/createuser", verifyToken, requirePermission("easybuy.users.create"), CreateUser);
router.post("/login-user", LoginUser);
router.post("/logout-user", verifyToken, LogoutUser);
router.post("/logout", verifyToken, LogoutUser);
router.get("/getallusers", verifyToken, requirePermission("easybuy.users.read"), GetAllUsers);
router.get("/getcurrentuser", verifyToken, GetCurrentUser);
router.get("/profile", verifyToken, GetProfileName);
router.get("/geteasyboughtitems", verifyToken, GetEasyBoughtItems);
// The Profile app's own view of this customer: kobo, no NIN, no receipt files.
router.get("/summary", verifyToken, GetMySummary);
router.get("/easybuy-catalog-image/:model", GetEasyBuyCatalogImage);
router.get("/easybuy-catalog", verifyToken, requirePermission("easybuy.catalog.write"), GetEasyBuyCatalog);
router.post("/createeasyboughtitem", verifyToken, requirePermission("easybuy.catalog.write"), CreateEasyBoughtItem);

export default router
