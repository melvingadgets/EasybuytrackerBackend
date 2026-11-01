import UserModel from "../Model/UserModel.js";

// Which person a shadow account belongs to, in the field everything else reads.
//
// A shadow account is made for one auth person: its `_id` IS their personId (syncLocalShadowUser in
// Service/AuthService.ts). Everything downstream reads the account's `personId` field instead, because
// an `_id` alone can't tell a shadow from an older account with an EasyBuy ObjectId. A shadow without
// the field therefore looks unlinked: `easybuy.payment.approved` carries a null person and the invoice
// service can't address the document (E-2).
//
// One account per person is the unique personId index's job (Model/UserModel.ts, AGENTS.md §3.8).
// Nothing here looks first and then writes; it writes, and the index refuses a second claim.

export const isDuplicateKeyError = (error: unknown): boolean => (error as { code?: number } | null)?.code === 11000;

/**
 * Writes `personId` on an account that has none (`null` matches a missing field too). Returns false
 * when it already has a person: that is never overwritten, and whichever writer got there first wins.
 * Throws a duplicate-key error when another account already holds the person.
 */
export const stampPersonId = async (accountId: unknown, personId: string): Promise<boolean> => {
  const { matchedCount } = await UserModel.updateOne({ _id: accountId, personId: null } as never, { $set: { personId } });
  return matchedCount === 1;
};

/** True when auth knows this person, false when it says it doesn't. Throws when it can't say. */
export type PersonCheck = (personId: string) => Promise<boolean>;

export interface ShadowBackfillReport {
  /** Accounts with no person, checked against auth. */
  candidates: number;
  /** Accounts stamped, or in a dry run the ones that would be. */
  stamped: number;
  /** Auth has no such person: an older account, which is linked by its owner's first sign-in. */
  notAPerson: number;
  /** Got a person from somewhere else while this ran. */
  alreadySet: number;
  /** The shadow's person is held by another account. One person has two accounts; left for a human. */
  heldElsewhere: Array<{ personId: string; holderId: string }>;
  /** Auth couldn't answer, so nothing was written. Run it again. */
  lookupFailed: Array<{ accountId: string; reason: string }>;
}

/**
 * Stamps every account whose `_id` auth confirms is a person, and only those. Safe to re-run: stamped
 * accounts stop being candidates, and each write is the compare-and-set above.
 */
export const backfillShadowPersonIds = async ({
  isPerson,
  write,
}: {
  isPerson: PersonCheck;
  write: boolean;
}): Promise<ShadowBackfillReport> => {
  const accounts = await UserModel.find({ personId: null } as never).select({ _id: 1 }).sort({ _id: 1 }).lean();
  const report: ShadowBackfillReport = {
    candidates: accounts.length,
    stamped: 0,
    notAPerson: 0,
    alreadySet: 0,
    heldElsewhere: [],
    lookupFailed: [],
  };
  const holderOf = async (personId: string) => {
    const holder = await UserModel.findOne({ personId }).select({ _id: 1 }).lean();
    return holder ? String(holder._id) : null;
  };

  for (const account of accounts) {
    const personId = String(account._id);

    let confirmed: boolean;
    try {
      confirmed = await isPerson(personId);
    } catch (error) {
      report.lookupFailed.push({ accountId: personId, reason: (error as Error).message });
      continue;
    }
    if (!confirmed) {
      report.notAPerson += 1;
      continue;
    }

    if (!write) {
      // A forecast for the operator, and the only place that looks first. The real run asks the index.
      const holderId = await holderOf(personId);
      if (holderId) report.heldElsewhere.push({ personId, holderId });
      else report.stamped += 1;
      continue;
    }

    try {
      if (await stampPersonId(account._id, personId)) report.stamped += 1;
      else report.alreadySet += 1;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      report.heldElsewhere.push({ personId, holderId: (await holderOf(personId)) ?? "unknown" });
    }
  }
  return report;
};
