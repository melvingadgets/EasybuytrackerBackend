import {type Request, type Response} from "express";
import { getAuthMe } from "../Service/AuthService.js";

export const GetProfileName = async (req: Request, res: Response) => {
    try {
        const token = req.authToken;
        if (!token) {
            return res.status(401).json({ message: "Unauthorized" });
        }
        const payload = await getAuthMe(token);
        const profile = payload.data?.profile;
        if (!profile) {
            return res.status(404).json({ message: "Profile not found" });
        }
        return res.status(200).json({ data: profile });
        
    } catch (error: any) {
        console.error("Error fetching profile:", error);
        res.status(500).json({ message: error?.message || "Server error" });
    }
};
