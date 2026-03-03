import { renderEmailTemplate } from "./EmailTemplates.js";
import { config } from "../config/Config.js";

const mailProvider = config.mail.provider;
const gmailUser = config.mail.smtp.gmailUser;
const gmailAppPassword = config.mail.smtp.gmailAppPassword;
const resendApiKey = config.mail.resend.apiKey;
const mailFrom = config.mail.mailFrom;

type TransportSlot = "gmail465" | "gmail587";

const SMTP_CONNECTION_TIMEOUT_MS = 15000;
const SMTP_GREETING_TIMEOUT_MS = 15000;
const SMTP_SOCKET_TIMEOUT_MS = 30000;

const transportSettings: Record<TransportSlot, { host: string; port: number; secure: boolean; requireTLS: boolean }> = {
  gmail465: {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    requireTLS: false,
  },
  gmail587: {
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
  },
};

let transporterBySlot: Partial<Record<TransportSlot, any>> = {};
let cachedNodemailer: any = null;

const loadNodemailer = async () => {
  if (cachedNodemailer) return cachedNodemailer;
  const mod: any = await import("nodemailer");
  cachedNodemailer = mod?.default || mod;
  return cachedNodemailer;
};

const getTransporter = async (slot: TransportSlot) => {
  const existing = transporterBySlot[slot];
  if (existing) return existing;
  if (!gmailUser || !gmailAppPassword) {
    throw new Error("Email transport is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.");
  }

  const nodemailer = await loadNodemailer();
  const setting = transportSettings[slot];
  const created = nodemailer.createTransport({
    host: setting.host,
    port: setting.port,
    secure: setting.secure,
    requireTLS: setting.requireTLS,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    tls: {
      minVersion: "TLSv1.2",
    },
    auth: {
      user: gmailUser,
      pass: gmailAppPassword,
    },
  });

  transporterBySlot[slot] = created;
  return created;
};

const describeError = (error: any) => {
  const code = String(error?.code || "");
  const responseCode = String(error?.responseCode || "");
  const command = String(error?.command || "");
  const response = String(error?.response || "");
  const message = String(error?.message || "Unknown mail error");

  return [message, code && `code=${code}`, responseCode && `responseCode=${responseCode}`, command && `command=${command}`, response && `response=${response}`]
    .filter(Boolean)
    .join(" | ");
};

const sendWithResendApi = async (mailOptions: { from: string; to: string; subject: string; html: string }) => {
  if (!resendApiKey) {
    throw new Error("Email transport is not configured. Set RESEND_API_KEY.");
  }

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: mailOptions.from,
        to: [mailOptions.to],
        subject: mailOptions.subject,
        html: mailOptions.html,
      }),
    });
  } catch (error: any) {
    throw new Error(`Resend API network error: ${describeError(error)}`);
  }

  if (!response.ok) {
    const errorBody = String(await response.text()).slice(0, 500);
    throw new Error(`Resend API request failed (status=${response.status}): ${errorBody}`);
  }
};

const sendWithFallback = async (mailOptions: { from: string; to: string; subject: string; html: string }) => {
  const attempts: Array<{ slot: TransportSlot; error: string }> = [];
  const order: TransportSlot[] = ["gmail465", "gmail587"];

  for (const slot of order) {
    try {
      const transport = await getTransporter(slot);
      await transport.sendMail(mailOptions);
      if (attempts.length > 0) {
        console.warn(`[mailer] primary smtp failed, fallback succeeded on ${slot}`);
      }
      return;
    } catch (error: any) {
      const described = describeError(error);
      attempts.push({ slot, error: described });
      transporterBySlot[slot] = null;
      console.error(`[mailer] send attempt failed on ${slot}: ${described}`);
    }
  }

  const summary = attempts.map((item) => `${item.slot}: ${item.error}`).join(" || ");
  throw new Error(`All SMTP attempts failed. ${summary}`);
};

export const sendEasyBuyVerificationEmail = async (payload: {
  to: string;
  fullName: string;
  verifyUrl: string;
  requestId: string;
  iphoneModel: string;
  capacity: string;
  plan: "Monthly" | "Weekly";
}) => {
  if (!mailFrom) {
    throw new Error("MAIL_FROM must be set for outbound email");
  }

  const html = await renderEmailTemplate("easybuy-request-verify.ejs", {
    fullName: payload.fullName,
    verifyUrl: payload.verifyUrl,
    requestId: payload.requestId,
    iphoneModel: payload.iphoneModel,
    capacity: payload.capacity,
    plan: payload.plan,
  });

  const mailOptions = {
    from: mailFrom,
    to: payload.to,
    subject: `Verify your EasyBuy request (${payload.requestId})`,
    html,
  };

  if (mailProvider === "resend") {
    await sendWithResendApi(mailOptions);
    return;
  }

  await sendWithFallback(mailOptions);
};
