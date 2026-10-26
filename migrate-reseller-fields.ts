/**
 * migrate-reseller-fields: create the indexes for the reseller programme's new optional fields
 * (RESELLER-PLAN.md §7, §8b) and print a before/after count (Shortwork/AGENTS.md §7.3).
 *
 * The fields are additive and optional, so nothing is backfilled:
 *   - publiceasybuyrequests.personId: set only from a verified Melvin token on new requests.
 *   - easyboughtitems.personId, sourceRequestId, serviceFeeKobo/Bps/Base: set on new items.
 *     Old items keep no service fee and earn no commission.
 * Both personId indexes are partial (string values only), so documents without the field are
 * never indexed and never collide.
 *
 * Run (dry run first):
 *   DATABASE_URL=... npx tsx migrate-reseller-fields.ts --dry-run
 *   ...then drop --dry-run to create the indexes.
 * It never logs personal data: only counts.
 */
import mongoose from "mongoose";
import * as dotenv from "dotenv";

dotenv.config();

const databaseUrl = String(process.env.Database_url ?? process.env.DATABASE_URL ?? "").trim();
const DRY_RUN = process.argv.includes("--dry-run");

async function counts() {
  const RequestModel = (await import("./Model/PublicEasyBuyRequestModel.js")).default;
  const ItemModel = (await import("./Model/EasyBoughtitem.js")).default;
  return {
    requests: await RequestModel.countDocuments({}),
    requestsWithPerson: await RequestModel.countDocuments({ personId: { $type: "string" } }),
    items: await ItemModel.countDocuments({}),
    itemsWithPerson: await ItemModel.countDocuments({ personId: { $type: "string" } }),
    itemsWithServiceFee: await ItemModel.countDocuments({ serviceFeeKobo: { $exists: true } }),
  };
}

async function run(): Promise<void> {
  if (!databaseUrl) throw new Error("Database_url (or DATABASE_URL) is required");
  console.log(`Connecting to EasyBuy database${DRY_RUN ? " (dry run)" : ""}...`);
  await mongoose.connect(databaseUrl, { autoIndex: false });

  const before = await counts();
  console.log("before:", before);

  const RequestModel = (await import("./Model/PublicEasyBuyRequestModel.js")).default;
  const ItemModel = (await import("./Model/EasyBoughtitem.js")).default;
  if (DRY_RUN) {
    console.log("dry run: would create the partial personId indexes on publiceasybuyrequests and easyboughtitems");
  } else {
    await RequestModel.createIndexes();
    await ItemModel.createIndexes();
    console.log("indexes created");
  }

  const after = await counts();
  console.log("after:", after);
  // Nothing is written to documents, so every count must be unchanged.
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  console.log(unchanged ? "reconciliation: OK (no documents changed)" : "reconciliation: MISMATCH");
  await mongoose.disconnect();
  if (!unchanged) process.exit(1);
}

run().catch(async (error) => {
  console.error("migrate-reseller-fields failed:", (error as Error).message);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
