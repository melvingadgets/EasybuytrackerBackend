import { type Request, type Response } from "express";
import mongoose from "mongoose";
import AuditLogModel from "../Model/AuditLogModel.js";
import EasyBoughtItemModel from "../Model/EasyBoughtitem.js";
import EasyBuyPlanModel from "../Model/EasyBuyPlanModel.js";
import PaymentModel from "../Model/PaymentModel.js";
import ProfileModel from "../Model/Profilemodel.js";
import ReceiptModel from "../Model/ReceiptModel.js";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";

const normalizeReason = (value: unknown) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || "No reason provided";
};

export const SuperAdminGetAllUsers = async (_req: Request, res: Response) => {
  try {
    const users = await UserModel.find()
      .select("-password")
      .populate("createdByAdmin", "fullName email role")
      .lean();

    return res.status(200).json({
      message: "Users retrieved successfully",
      total: users.length,
      data: users,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve users",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminGetUsersWithEasyBoughtItems = async (_req: Request, res: Response) => {
  try {
    const users = await UserModel.find().select("-password").lean();
    if (!users.length) {
      return res.status(200).json({
        message: "Users retrieved successfully",
        total: 0,
        data: [],
      });
    }

    const userIds = users.map((user) => user._id);
    const easyBoughtItems = await EasyBoughtItemModel.find({ UserId: { $in: userIds } }).lean();

    const itemMap = new Map<string, Array<(typeof easyBoughtItems)[number]>>();
    for (const item of easyBoughtItems) {
      const userIdKey = String(item.UserId);
      const current = itemMap.get(userIdKey) || [];
      current.push(item);
      itemMap.set(userIdKey, current);
    }

    const usersWithItems = users.map((user) => ({
      ...user,
      easyBoughtItems: itemMap.get(String(user._id)) || [],
    }));

    return res.status(200).json({
      message: "Users and EasyBoughtItems retrieved successfully",
      total: usersWithItems.length,
      data: usersWithItems,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve users with EasyBoughtItems",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SuperAdminDeleteUserOrAdmin = async (req: Request, res: Response) => {
  const actorId = req.user?._id;
  const actorRole = req.user?.role;
  const { userId } = req.params;

  if (!actorId || actorRole !== "SuperAdmin") {
    return res.status(401).json({
      message: "Access denied",
    });
  }

  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({
      message: "A valid userId is required",
    });
  }

  if (actorId === userId) {
    return res.status(400).json({
      message: "SuperAdmin cannot delete their own account",
    });
  }

  const reason = normalizeReason(req.body?.reason);

  const targetUser = await UserModel.findById(userId)
    .select("_id role email fullName")
    .lean();

  if (!targetUser) {
    return res.status(404).json({
      message: "User not found",
    });
  }

  if (!["User", "Admin"].includes(targetUser.role)) {
    return res.status(403).json({
      message: "Only User or Admin accounts can be deleted through this endpoint",
    });
  }

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      await UserModel.findByIdAndDelete(targetUser._id, { session });

      await UserModel.updateMany(
        {},
        { $pull: { createdUsers: targetUser._id } },
        { session }
      );

      if (targetUser.role === "Admin") {
        await UserModel.updateMany(
          { createdByAdmin: targetUser._id },
          { $set: { createdByAdmin: null } },
          { session }
        );
      }

      await Promise.all([
        EasyBoughtItemModel.deleteMany({ UserId: targetUser._id }, { session }),
        EasyBuyPlanModel.deleteMany({ user: targetUser._id }, { session }),
        PaymentModel.deleteMany({ user: targetUser._id }, { session }),
        ReceiptModel.deleteMany({ user: targetUser._id }, { session }),
        SessionModel.deleteMany({ user: targetUser._id }, { session }),
        ProfileModel.deleteOne({ _id: targetUser._id }, { session }),
      ]);

      await AuditLogModel.create(
        [
          {
            actor: new mongoose.Types.ObjectId(actorId),
            actorRole: actorRole,
            action: "USER_DELETE",
            targetType: "user",
            targetId: targetUser._id,
            reason,
            metadata: {
              deletedUserRole: targetUser.role,
              deletedUserEmail: targetUser.email,
              deletedUserFullName: targetUser.fullName,
            },
          },
        ],
        { session }
      );
    });

    return res.status(200).json({
      message: `${targetUser.role} deleted successfully`,
      data: {
        _id: targetUser._id,
        fullName: targetUser.fullName,
        email: targetUser.email,
        role: targetUser.role,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to delete user",
      reason: error?.message || "Unknown error",
    });
  } finally {
    await session.endSession();
  }
};

export const SuperAdminGetLoginStats = async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const groupedActiveSessions = await SessionModel.aggregate([
      {
        $match: {
          active: true,
          expiresAt: { $gt: now },
          role: { $in: ["User", "Admin", "SuperAdmin"] },
        },
      },
      {
        $group: {
          _id: "$role",
          uniqueUsers: { $addToSet: "$user" },
        },
      },
      {
        $project: {
          _id: 0,
          role: "$_id",
          count: { $size: "$uniqueUsers" },
        },
      },
    ]);

    const roleCounts = groupedActiveSessions.reduce<Record<string, number>>((acc, item) => {
      acc[String(item.role)] = Number(item.count || 0);
      return acc;
    }, {});

    const usersLoggedIn = roleCounts.User || 0;
    const adminsLoggedIn = roleCounts.Admin || 0;
    const superAdminsLoggedIn = roleCounts.SuperAdmin || 0;

    return res.status(200).json({
      message: "Login statistics retrieved successfully",
      data: {
        usersLoggedIn,
        adminsLoggedIn,
        superAdminsLoggedIn,
        totalLoggedIn: usersLoggedIn + adminsLoggedIn + superAdminsLoggedIn,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve login statistics",
      reason: error?.message || "Unknown error",
    });
  }
};
