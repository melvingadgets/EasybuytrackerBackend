import mongoose from "mongoose";
import * as dotenv from "dotenv";

const PROVIDER_DEFAULT = "aurapay";

dotenv.config();

const databaseUrl = String(process.env.Database_url ?? process.env.DATABASE_URL ?? "").trim();

type UpdatableModel = {
  updateMany: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>
  ) => Promise<{ modifiedCount?: number }>;
};

async function migrate() {
  if (!databaseUrl) {
    throw new Error("Database_url (or DATABASE_URL) is required");
  }

  console.log("Connecting to database...");
  await mongoose.connect(databaseUrl);
  console.log("Connected.");

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("No database connection");
  }

  const EasyBuyCapacityPriceModel = (await import("./Model/EasyBuyCapacityPriceModel.js")).default;
  const PublicEasyBuyRequestModel = (await import("./Model/PublicEasyBuyRequestModel.js")).default;
  const PublicEasyBuyDraftModel = (await import("./Model/PublicEasyBuyDraftModel.js")).default;
  const EasyBoughtItemModel = (await import("./Model/EasyBoughtitem.js")).default;

  const models: Array<{ name: string; model: UpdatableModel }> = [
    { name: "EasyBuyCapacityPrice", model: EasyBuyCapacityPriceModel as unknown as UpdatableModel },
    { name: "PublicEasyBuyRequest", model: PublicEasyBuyRequestModel as unknown as UpdatableModel },
    { name: "PublicEasyBuyDraft", model: PublicEasyBuyDraftModel as unknown as UpdatableModel },
    { name: "EasyBoughtItem", model: EasyBoughtItemModel as unknown as UpdatableModel },
  ];

  for (const { name, model } of models) {
    console.log(`\nMigrating ${name}...`);
    const result = await model.updateMany(
      { $or: [{ provider: { $exists: false } }, { provider: null }, { provider: "" }] },
      { $set: { provider: PROVIDER_DEFAULT } }
    );
    console.log(`  ${name}: ${result.modifiedCount} documents updated`);
  }

  console.log("\nHandling EasyBuyCapacityPrice index change...");
  try {
    const collection = EasyBuyCapacityPriceModel.collection;
    const indexes = await collection.indexes();

    const oldIndex = indexes.find(
      (idx: any) =>
        idx.key &&
        idx.key.model === 1 &&
        idx.key.capacity === 1 &&
        !idx.key.provider &&
        idx.unique === true
    );

    if (oldIndex) {
      console.log(`  Dropping old unique index: ${oldIndex.name}`);
      await collection.dropIndex(String(oldIndex.name));
      console.log("  Old index dropped successfully");
    } else {
      console.log("  Old unique index { model, capacity } not found (may already be dropped)");
    }

    await EasyBuyCapacityPriceModel.syncIndexes();
    console.log("  New indexes synced");
  } catch (indexError: any) {
    console.error("  Index migration error:", indexError?.message);
  }

  console.log("\nMigration complete.");
  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
