// Config.ts reads and validates the environment at import time; give it test values.
import { randomUUID } from "crypto";
import dotenv from "dotenv";

// A replica set: the outbox needs multi-document transactions (as Atlas provides in production).
const host = process.env.MONGO_RS_HOST ?? "127.0.0.1:27028";
process.env.Database_url = `mongodb://${host}/easybuy_test_${randomUUID().slice(0, 8)}?directConnection=true`;
process.env.EVENTS_ENABLED = "true";
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

// Config.ts calls dotenv.config() at import, and vi.resetModules() makes it run again on every
// re-import — so a developer's .env rewrote whatever a test had just set up (an AUTH_SERVICE_URL in
// .env broke the "falls back to AUTH_ISSUER" case). Tests own the environment; .env is for running
// the service locally. This runs before any test file imports Config, so the replacement is in place.
dotenv.config = () => ({ parsed: {} });
