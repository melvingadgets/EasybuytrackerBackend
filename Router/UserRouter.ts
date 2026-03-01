import express from "express";
const router = express.Router()
import { CreateAdmin, CreateUser, LoginUser,GetAllUsers,GetEasyBoughtItems, CreateEasyBoughtItem,GetCurrentUser, LogoutUser, GetEasyBuyCatalog, GetEasyBuyCatalogImage} from "../Controller/UserController.js";
import { GetProfileName } from "../Controller/ProfileController.js";
import { verifyToken, requireRole } from "../Middleware/verify.js";
router.post("/createadmin", verifyToken, requireRole(["SuperAdmin"]), CreateAdmin);
router.post("/createuser", verifyToken, requireRole(["Admin"]), CreateUser);
router.post("/login-user", LoginUser);   
router.post("/logout-user", verifyToken, LogoutUser);
router.post("/logout", verifyToken, LogoutUser);
router.get("/getallusers", verifyToken, requireRole(["Admin"]), GetAllUsers);
router.get("/getcurrentuser", verifyToken, GetCurrentUser);
router.get("/profile", verifyToken, GetProfileName);
router.get("/geteasyboughtitems", verifyToken, GetEasyBoughtItems);
router.get("/easybuy-catalog-image/:model", GetEasyBuyCatalogImage);
router.get("/easybuy-catalog", verifyToken, requireRole(["Admin"]), GetEasyBuyCatalog);
router.post("/createeasyboughtitem", verifyToken, requireRole(["Admin"]), CreateEasyBoughtItem);

export default router
