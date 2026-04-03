import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";

type MappingFile = {
  easybuy: Record<string, string>;
  ecommerce: Record<string, string>;
};

const mappingFile = path.join(process.cwd(), "migrations", "output", "user-id-map.json");
const easybuyDatabaseUrl = String(process.env.EASYBUY_DATABASE_URL ?? process.env.Database_url ?? "").trim();
const ecommerceDatabaseUrl = String(process.env.ECOMMERCE_DATABASE_URL ?? "").trim();

if (!easybuyDatabaseUrl || !ecommerceDatabaseUrl) {
  throw new Error("EASYBUY_DATABASE_URL and ECOMMERCE_DATABASE_URL are required");
}

const updateIdsInCollection = async (args: {
  collection: mongoose.mongo.Collection<any>;
  field: string;
  mapping: Record<string, string>;
}) => {
  let updated = 0;
  for (const [legacyId, authUserId] of Object.entries(args.mapping)) {
    const result = await args.collection.updateMany(
      { [args.field]: new mongoose.Types.ObjectId(legacyId) },
      { $set: { [args.field]: new mongoose.Types.ObjectId(authUserId) } }
    );
    updated += result.modifiedCount;
  }
  return updated;
};

const main = async () => {
  const mapping = JSON.parse(await fs.readFile(mappingFile, "utf8")) as MappingFile;
  const easybuyConn = await mongoose.createConnection(easybuyDatabaseUrl).asPromise();
  const ecommerceConn = await mongoose.createConnection(ecommerceDatabaseUrl).asPromise();

  try {
    const easybuyResults = await Promise.all([
      updateIdsInCollection({
        collection: easybuyConn.collection("easyboughtitems"),
        field: "UserId",
        mapping: mapping.easybuy,
      }),
      updateIdsInCollection({
        collection: easybuyConn.collection("payments"),
        field: "user",
        mapping: mapping.easybuy,
      }),
      updateIdsInCollection({
        collection: easybuyConn.collection("receipts"),
        field: "user",
        mapping: mapping.easybuy,
      }),
      updateIdsInCollection({
        collection: easybuyConn.collection("easybuyplans"),
        field: "user",
        mapping: mapping.easybuy,
      }),
    ]);

    const ecommerceResults = await Promise.all([
      updateIdsInCollection({
        collection: ecommerceConn.collection("categories"),
        field: "User",
        mapping: mapping.ecommerce,
      }),
    ]);

    console.log("EasyBuy ref updates:", easybuyResults.reduce((sum, count) => sum + count, 0));
    console.log("Ecommerce ref updates:", ecommerceResults.reduce((sum, count) => sum + count, 0));
  } finally {
    await Promise.all([easybuyConn.close(), ecommerceConn.close()]);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
