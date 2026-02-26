import express, { type Application } from "express";
import cors from "cors";
import userRouter from "./Router/UserRouter.js";
import dashboardRouter from "./Router/DashboardRouter.js";
import receiptRouter from "./Router/ReceiptRouter.js";
import profileRouter from "./Router/Profilerouter.js";
import superAdminRouter from "./Router/SuperAdminRouter.js";


export const MainApp = (app: Application) => {
  app.use(express.json());
  app.use(cors());
  app.get("/api/v1", (req, res) => {
    res.status(200).json({
      message: "Api is running successfully",
    });
  })
 app.use("/api/v1/user", userRouter);
 app.use("/api/v1/receipt", receiptRouter);
 app.use("/api", dashboardRouter);
 app.use("/api/v1/profile", profileRouter);
 app.use("/api/v1/superadmin", superAdminRouter);
  




}
