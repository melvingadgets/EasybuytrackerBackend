import dotenv from 'dotenv'
dotenv.config()

const dbUrl = process.env.Database_url ?? process.env.DATABASE_URL
const portValue = process.env.PORT ?? process.env.port
const jwtSecret = String(process.env.JWT_SECRET ?? '').trim()
const gmailUser = String(process.env.GMAIL_USER ?? '').trim()
const gmailAppPassword = String(process.env.GMAIL_APP_PASSWORD ?? '').trim()
const mailFrom = String(process.env.MAIL_FROM ?? '').trim()
const cloudinaryCloudName = String(process.env.CLOUDINARY_CLOUD_NAME ?? '').trim()
const cloudinaryApiKey = String(process.env.CLOUDINARY_API_KEY ?? '').trim()
const cloudinaryApiSecret = String(process.env.CLOUDINARY_API_SECRET ?? '').trim()


const missingVars: string[] = []
if (!dbUrl) missingVars.push('Database_url (or DATABASE_URL)')
if (!portValue) missingVars.push('PORT (or port)')
if (!jwtSecret) missingVars.push('JWT_SECRET')
if (!gmailUser) missingVars.push('GMAIL_USER')
if (!gmailAppPassword) missingVars.push('GMAIL_APP_PASSWORD')
if (!mailFrom) missingVars.push('MAIL_FROM')
if (!cloudinaryCloudName) missingVars.push('CLOUDINARY_CLOUD_NAME')
if (!cloudinaryApiKey) missingVars.push('CLOUDINARY_API_KEY')
if (!cloudinaryApiSecret) missingVars.push('CLOUDINARY_API_SECRET')

if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`)
}

export const config = {
  port: Number(portValue),
  Database_url: String(dbUrl),
  jwtSecret,
  mail: {
    gmailUser,
    gmailAppPassword,
    mailFrom
  },
  cloudinary: {
    cloudName: cloudinaryCloudName,
    apiKey: cloudinaryApiKey,
    apiSecret: cloudinaryApiSecret
  }
}
