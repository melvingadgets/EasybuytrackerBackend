import mongoose from "mongoose";
import { config } from "../config/Config.js";

const LocalUrl = config.Database_url;

const Db = mongoose.connect(LocalUrl);
Db.then(() => {
  console.log("Connection has been made to Database ");
}).catch((error: unknown) => {
  console.log(
    error,
    `The error message above is the reason why you can't connect to the Database at this time`,
  );
});
export default Db;
