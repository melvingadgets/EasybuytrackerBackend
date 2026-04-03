import express, { type Application } from "express";
import cors from "cors";
import AuthRouter from "./Router/AuthRouter.js";
import AdminRouter from "./Router/AdminRouter.js";
import InternalRouter from "./Router/InternalRouter.js";

export const MainApp = (app: Application) => {
  app.use(express.json());
  app.use(cors());

  app.get("/api/v1", (_req, res) => {
    res.status(200).json({
      message: "Auth service is running successfully",
    });
  });

  app.use("/api/v1/auth", AuthRouter);
  app.use("/api/v1/auth/admin", AdminRouter);
  app.use("/api/v1/auth/internal", InternalRouter);
};
