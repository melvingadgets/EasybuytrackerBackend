import { Request } from 'express';
import type { DomainRole, ServiceCaller, UserCaller } from '@melvingadgets/platform-kit';

interface User {
  _id: string;
  userName: string;
  email: string;
  role: "User" | "Admin" | "SuperAdmin";
  // Verified from the token. Never synthesised: a missing role is a 401, not "User".
  domainRoles?: readonly DomainRole[];
  jti?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
      authToken?: string;
      traceId?: string;
      // A calling service, verified from its service token by the platform kit's guards.
      service?: ServiceCaller;
      // A person verified from a platform user token.
      person?: UserCaller;
      // Set by the platform kit's guards; the request log records only verified callers.
      caller?: { type: "service" | "user" | "anonymous"; id?: string };
    }
  }
}
