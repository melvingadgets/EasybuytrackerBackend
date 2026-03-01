import cloud, { v2 } from "cloudinary";
import { config } from "../config/Config.js";
const cloudinary: typeof v2 = cloud.v2;

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
});
export default cloudinary;
