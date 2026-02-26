import { Request } from 'express';

interface User {
  _id: string;
  userName: string;
  email: string;
  role: "User" | "Admin" | "SuperAdmin";
  jti?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
      authToken?: string;
    }
  }
}
