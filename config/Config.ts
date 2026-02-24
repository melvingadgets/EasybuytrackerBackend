import dotenv from 'dotenv'
dotenv.config()

const dbUrl = process.env.Database_url ?? process.env.DATABASE_URL
const portValue = process.env.PORT ?? process.env.port

const missingVars: string[] = []
if (!dbUrl) missingVars.push('Database_url (or DATABASE_URL)')
if (!portValue) missingVars.push('PORT (or port)')

if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`)
}

export const config = {
  port: Number(portValue),
  Database_url: String(dbUrl)
}
