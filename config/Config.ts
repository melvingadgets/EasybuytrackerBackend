import dotenv from 'dotenv'
dotenv.config()

const dbUrl = process.env.Database_url ?? process.env.DATABASE_URL
const portValue = process.env.PORT ?? process.env.port
const jwtSecret = String(process.env.JWT_SECRET ?? '').trim()
// Platform tokens (Shortwork/AGENTS.md §2): the auth service's public URL is the token
// issuer, and its JWKS holds the keys. Unset leaves the service-token routes answering 503.
const authIssuer = String(process.env.AUTH_ISSUER ?? '').trim().replace(/\/+$/, '')
// Where calls to the auth service go (profile lookup on a person's first unified login). Defaults to
// the issuer, which is that same service, so production needs no second variable; a blank
// AUTH_SERVICE_URL counts as unset. Local development still falls back to the dev auth service.
const authServiceUrlRaw = String(process.env.AUTH_SERVICE_URL ?? '').trim()
const authServiceUrl = (authServiceUrlRaw || authIssuer || 'http://localhost:5500').replace(/\/+$/, '')
const authJwtSecret = String(process.env.AUTH_JWT_SECRET ?? jwtSecret).trim()
const authServiceKey = String(process.env.AUTH_SERVICE_KEY ?? '').trim()
const mailProviderRaw = String(process.env.MAIL_PROVIDER ?? 'smtp').trim().toLowerCase()
const mailProvider = mailProviderRaw === 'resend' ? 'resend' : 'smtp'
const gmailUser = String(process.env.GMAIL_USER ?? '').trim()
const gmailAppPassword = String(process.env.GMAIL_APP_PASSWORD ?? '').trim()
const resendApiKey = String(process.env.RESEND_API_KEY ?? '').trim()
const mailFrom = String(process.env.MAIL_FROM ?? '').trim()
const cloudinaryCloudName = String(process.env.CLOUDINARY_CLOUD_NAME ?? '').trim()
const cloudinaryApiKey = String(process.env.CLOUDINARY_API_KEY ?? '').trim()
const cloudinaryApiSecret = String(process.env.CLOUDINARY_API_SECRET ?? '').trim()
const authJwksUrl = String(process.env.AUTH_JWKS_URL ?? (authIssuer ? `${authIssuer}/.well-known/jwks.json` : '')).trim()
// Publish domain events to the outbox (Shortwork/AGENTS.md §3). Off by default so the rollout is
// additive (§7.1); needs a replica set (Atlas is one). Turn on once the relay is running.
const eventsEnabled = String(process.env.EVENTS_ENABLED ?? '').trim().toLowerCase() === 'true'
// The EasyBuy service charge (RESELLER-PLAN.md §8b): 8% (800 basis points), paid with the down
// payment and never refunded. The platform keeps half and a referring reseller earns half; with no
// reseller the platform keeps all of it. The base defaults to the financed amount (phone price minus
// down payment), an assumption logged in MOCK-DATA-REVIEW.md; EASYBUY_SERVICE_FEE_BASE=price charges
// it on the full phone price instead.
const serviceFeeBpsRaw = Number(String(process.env.EASYBUY_SERVICE_FEE_BPS ?? '800').trim())
const serviceFeeBps = Number.isInteger(serviceFeeBpsRaw) && serviceFeeBpsRaw >= 0 && serviceFeeBpsRaw <= 10_000 ? serviceFeeBpsRaw : 800
const serviceFeeBase = String(process.env.EASYBUY_SERVICE_FEE_BASE ?? '').trim().toLowerCase() === 'price' ? 'price' : 'financed'


const missingVars: string[] = []
if (!dbUrl) missingVars.push('Database_url (or DATABASE_URL)')
if (!portValue) missingVars.push('PORT (or port)')
if (!jwtSecret) missingVars.push('JWT_SECRET')
if (!mailFrom) missingVars.push('MAIL_FROM')
if (!cloudinaryCloudName) missingVars.push('CLOUDINARY_CLOUD_NAME')
if (!cloudinaryApiKey) missingVars.push('CLOUDINARY_API_KEY')
if (!cloudinaryApiSecret) missingVars.push('CLOUDINARY_API_SECRET')
if (mailProvider === 'smtp') {
  if (!gmailUser) missingVars.push('GMAIL_USER (required when MAIL_PROVIDER=smtp)')
  if (!gmailAppPassword) missingVars.push('GMAIL_APP_PASSWORD (required when MAIL_PROVIDER=smtp)')
}
if (mailProvider === 'resend' && !resendApiKey) {
  missingVars.push('RESEND_API_KEY (required when MAIL_PROVIDER=resend)')
}

if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`)
}

export const config = {
  port: Number(portValue),
  Database_url: String(dbUrl),
  jwtSecret,
  auth: {
    serviceUrl: authServiceUrl,
    jwtSecret: authJwtSecret,
    serviceKey: authServiceKey,
    issuer: authIssuer,
    jwksUrl: authJwksUrl,
  },
  eventsEnabled,
  serviceFee: {
    bps: serviceFeeBps,
    base: serviceFeeBase as 'financed' | 'price',
  },
  mail: {
    provider: mailProvider as 'smtp' | 'resend',
    mailFrom,
    smtp: {
      gmailUser,
      gmailAppPassword
    },
    resend: {
      apiKey: resendApiKey
    }
  },
  cloudinary: {
    cloudName: cloudinaryCloudName,
    apiKey: cloudinaryApiKey,
    apiSecret: cloudinaryApiSecret
  }
}
