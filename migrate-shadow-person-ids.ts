/**
 * migrate-shadow-person-ids: stamp `personId` on the shadow accounts made before shadows carried it
 * (E-2) and print a before/after count (Shortwork/AGENTS.md §7.3).
 *
 * New shadows get the field from syncLocalShadowUser. This reaches the existing ones, whose
 * `easybuy.payment.approved` events otherwise carry a null person. Every account with no personId is
 * checked against auth's people lookup, with EasyBuy's own service token (scope auth:people.read, §2),
 * never auth's database (§1.2):
 *   - auth knows the `_id`: it's a shadow, and gets that `_id` as its personId.
 *   - auth answers 404: an older account with an EasyBuy `_id`. Left alone; its owner's first sign-in
 *     links it (Middleware/verify.ts).
 *   - auth can't answer: left alone and reported, and the run exits 1. Run it again.
 *   - another account already holds that person: the unique personId index refuses the stamp (§3.8).
 *     Left alone and reported: one person with two accounts needs a human.
 * Safe to re-run. It writes one field on one collection and publishes no event.
 *
 * Run (a dry run is the default, and --write stamps):
 *   DATABASE_URL=... AUTH_SERVICE_URL=... SERVICE_CLIENT_ID=svc-easybuy SERVICE_CLIENT_SECRET=... \
 *     npx tsx migrate-shadow-person-ids.ts
 *   ...then add --write.
 * A database that isn't on this machine is refused unless --allow-remote is given as well. Run against
 * production only with the owner's approval (§7.4), and dry-run there first.
 *
 * It reads no .env, on purpose: EasyBuy's .env points at a shared cluster, and a one-off script must
 * not find its target by accident. It never logs personal data: only counts and ids.
 */
import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { PlatformHttpError, createPlatformHttpClient, createServiceTokenProvider } from "@melvingadgets/platform-kit";
import { isLocalDatabase } from "./Utils/localDatabase.js";

const env = (name: string) => String(process.env[name] ?? "").trim();

const databaseUrl = env("Database_url") || env("DATABASE_URL");
const authUrl = (env("AUTH_SERVICE_URL") || env("AUTH_ISSUER")).replace(/\/+$/, "");
const clientId = env("SERVICE_CLIENT_ID");
const clientSecret = env("SERVICE_CLIENT_SECRET");
const WRITE = process.argv.includes("--write") && !process.argv.includes("--dry-run");
const ALLOW_REMOTE = process.argv.includes("--allow-remote");

const AUDIENCE = "auth";
const SCOPES = ["auth:people.read"] as const;
const MAX_LISTED = 10;

async function run(): Promise<void> {
  if (!databaseUrl) throw new Error("Database_url (or DATABASE_URL) is required");
  if (!authUrl) throw new Error("AUTH_SERVICE_URL (or AUTH_ISSUER) is required");
  if (!clientId || !clientSecret) throw new Error("SERVICE_CLIENT_ID and SERVICE_CLIENT_SECRET are required");
  if (!ALLOW_REMOTE && !isLocalDatabase(databaseUrl)) {
    throw new Error("refusing a database that isn't on this machine; pass --allow-remote only if that is deliberate");
  }

  const tokens = createServiceTokenProvider({ tokenUrl: `${authUrl}/oauth/token`, clientId, clientSecret });
  const auth = createPlatformHttpClient({ target: AUDIENCE, baseUrl: authUrl, tokens });
  const traceId = `migrate-shadow-person-ids-${randomUUID()}`;

  // Bad credentials or the wrong address should end the run here, not as one failure per account.
  await tokens.getToken({ audience: AUDIENCE, scopes: SCOPES });

  const isPerson = async (personId: string): Promise<boolean> => {
    try {
      const { data } = await auth.request<{ personId?: unknown } | null>({
        method: "GET",
        path: `/api/v1/auth/internal/v2/people/${encodeURIComponent(personId)}`,
        scopes: SCOPES,
        traceId,
      });
      if (data?.personId !== personId) throw new Error("auth answered for a different person");
      return true;
    } catch (error) {
      if (error instanceof PlatformHttpError && error.status === 404) return false;
      throw error;
    }
  };

  // autoIndex and autoCreate off, and the model imported only after connecting: a model compiled any
  // earlier would build its indexes on connect, and a dry run must not change the database at all.
  await mongoose.connect(databaseUrl, { autoIndex: false, autoCreate: false });
  console.log(`target: ${mongoose.connection.name} at ${mongoose.connection.host}${WRITE ? "" : " (dry run: nothing is written)"}`);

  const UserModel = (await import("./Model/UserModel.js")).default;
  const { backfillShadowPersonIds } = await import("./Utils/shadowPerson.js");

  const counts = async () => ({
    accounts: await UserModel.countDocuments({}),
    withPerson: await UserModel.countDocuments({ personId: { $type: "string" } }),
    withoutPerson: await UserModel.countDocuments({ personId: null } as never),
  });
  const hasUniquePersonIndex = async () => {
    const indexes = await UserModel.collection.indexes().catch((error: { code?: number }) => {
      if (error.code === 26) return []; // no such collection yet
      throw error;
    });
    return indexes.some((index) => index.unique && Object.keys(index.key).join() === "personId");
  };

  const before = await counts();
  console.log("before:", before);

  // The stamp's only protection against a second claim on one person, so it must exist first.
  if (await hasUniquePersonIndex()) {
    console.log("personId index: present and unique");
  } else if (WRITE) {
    await UserModel.createIndexes();
    if (!(await hasUniquePersonIndex())) throw new Error("the unique personId index could not be built; nothing was stamped");
    console.log("personId index: built");
  } else {
    console.log("personId index: MISSING (--write builds it before stamping)");
  }

  const report = await backfillShadowPersonIds({ isPerson, write: WRITE });
  console.log(`checked ${report.candidates} account(s) with no personId against auth:`);
  console.log(`  ${WRITE ? "stamped" : "would stamp"}: ${report.stamped}`);
  console.log(`  not a person in auth (left alone): ${report.notAPerson}`);
  console.log(`  got a person during this run (left alone): ${report.alreadySet}`);
  console.log(`  person held by another account (left alone): ${report.heldElsewhere.length}`);
  console.log(`  lookup failed (left alone): ${report.lookupFailed.length}`);
  for (const { personId, holderId } of report.heldElsewhere.slice(0, MAX_LISTED)) {
    console.warn(`  ~ conflict: account ${personId} is that person's shadow, but account ${holderId} holds the personId`);
  }
  for (const { accountId, reason } of report.lookupFailed.slice(0, MAX_LISTED)) {
    console.error(`  ! lookup failed for account ${accountId}: ${reason}`);
  }
  const unlisted = Math.max(report.heldElsewhere.length, report.lookupFailed.length) - MAX_LISTED;
  if (unlisted > 0) console.warn(`  (lists stop at ${MAX_LISTED}; the counts above are complete)`);

  const after = await counts();
  console.log("after:", after);

  // Only ever up by what this run wrote. Live sign-ins can add more while it runs, which isn't a fault.
  const expected = before.withPerson + (WRITE ? report.stamped : 0);
  const reconciled = after.withPerson >= expected && after.accounts >= before.accounts;
  const extra = after.withPerson - expected;
  console.log(
    !reconciled
      ? `reconciliation: MISMATCH (expected at least ${expected} accounts with a person and ${before.accounts} accounts)`
      : `reconciliation: OK (${WRITE ? `${report.stamped} stamped` : "no documents changed"}${extra ? `; ${extra} more linked by live traffic` : ""})`
  );

  await mongoose.disconnect();
  if (!reconciled || report.lookupFailed.length > 0) process.exitCode = 1;
}

run().catch(async (error) => {
  console.error("migrate-shadow-person-ids failed:", (error as Error).message);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
