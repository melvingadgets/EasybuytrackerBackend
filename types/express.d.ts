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
      traceId?: string;
      // Set by service-token verification once services authenticate to each other.
      service?: {
        id: string;
      };
    }
  }
}
