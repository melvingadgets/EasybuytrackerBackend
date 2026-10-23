// Config.ts reads and validates the environment at import time; give it test values.
import { randomUUID } from "crypto";

process.env.Database_url = `${process.env.MONGO_TEST_URL ?? "mongodb://127.0.0.1:27017"}/easybuy_u2_test_${randomUUID().slice(0, 8)}`;
process.env.PORT = "0";
process.env.JWT_SECRET = "easybuy-test-secret";
process.env.MAIL_FROM = "test@example.com";
process.env.MAIL_PROVIDER = "smtp";
process.env.GMAIL_USER = "test@example.com";
process.env.GMAIL_APP_PASSWORD = "unused";
process.env.CLOUDINARY_CLOUD_NAME = "test";
process.env.CLOUDINARY_API_KEY = "test";
process.env.CLOUDINARY_API_SECRET = "test";
delete process.env.AUTH_ISSUER;
