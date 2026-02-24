import dotenv from 'dotenv'
dotenv.config()

const requiredEnvVariables=['Database_url','port']
for (const items of requiredEnvVariables){
    if(!process.env[items]){
        throw new Error ('an environmental variable  has not been congigured')
    }
};

export const config = {
  port: Number(process.env.port),
  Database_url:String(process.env.Database_url)
};