import { Request } from 'express';

interface User {
  _id: string;
  userName: string;
  email: string;
  role: "User" | "Admin";
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
