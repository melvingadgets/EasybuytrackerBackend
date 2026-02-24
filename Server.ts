import express, { type Application } from "express";
import "./Database/Database.js";
import { config } from "./config/Config.js";
import { MainApp } from "./MainApp.js";
import path from "path";
import Db from "./Database/Database.js";
import type { Server } from "http";

const port = config.port;
const app: Application = express();

MainApp(app);
let server: Server;
// app.set("view engine", "ejs");
// app.set("Views", path.join(__dirname, "Views"));
async function startserver() {
  try {
    await Db;
    server = app.listen(port, () => {
      console.log(`server is listening on port: ${port}`);
    });
  } catch (error) {
    console.log("Database isnt Connecting");
  }
}
startserver()
process.on("uncaughtException", (error: Error) => {
  console.log("stop here:uncaughtexceptionerror");
  process.exit(1);
});
process.on("unhandledRejection", (reason: any) => {
  console.log(`an unhhandleld rejection error has occured ${reason}`);
  server.close(() => {
    process.exit(1);
  });
});
