import EasyBuyPlanModel from "../Model/EasyBuyPlanModel.js";
import PaymentModel from "../Model/PaymentModel.js";
import mongoose from "mongoose";

type DashboardMetrics = {
  totalAmount: number;
  totalPaid: number;
  remainingBalance: number;
  progress: number;
  nextPaymentDue: Date | null;
  nextPaymentAmount: number;
  planStatus: "active" | "completed" | "cancelled";
  recentPayments: Array<{
    amount: number;
    status: "paid" | "pending" | "approved" | "failed";
    paymentMethod: "card" | "bank" | "wallet" | "receipt";
    paidAt: Date;
  }>;
};

const addMonths = (date: Date, months: number): Date => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};

const getTotalPaidForPlan = async (userId: string, planId: string): Promise<number> => {
  const [result] = await PaymentModel.aggregate([
    {
      $match: {
        user: new mongoose.Types.ObjectId(userId),
        plan: new mongoose.Types.ObjectId(planId),
        status: { $in: ["paid", "approved"] },
      },
    },
    {
      $group: {
        _id: null,
        totalPaid: { $sum: "$amount" },
      },
    },
  ]);
  return result?.totalPaid ?? 0;
};

export const getLatestActivePlanForUser = async (userId: string) => {
  const plans = await EasyBuyPlanModel.find({ user: userId }).sort({ createdAt: -1 }).lean();
  for (const plan of plans) {
    const paid = await getTotalPaidForPlan(userId, plan._id.toString());
    if (paid < plan.totalAmount) {
      return plan;
    }
  }
  return null;
};

export const getDashboardMetrics = async (userId: string): Promise<DashboardMetrics | null> => {
  const activePlan = (await getLatestActivePlanForUser(userId)) || (await EasyBuyPlanModel.findOne({ user: userId }).sort({ createdAt: -1 }).lean());

  if (!activePlan) {
    return null;
  }

  const totalPaid = await getTotalPaidForPlan(userId, activePlan._id.toString());
  const remainingBalance = Math.max(activePlan.totalAmount - totalPaid, 0);
  const progress =
    activePlan.totalAmount > 0 ? Math.min((totalPaid / activePlan.totalAmount) * 100, 100) : 0;

  const normalizedStatus: "active" | "completed" = totalPaid >= activePlan.totalAmount ? "completed" : "active";

  // Deterministic monthly schedule:
  // payment #1 is due on startDate.
  // Next due month offset is number of successful paid payments.
  const paidCount = await PaymentModel.countDocuments({
    user: userId,
    plan: activePlan._id,
    status: "paid",
  });
  const nextPaymentDue =
    normalizedStatus === "active" ? addMonths(new Date(activePlan.startDate), paidCount) : activePlan.endDate || null;

  const nextPaymentAmount = normalizedStatus === "active" ? remainingBalance : 0;

  const recentPayments = await PaymentModel.find({ user: userId, plan: activePlan._id })
    .sort({ paidAt: -1 })
    .limit(10)
    .select({ _id: 0, amount: 1, status: 1, paymentMethod: 1, paidAt: 1 })
    .lean();

  return {
    totalAmount: activePlan.totalAmount,
    totalPaid,
    remainingBalance,
    progress: Number(progress.toFixed(2)),
    nextPaymentDue,
    nextPaymentAmount,
    planStatus: normalizedStatus,
    recentPayments: recentPayments as DashboardMetrics["recentPayments"],
  };
};
