/**
 * migrate-easybuy — link existing EasyBuy users to their auth-service personId.
 *
 * Why: once EasyBuy accepts unified tokens, a token carries the personId. Legacy
 * EasyBuy rows have their own _id, so without a link a returning customer would
 * get a fresh empty shadow (Shortwork/BACKEND-UNIFICATION §12.4). This sets
 * `personId` on each existing row, matched by email through the auth ADMIN API —
 * never by reading auth's database (AGENTS.md §1).
 *
 * Run (dry run first, always back up live data before the real run):
 *   DATABASE_URL=... AUTH_SERVICE_URL=... AUTH_ADMIN_TOKEN=<admin access token> \
 *     npx tsx migrate-easybuy.ts --dry-run
 *   ...then drop --dry-run to write.
 *
 * It prints a before/after reconciliation count (AGENTS.md §7.3). It never logs
 * emails (§6.3): only counts and personIds.
 */
import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { listAuthUsers, type AuthServiceUser } from "./Service/AuthService.js";

dotenv.config();

const databaseUrl = String(process.env.Database_url ?? process.env.DATABASE_URL ?? "").trim();
const adminToken = String(process.env.AUTH_ADMIN_TOKEN ?? "").trim();
const DRY_RUN = process.argv.includes("--dry-run");

async function run(): Promise<void> {
  if (!databaseUrl) throw new Error("Database_url (or DATABASE_URL) is required");
  if (!adminToken) {
    throw new Error("AUTH_ADMIN_TOKEN is required: an auth-service Admin/SuperAdmin access token used to look users up by email");
  }

  console.log(`Connecting to EasyBuy database${DRY_RUN ? " (dry run)" : ""}...`);
  await mongoose.connect(databaseUrl);
  const UserModel = (await import("./Model/UserModel.js")).default;

  const totalBefore = await UserModel.countDocuments({});
  const linkedBefore = await UserModel.countDocuments({ personId: { $ne: null } });

  const pending = await UserModel.find({
    email: { $exists: true, $ne: null },
    $or: [{ personId: null }, { personId: { $exists: false } }],
  })
    .select({ _id: 1, email: 1 })
    .lean();

  console.log(`Users total: ${totalBefore}, already linked: ${linkedBefore}, to check: ${pending.length}`);

  let linked = 0;
  let notFound = 0;
  let conflicts = 0;
  let lookupErrors = 0;

  for (const row of pending) {
    const email = String(row.email || "").trim().toLowerCase();
    if (!email) continue;

    let authUser: AuthServiceUser | null = null;
    try {
      const resp = await listAuthUsers(adminToken, { search: email, limit: 50, page: 1 });
      const candidates = Array.isArray(resp.data) ? resp.data : [];
      authUser = candidates.find((candidate) => candidate.email.toLowerCase() === email) ?? null;
    } catch (error) {
      lookupErrors++;
      console.error(`  ! lookup failed for user ${String(row._id)}: ${(error as Error).message}`);
      continue;
    }

    if (!authUser) {
      notFound++;
      continue;
    }

    // Respect the unique index: never move a personId already held by another row.
    const owner = await UserModel.findOne({ personId: authUser._id }).select({ _id: 1 }).lean();
    if (owner && String(owner._id) !== String(row._id)) {
      conflicts++;
      console.warn(`  ~ conflict: personId ${authUser._id} already linked to ${String(owner._id)} (skipping ${String(row._id)})`);
      continue;
    }

    if (!DRY_RUN) {
      await UserModel.updateOne({ _id: row._id }, { $set: { personId: authUser._id } });
    }
    linked++;
  }

  const linkedAfter = DRY_RUN
    ? linkedBefore
    : await UserModel.countDocuments({ personId: { $ne: null } });

  console.log("── reconciliation ──────────────────────────────");
  console.log(`  linked ${DRY_RUN ? "(would link)" : ""}: ${linked}`);
  console.log(`  no auth user found:               ${notFound}`);
  console.log(`  personId conflicts (skipped):     ${conflicts}`);
  console.log(`  lookup errors:                    ${lookupErrors}`);
  console.log(`  linked before → after:            ${linkedBefore} → ${linkedAfter}`);
  console.log("────────────────────────────────────────────────");

  await mongoose.disconnect();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
