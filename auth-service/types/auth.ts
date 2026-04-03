export type AuthRole = "user" | "admin" | "superadmin";

export type AuthApp = "easybuy" | "ecommerce" | "auth-service";

export type JwtUserPayload = {
  _id: string;
  email: string;
  fullName: string;
  role: AuthRole;
  jti: string;
  app: AuthApp;
};
