import mongoose from "mongoose";
import { ensureOutboxIndexes, type MongoClientLike, type MongoDbLike } from "@melvingadgets/platform-kit";
import { config } from "../config/Config.js";

// Bridges mongoose to the platform kit's driver-based outbox helpers. The kit writes a business
// change and its event in one transaction (Shortwork/AGENTS.md §3.1); here the mongoose model
// write and the outbox insert share the same driver session.

export const mongoClient = (): MongoClientLike => mongoose.connection.getClient() as unknown as MongoClientLike;

export const rawDb = (): MongoDbLike => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("mongoose is not connected");
  return db as unknown as MongoDbLike;
};

/** Create the outbox indexes the relay reads by. Called on boot only when events are enabled. */
export const initOutbox = async (): Promise<void> => {
  if (config.eventsEnabled) await ensureOutboxIndexes(rawDb());
};
