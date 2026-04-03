import {type Request, type Response} from "express";
import ProfileModel from "../Model/Profilemodel.js";
import UserModel from "../Model/UserModel.js";

export const GetProfileName = async (req: Request, res: Response) => {
    try {
        const userId = req.user?._id;
        if (!userId) {
            return res.status(401).json({ message: "Unauthorized" });
        }
        const [user, profile] = await Promise.all([
            UserModel.findById(userId).lean(),
            ProfileModel.findOne({ _id: userId }).lean(),
        ]);

        if (!user && !profile) {
            return res.status(404).json({ message: "Profile not found" });
        }
        return res.status(200).json({
            data: {
                ...(profile || {}),
                _id: String(user?._id || profile?._id || ""),
                FullName: String(profile?.FullName || user?.fullName || ""),
                email: String(user?.email || ""),
                role: String(user?.role || "User"),
            },
        });
        
    } catch (error: any) {
        console.error("Error fetching profile:", error);
        res.status(500).json({ message: error?.message || "Server error" });
    }
};
