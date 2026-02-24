import multer from "multer";
import type { Request } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

type callBackDestination = (err: Error | null, destination: string) => void;
type fileNamecallBack = (err: Error | null, destination: string) => void;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDirectory = path.join(__dirname, "../Uploads/Products");

if (!fs.existsSync(uploadDirectory)) {
  fs.mkdirSync(uploadDirectory, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req: Request, file: any, cb: callBackDestination) {
    cb(null, uploadDirectory);
  },
  filename: function (req: Request, file: any, cb: fileNamecallBack) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
    );
  },
});
export const upload = multer({ storage: storage }).single("Image");
