import express from "express";
import { verifyToken } from "../Middleware/verify.js";
import { CreateEasyBuyPlan, CreatePayment, GetDashboard } from "../Controller/DashboardController.js";

const router = express.Router();

router.get("/dashboard", verifyToken, GetDashboard);
router.post("/plans", verifyToken, CreateEasyBuyPlan);
router.post("/payments", verifyToken, CreatePayment);

export default router;
