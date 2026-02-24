import {type Request, type Response} from "express";
import ProfileModel from "../Model/Profilemodel.js";

export const GetProfileName = async (req: Request, res: Response) => {
    try {
        const userId = req.user?._id;
        if (!userId) {
            return res.status(401).json({ message: "Unauthorized" });
        }
        const profile = await ProfileModel.findOne({ _id: userId });
        if (!profile) {
            return res.status(404).json({ message: "Profile not found" });
        }
        return res.status(200).json({ data: profile });
        
    } catch (error) {
        console.error("Error fetching profile:", error);
        res.status(500).json({ message: "Server error" });
    }
};