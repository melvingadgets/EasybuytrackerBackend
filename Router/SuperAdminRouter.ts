import express from "express";
import { verifyToken, requireRole } from "../Middleware/verify.js";
import {
  SuperAdminDeleteUserOrAdmin,
  SuperAdminGetAllUsers,
  SuperAdminGetLoginStats,
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

export default router;
