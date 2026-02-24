import {GetProfileName} from '../Controller/ProfileController.js'
import express from "express";
const router = express.Router()
import { verifyToken, requireRole } from "../Middleware/verify.js";
router.get("/profile", verifyToken, GetProfileName);

export default router