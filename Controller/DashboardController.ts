import { type Request, type Response } from "express";
import EasyBuyPlanModel from "../Model/EasyBuyPlanModel.js";
import PaymentModel from "../Model/PaymentModel.js";
import UserModel from "../Model/UserModel.js";
import EasyBoughtItemModel from "../Model/EasyBoughtitem.js";
import ReceiptModel from "../Model/ReceiptModel.js";
import mongoose from "mongoose";
import { getDashboardMetrics, getLatestActivePlanForUser } from "../Service/DashboardService.js";

const normalizeFullName = (firstName?: string, lastName?: string, fullName?: string) => {
  if (fullName?.trim()) return fullName.trim();
  return `${firstName || ""} ${lastName || ""}`.trim();
};

const getEasyBoughtItemTotals = async (userId: string) => {
  const [items, approvedReceipts] = await Promise.all([
    EasyBoughtItemModel.find({ UserId: new mongoose.Types.ObjectId(userId) })
      .select({ Plan: 1, weeklyPlan: 1, monthlyPlan: 1, loanedAmount: 1, PhonePrice: 1, TotalPrice: 1, downPayment: 1 })
      .lean(),
    ReceiptModel.find({
      user: new mongoose.Types.ObjectId(userId),
      status: "approved",
    })
      .select({ amount: 1 })
      .lean(),
  ]);

  let totalPhonePrice = 0;
  let totalDownPayment = 0;
  let totalSupposedToBePaid = 0;

  for (const item of items as any[]) {
    const phonePrice = Number(item.PhonePrice ?? item.TotalPrice ?? 0);
    const downPayment = Math.max(Number(item.downPayment ?? 0), 0);
    const loanedAmount = getItemLoanedAmount(item);

    let markupMultiplier = 1;
    if (item.Plan === "Monthly") {
      const months = Number(item.monthlyPlan || 0);
      markupMultiplier = getMonthlyMarkupMultiplier(months);
    } else {
      const weeks = Number(item.weeklyPlan || 0);
      markupMultiplier = getWeeklyMarkupMultiplier(weeks);
    }

    const totalInstallmentPayable = loanedAmount * markupMultiplier;

    totalPhonePrice += phonePrice;
    totalDownPayment += downPayment;
    totalSupposedToBePaid += downPayment + totalInstallmentPayable;
  }

  const totalApprovedReceiptsPaid = approvedReceipts.reduce(
    (sum, receipt: any) => sum + Math.max(Number(receipt.amount || 0), 0),
    0
  );
  const totalPaid = totalDownPayment + totalApprovedReceiptsPaid;
  const remainingBalance = Math.max(totalSupposedToBePaid - totalPaid, 0);

  return {
    totalAmount: Number(totalPhonePrice.toFixed(2)),
    totalPaid: Number(totalPaid.toFixed(2)),
    remainingBalance: Number(remainingBalance.toFixed(2)),
  };
};


const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const getNextRecurringDueDate = (startDate: Date, intervalDays: number) => {
  const now = new Date();
  if (startDate > now) return startDate;

  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
  const elapsedMs = now.getTime() - startDate.getTime();
  const periodsElapsed = Math.floor(elapsedMs / intervalMs) + 1;
  return new Date(startDate.getTime() + periodsElapsed * intervalMs);
};

const getItemLoanedAmount = (item: {
  loanedAmount?: number | null;
  PhonePrice?: number | null;
  TotalPrice?: number | null;
  downPayment?: number | null;
}) => {
  if (typeof item.loanedAmount === "number" && Number.isFinite(item.loanedAmount)) {
    return Math.max(item.loanedAmount, 0);
  }
  const phonePrice = Number(item.PhonePrice ?? item.TotalPrice ?? 0);
  const downPayment = Number(item.downPayment ?? 0);
  return Math.max(phonePrice - downPayment, 0);
};

const getWeeklyMarkupMultiplier = (weeks: number) => {
  if (weeks === 4) return 1.2;
  if (weeks === 8) return 1.4;
  if (weeks === 12) return 1.5;
  return 1;
};

const getMonthlyMarkupMultiplier = (months: number) => {
  if (months === 1) return 1.2;
  if (months === 2) return 1.4;
  if (months === 3) return 1.6;
  return 1;
};

const getEasyBoughtItemsNextPaymentAmount = async (
  userId: string,
  duePlan?: "Monthly" | "Weekly" | null
): Promise<number> => {
  const items = await EasyBoughtItemModel.find({ UserId: new mongoose.Types.ObjectId(userId) })
    .select({ Plan: 1, weeklyPlan: 1, monthlyPlan: 1, loanedAmount: 1, PhonePrice: 1, TotalPrice: 1, downPayment: 1 })
    .lean();

  if (!items.length) return 0;

  const filteredItems = duePlan ? items.filter((item: any) => item.Plan === duePlan) : items;
  if (!filteredItems.length) return 0;

  const totalDue = filteredItems.reduce((sum, item: any) => {
    const loanedAmount = getItemLoanedAmount(item);
    if (item.Plan === "Monthly") {
      const months = Number(item.monthlyPlan || 0);
      if (months <= 0) return sum;
      const nextPayment = (loanedAmount * getMonthlyMarkupMultiplier(months)) / months;
      return sum + nextPayment;
    }

    const weeks = Number(item.weeklyPlan || 0);
    if (weeks <= 0) return sum;
    const nextPayment = (loanedAmount * getWeeklyMarkupMultiplier(weeks)) / weeks;
    return sum + nextPayment;
  }, 0);

  return Number(totalDue.toFixed(2));
};

const getEasyBoughtItemsNextDueDate = async (
  userId: string
): Promise<{ dueDate: Date | null; duePlan: "Monthly" | "Weekly" | null }> => {
  const items = await EasyBoughtItemModel.find({ UserId: new mongoose.Types.ObjectId(userId) })
    .select({ Plan: 1, createdAt: 1 })
    .lean();

  if (!items.length) return { dueDate: null, duePlan: null };

  let nearestDue: Date | null = null;
  let nearestPlan: "Monthly" | "Weekly" | null = null;

  for (const item of items) {
    const fallbackCreatedAt = (item._id as mongoose.Types.ObjectId).getTimestamp();
    const createdAt = item.createdAt ? new Date(item.createdAt) : fallbackCreatedAt;
    const intervalDays = item.Plan === "Monthly" ? 30 : 7;
    const firstDueDate = addDays(createdAt, intervalDays);
    const nextDueDate = getNextRecurringDueDate(firstDueDate, intervalDays);

    if (!nearestDue || nextDueDate < nearestDue) {
      nearestDue = nextDueDate;
      nearestPlan = item.Plan === "Monthly" ? "Monthly" : "Weekly";
    }
  }

  return { dueDate: nearestDue, duePlan: nearestPlan };
};

const getApprovedReceiptAmountForCurrentCycle = async (args: {
  userId: string;
  duePlan: "Monthly" | "Weekly";
  nextDueDate: Date;
}) => {
  const { userId, duePlan, nextDueDate } = args;
  const intervalDays = duePlan === "Weekly" ? 7 : 30;
  const previousDueDate = addDays(nextDueDate, -intervalDays);

  const receipts = await ReceiptModel.find({
    user: new mongoose.Types.ObjectId(userId),
    status: "approved",
    plan: duePlan,
    approvedAt: {
      $gte: previousDueDate,
      $lt: nextDueDate,
    },
  })
    .select({ amount: 1 })
    .lean();

  return Number(
    receipts.reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0).toFixed(2)
  );
};

const getRecentApprovedReceiptPayments = async (userId: string) => {
  const receipts = await ReceiptModel.find({
    user: new mongoose.Types.ObjectId(userId),
    status: "approved",
  })
    .sort({ approvedAt: -1, createdAt: -1 })
    .limit(10)
    .select({ amount: 1, approvedAt: 1, createdAt: 1 })
    .lean();

  return receipts.map((receipt) => ({
    amount: Number(receipt.amount || 0),
    status: "approved" as const,
    paymentMethod: "receipt" as const,
    paidAt: new Date(receipt.approvedAt || receipt.createdAt || new Date()),
  }));
};

const applyReceiptAdjustmentToDue = (args: {
  nextPaymentAmount: number;
  nextPaymentDue: Date | null;
  receiptAmount: number;
  duePlan: "Monthly" | "Weekly";
}) => {
  const { nextPaymentAmount, nextPaymentDue, receiptAmount, duePlan } = args;
  const safeDueAmount = Math.max(Number(nextPaymentAmount || 0), 0);
  const safeReceiptAmount = Math.max(Number(receiptAmount || 0), 0);

  if (safeDueAmount <= 0 || safeReceiptAmount <= 0) {
    return {
      nextPaymentAmount: safeDueAmount,
      nextPaymentDue,
    };
  }

  const intervalDays = duePlan === "Weekly" ? 7 : 30;

  if (safeReceiptAmount < safeDueAmount) {
    // Partial settlement for current cycle only.
    return {
      nextPaymentAmount: Number((safeDueAmount - safeReceiptAmount).toFixed(2)),
      nextPaymentDue,
    };
  }

  // Full settlement of current cycle; shift to the next cycle and roll over any overpayment as credit.
  const installmentAmount = safeDueAmount;
  const overpaymentCredit = safeReceiptAmount - installmentAmount;
  const additionallyCoveredCycles =
    installmentAmount > 0 ? Math.floor(overpaymentCredit / installmentAmount) : 0;
  const remainingCredit =
    installmentAmount > 0 ? overpaymentCredit % installmentAmount : 0;

  const totalCyclesToAdvance = 1 + additionallyCoveredCycles;
  const shiftedDueDate = nextPaymentDue
    ? addDays(nextPaymentDue, intervalDays * totalCyclesToAdvance)
    : null;

  const upcomingDueAmount = Number(
    Math.max(installmentAmount - remainingCredit, 0).toFixed(2)
  );

  return {
    nextPaymentAmount: upcomingDueAmount,
    nextPaymentDue: shiftedDueDate,
  };
};

export const CreateEasyBuyPlan = async (req: Request, res: Response) => {
  try {
    const actorRole = req.user?.role;
    const actorId = req.user?._id;
    const { userId, totalAmount, startDate, endDate } = req.body;

    const targetUserId = actorRole === "Admin" && userId ? userId : actorId;
    if (!targetUserId) {
      return res.status(401).json({ message: "Access denied" });
    }

    const user = await UserModel.findById(targetUserId).lean();
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!totalAmount || !startDate) {
      return res.status(400).json({
        message: "totalAmount and startDate are required",
      });
    }

    if (Number(totalAmount) <= 0) {
      return res.status(400).json({
        message: "totalAmount must be greater than zero",
      });
    }

    const activePlan = await getLatestActivePlanForUser(targetUserId.toString());
    if (activePlan) {
      return res.status(409).json({
        message: "User already has an active plan",
      });
    }

    const createPayload: any = {
      user: targetUserId,
      totalAmount: Number(totalAmount),
      startDate: new Date(startDate),
    };
    if (endDate) {
      createPayload.endDate = new Date(endDate);
    }

    const plan = await EasyBuyPlanModel.create(createPayload);

    return res.status(201).json({
      message: "Plan created successfully",
      data: plan,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to create plan",
      reason: error?.message || "Unknown error",
    });
  }
};

export const CreatePayment = async (req: Request, res: Response) => {
  try {
    const actorRole = req.user?.role;
    const actorId = req.user?._id;
    const { userId, planId, amount, status = "paid", paymentMethod, paidAt } = req.body;

    const targetUserId = actorRole === "Admin" && userId ? userId : actorId;
    if (!targetUserId) {
      return res.status(401).json({ message: "Access denied" });
    }

    if (!amount || !paymentMethod) {
      return res.status(400).json({
        message: "amount and paymentMethod are required",
      });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({
        message: "amount must be greater than zero",
      });
    }

    const plan =
      (planId
        ? await EasyBuyPlanModel.findOne({ _id: planId, user: targetUserId }).lean()
        : await getLatestActivePlanForUser(targetUserId.toString())) || null;

    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    const dashboardBeforePayment = await getDashboardMetrics(targetUserId.toString());
    if (!dashboardBeforePayment || dashboardBeforePayment.planStatus !== "active") {
      return res.status(409).json({
        message: "Payments can only be added to active plans",
      });
    }

    const paymentPayload: any = {
      user: targetUserId,
      plan: plan._id,
      amount: Number(amount),
      status,
      paymentMethod,
    };
    if (paidAt) {
      paymentPayload.paidAt = new Date(paidAt);
    }

    const payment = await PaymentModel.create(paymentPayload);

    // Update status to completed when paid amount reaches total amount.
    const dashboard = await getDashboardMetrics(targetUserId.toString());
    const overpayment =
      status === "paid" && dashboard ? Math.max(dashboard.totalPaid - dashboard.totalAmount, 0) : 0;

    return res.status(201).json({
      message: "Payment recorded successfully",
      data: payment,
      overpayment,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to record payment",
      reason: error?.message || "Unknown error",
    });
  }
};

export const GetDashboard = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ message: "Access denied" });
    }

    const easyBoughtItemTotals = await getEasyBoughtItemTotals(userId.toString());
    const easyBoughtItemsDueMeta = await getEasyBoughtItemsNextDueDate(userId.toString());
    const easyBoughtItemsNextPaymentAmount = await getEasyBoughtItemsNextPaymentAmount(
      userId.toString(),
      easyBoughtItemsDueMeta.duePlan
    );
    const receiptHistory = await getRecentApprovedReceiptPayments(userId.toString());
    const currentCycleReceiptAmount =
      easyBoughtItemsDueMeta.dueDate && easyBoughtItemsDueMeta.duePlan
        ? await getApprovedReceiptAmountForCurrentCycle({
            userId: userId.toString(),
            duePlan: easyBoughtItemsDueMeta.duePlan,
            nextDueDate: easyBoughtItemsDueMeta.dueDate,
          })
        : 0;

    const adjustedDue =
      easyBoughtItemsDueMeta.duePlan && easyBoughtItemsDueMeta.dueDate
      ? applyReceiptAdjustmentToDue({
          nextPaymentAmount: easyBoughtItemsNextPaymentAmount,
          nextPaymentDue: easyBoughtItemsDueMeta.dueDate,
          receiptAmount: currentCycleReceiptAmount,
          duePlan: easyBoughtItemsDueMeta.duePlan,
        })
      : { nextPaymentAmount: easyBoughtItemsNextPaymentAmount, nextPaymentDue: easyBoughtItemsDueMeta.dueDate };

    const resolvedPlanStatus = adjustedDue.nextPaymentAmount !== 0 ? "active" : "completed";
    const dashboard = await getDashboardMetrics(userId.toString());
    if (!dashboard) {
      return res.status(200).json({
        totalAmount: easyBoughtItemTotals.totalAmount,
        totalPaid: easyBoughtItemTotals.totalPaid,
        remainingBalance: easyBoughtItemTotals.remainingBalance,
        progress: 0,
        nextPaymentDue: adjustedDue.nextPaymentDue,
        nextPaymentAmount: adjustedDue.nextPaymentAmount,
        planStatus: resolvedPlanStatus,
        recentPayments: receiptHistory,
      });
    }

    const mergedRecentPayments = [...dashboard.recentPayments, ...receiptHistory]
      .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime())
      .slice(0, 10);

    return res.status(200).json({
      ...dashboard,
      totalAmount: easyBoughtItemTotals.totalAmount,
      totalPaid: easyBoughtItemTotals.totalPaid,
      remainingBalance: easyBoughtItemTotals.remainingBalance,
      nextPaymentDue: adjustedDue.nextPaymentDue,
      nextPaymentAmount: adjustedDue.nextPaymentAmount,
      planStatus: resolvedPlanStatus,
      recentPayments: mergedRecentPayments,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to load dashboard",
      reason: error?.message || "Unknown error",
    });
  }
};

export const SeedLeanUser = async (req: Request, res: Response) => {
  try {
    const { firstName, lastName, fullName, email, password, role = "User" } = req.body;
    const normalizedName = normalizeFullName(firstName, lastName, fullName);

    if (!normalizedName || !email || !password) {
      return res.status(400).json({ message: "fullName/email/password are required" });
    }

    const existing = await UserModel.findOne({ email: String(email).toLowerCase() }).lean();
    if (existing) {
      return res.status(409).json({ message: "Email already in use" });
    }

    const user = await UserModel.create({
      fullName: normalizedName,
      email: String(email).toLowerCase(),
      password,
      role,
    });

    return res.status(201).json({
      message: "User seeded",
      data: { _id: user._id, fullName: user.fullName, email: user.email, role: user.role },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to seed user",
      reason: error?.message || "Unknown error",
    });
  }
};


