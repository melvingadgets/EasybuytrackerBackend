import UserModel from "../Model/UserModel.js";
import { config } from "../config/Config.js";
import { isPlatformRole, type PlatformRole } from "@melvingadgets/platform-kit";

export type AuthServiceRole = "user" | "admin" | "superadmin";

export type AuthServiceUser = {
  _id: string;
  email: string;
  fullName: string;
  // Auth's canonical platform roles are `User | Admin | SuperAdmin` (rules §4.4). Older
  // deployments answered in lowercase, so this stays a plain `string` at the boundary and is
  // parsed by `parsePlatformRole` on the way in — never coerced.
  role: PlatformRole | AuthServiceRole | string;
  emailVerified?: boolean;
  disabled?: boolean;
  originApp?: string;
};

export type LocalShadowUser = {
  _id: string;
  fullName: string;
  email: string;
  role: PlatformRole;
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

/**
 * Parses a role coming from auth into the canonical platform spelling.
 *
 * The old `toLegacyRole` fell back to `"User"` for anything it did not recognise, which turned a
 * malformed role into a working, under-privileged account. There is no fallback here: an unknown
 * or missing role throws, the caller's request fails, and an operator sees it.
 *
 * Lowercase is still accepted on input because auth itself accepts it (`normalizeRoleInput`), and
 * a mixed fleet may still answer that way. Both spellings resolve to the same canonical value, so
 * neither casing can silently demote anybody.
 */
export const parsePlatformRole = (role: unknown): PlatformRole => {
  if (isPlatformRole(role)) return role;
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "user") return "User";
  if (normalized === "admin") return "Admin";
  if (normalized === "superadmin") return "SuperAdmin";
  throw new Error(`unknown role from auth: ${JSON.stringify(role ?? null)}`);
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
    role: parsePlatformRole(authUser.role),
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
    // No `|| "User"`: this row was just upserted with a canonical role, so a value that no
    // longer parses means something else wrote it, and the caller must find out.
    role: parsePlatformRole(user.role),
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
  role: PlatformRole;
}) =>
  requestAuthService<{ user: AuthServiceUser }>({
    method: "POST",
    path: "api/v1/auth/admin/create-user",
    token,
    body: {
      email: payload.email,
      password: payload.password,
      fullName: payload.fullName,
      role: payload.role,
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

export const sendAuthServiceEmail = async (payload: {
  to: string;
  subject: string;
  template?: string;
  context?: Record<string, unknown>;
  html?: string;
  text?: string;
}) => {
  return requestAuthService<{ success: boolean; messageId?: string; simulated?: boolean }>({
    method: "POST",
    path: "api/v1/auth/internal/mail/send",
    serviceKey: true,
    body: payload,
  });
};
