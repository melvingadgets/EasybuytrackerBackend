import type { Request } from "express";
import type { AuditActorRole } from "../Model/AuditLogModel.js";

/**
 * Narrows the verified caller's role to the two roles the audit log records.
 *
 * Every route that writes an audit row is gated on `easybuy.superadmin.access`, so in
 * practice this is always `SuperAdmin`. It is written as a narrowing rather than a
 * constant so that widening that permission later cannot quietly put a wrong role into
 * the audit trail: if the caller is not staff, the request fails instead.
 */
export const auditActorRole = (req: Request): AuditActorRole => {
  const role = req.user?.role;
  if (role === "Admin" || role === "SuperAdmin") return role;
  throw new Error("audit actor: the caller holds no staff role");
};
