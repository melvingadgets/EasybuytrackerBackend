import UserModel from "../Model/UserModel.js";
import { config } from "../config/Config.js";

export type AuthServiceRole = "user" | "admin" | "superadmin";
export type LegacyRole = "User" | "Admin" | "SuperAdmin";

export type AuthServiceUser = {
  _id: string;
  email: string;
  fullName: string;
  role: AuthServiceRole;
  emailVerified?: boolean;
  disabled?: boolean;
  originApp?: string;
};

export type LocalShadowUser = {
  _id: string;
  fullName: string;
  email: string;
  role: LegacyRole;
  createdUsers?: string[];
  createdByAdmin?: string | null;
  manualNextDueDate?: Date | null;
};

type AuthServiceResponse<T> = {
  data?: T;
  message?: string;
  reason?: string;
  success?: number;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  user?: AuthServiceUser;
};

const LEGACY_ROLE_MAP: Record<AuthServiceRole, LegacyRole> = {
  user: "User",
  admin: "Admin",
  superadmin: "SuperAdmin",
};

const AUTH_ROLE_MAP: Record<LegacyRole, AuthServiceRole> = {
  User: "user",
  Admin: "admin",
  SuperAdmin: "superadmin",
};

export const toLegacyRole = (role: string | undefined | null): LegacyRole => {
  if (role === "admin") return "Admin";
  if (role === "superadmin") return "SuperAdmin";
  return "User";
};

export const toAuthRole = (role: string | undefined | null): AuthServiceRole => {
  if (role === "Admin" || role === "admin") return "admin";
  if (role === "SuperAdmin" || role === "superadmin") return "superadmin";
  return "user";
};

const buildUrl = (path: string, query?: Record<string, string | number | undefined>) => {
  const url = new URL(path, `${config.auth.serviceUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
};

const buildHeaders = (args?: {
  token?: string;
  serviceKey?: boolean;
  contentType?: boolean;
}): HeadersInit => {
  const headers: Record<string, string> = {};
  if (args?.contentType !== false) {
    headers["Content-Type"] = "application/json";
  }
  if (args?.token) {
    headers.Authorization = `Bearer ${args.token}`;
  }
  if (args?.serviceKey && config.auth.serviceKey) {
    headers["x-service-key"] = config.auth.serviceKey;
  }
  return headers;
};

const readJson = async <T>(response: Response): Promise<AuthServiceResponse<T>> => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as AuthServiceResponse<T>;
  } catch {
    return {
      message: text,
    };
  }
};

export class AuthServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const requestAuthService = async <T>(args: {
  method?: string;
  path: string;
  token?: string;
  body?: Record<string, unknown>;
  query?: Record<string, string | number | undefined>;
  serviceKey?: boolean;
}) => {
  const headerArgs: { token?: string; serviceKey?: boolean; contentType?: boolean } = {
    contentType: args.body !== undefined,
  };
  if (args.token) {
    headerArgs.token = args.token;
  }
  if (args.serviceKey) {
    headerArgs.serviceKey = args.serviceKey;
  }

  const init: RequestInit = {
    method: args.method || "GET",
    headers: buildHeaders(headerArgs),
  };
  if (args.body !== undefined) {
    init.body = JSON.stringify(args.body);
  }

  const response = await fetch(buildUrl(args.path, args.query), init);

  const payload = await readJson<T>(response);
  if (!response.ok) {
    throw new AuthServiceError(response.status, payload.reason || payload.message || "Auth service request failed");
  }
  return payload;
};

export const syncLocalShadowUser = async (
  authUser: AuthServiceUser,
  extra?: Partial<{
    createdByAdmin: string | null;
    addCreatedUserToAdminId: string;
  }>
): Promise<LocalShadowUser | null> => {
  const update: Record<string, unknown> = {
    fullName: authUser.fullName,
    email: authUser.email.toLowerCase(),
    role: LEGACY_ROLE_MAP[authUser.role] || "User",
  };

  if (extra && Object.prototype.hasOwnProperty.call(extra, "createdByAdmin")) {
    update.createdByAdmin = extra.createdByAdmin ? extra.createdByAdmin : null;
  }

  const user = await UserModel.findOneAndUpdate(
    { _id: authUser._id },
    {
      $set: update,
      $setOnInsert: {
        createdUsers: [],
        manualNextDueDate: null,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();

  if (extra?.addCreatedUserToAdminId) {
    await UserModel.findByIdAndUpdate(extra.addCreatedUserToAdminId, {
      $addToSet: { createdUsers: authUser._id },
    });
  }

  if (!user) return null;

  return {
    _id: String(user._id),
    fullName: String(user.fullName || ""),
    email: String(user.email || ""),
    role: String(user.role || "User") as LegacyRole,
    createdUsers: Array.isArray(user.createdUsers)
      ? user.createdUsers.map((item: unknown) => String(item))
      : [],
    createdByAdmin: user.createdByAdmin ? String(user.createdByAdmin) : null,
    manualNextDueDate:
      user.manualNextDueDate instanceof Date || user.manualNextDueDate === null || user.manualNextDueDate === undefined
        ? (user.manualNextDueDate ?? null)
        : new Date(String(user.manualNextDueDate)),
  };
};

export const loginWithAuthService = async (email: string, password: string) =>
  requestAuthService<string>({
    method: "POST",
    path: "api/v1/auth/login",
    body: { email, password, app: "easybuy" },
  });

export const logoutWithAuthService = async (token: string) =>
  requestAuthService({
    method: "POST",
    path: "api/v1/auth/logout",
    token,
    body: {},
  });

export const getAuthMe = async (token: string) =>
  requestAuthService<{
    user: AuthServiceUser;
    profile: {
      firstName?: string;
      lastName?: string;
      phoneNumber?: string;
      dateOfBirth?: Date | null;
      gender?: string;
      address?: string;
      avatar?: string;
    } | null;
  }>({
    path: "api/v1/auth/me",
    token,
  });

export const createAuthUser = async (token: string, payload: {
  email: string;
  password: string;
  fullName: string;
  role: LegacyRole;
}) =>
  requestAuthService<{ user: AuthServiceUser }>({
    method: "POST",
    path: "api/v1/auth/admin/create-user",
    token,
    body: {
      email: payload.email,
      password: payload.password,
      fullName: payload.fullName,
      role: AUTH_ROLE_MAP[payload.role],
    },
  });

export const listAuthUsers = async (token: string, query?: Record<string, string | number | undefined>) =>
  requestAuthService<AuthServiceUser[]>({
    path: "api/v1/auth/admin/users",
    token,
    ...(query ? { query } : {}),
  });

export const getAuthUserById = async (token: string, userId: string) =>
  requestAuthService<AuthServiceUser & { profile?: unknown }>({
    path: `api/v1/auth/admin/users/${encodeURIComponent(userId)}`,
    token,
  });

export const deleteAuthUser = async (token: string, userId: string) =>
  requestAuthService<AuthServiceUser>({
    method: "DELETE",
    path: `api/v1/auth/admin/users/${encodeURIComponent(userId)}`,
    token,
  });

export const getAuthSessionStats = async (token: string) =>
  requestAuthService<{
    usersLoggedIn: number;
    adminsLoggedIn: number;
    superAdminsLoggedIn: number;
    totalLoggedIn: number;
  }>({
    path: "api/v1/auth/admin/sessions/stats",
    token,
  });

export const findAuthUserByEmail = async (token: string, email: string) => {
  const payload = await listAuthUsers(token, {
    search: email,
    limit: 50,
    page: 1,
  });

  const users = Array.isArray(payload.data) ? payload.data : [];
  const exact = users.find((user) => user.email.toLowerCase() === email.toLowerCase()) || null;
  if (exact) {
    await syncLocalShadowUser(exact);
  }
  return exact;
};
