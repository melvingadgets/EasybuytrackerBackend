// Deciding the `personId` of an item created by converting an Apply request.
//
// The converted item is attributed to one account (its `UserId` / `UserEmail`). Its `personId` is the
// auth identity that every downstream consumer keys on — the reseller service turns it into a
// commission, the invoice service turns it into a down-payment document. So `personId` MUST name the
// same person as the account the item is attributed to. The old code took `personId` from the Apply
// request first and only fell back to the resolved account, so a conversion where the two disagreed
// (an admin typo in `userEmail`, or a request whose typed email matched someone else's account)
// wrote a split-brain item: `UserId` is one person, `personId` another — money to the wrong reseller
// and a financial document in a stranger's name (F-1, docs/BUG-AUDIT-2026-10-31b.md).
//
// The rule (docs/RELEASE-PLAN-2026-10-31.md, Phase 2.4): `personId` comes from the resolved account
// ONLY, and the conversion is refused when the request carries a verified person the account does not.
// That includes an account linked to no person at all: it was found by an email typed into the Apply
// form, and a typed email is never proof of identity (AGENTS.md §1.4). An account belongs to a person
// only through that person's own verified sign-in — `Middleware/verify.ts` either links an older
// account by the auth-verified email or creates a shadow whose `_id` is the person — so the remedy for
// a refusal is for the applicant to sign in, not for this code to guess.
//
// Pure, so it can be tested without a replica set.

export class ConversionIdentityMismatchError extends Error {
  readonly code = "person_mismatch";

  constructor() {
    super(
      "The application's verified applicant does not match the account being converted. Have the applicant sign in to link their account, or correct userEmail."
    );
    this.name = "ConversionIdentityMismatchError";
  }
}

export interface ConversionIdentityInput {
  /** personId stored on the Apply request (set only from a verified Melvin token), if any. */
  requestPersonId?: unknown;
  /** The `personId` field of the account resolved by email — set when an older account is linked. */
  accountPersonId?: unknown;
  /** The `_id` of that account. A shadow account's `_id` IS its person (see below). */
  accountId?: unknown;
}

const clean = (value: unknown): string | null => {
  const s = String(value ?? "").trim();
  return s ? s : null;
};

/**
 * Returns the `personId` to stamp on the converted item: always the resolved account's (or null for an
 * account no person has claimed, on a request no person submitted). Throws
 * {@link ConversionIdentityMismatchError} when the request's verified person is not the account's.
 */
export const resolveConversionPersonId = (input: ConversionIdentityInput): string | null => {
  const requestPersonId = clean(input.requestPersonId);
  const accountId = clean(input.accountId);

  // An account carries its person in one of two ways. Its `personId` field is the usual one: an older
  // EasyBuy account linked on the person's first verified request (Middleware/verify.ts), or a shadow
  // from syncLocalShadowUser. A shadow made before that set the field, and not yet reached by
  // migrate-shadow-person-ids, has only its `_id`, which is the person's auth id. An older account's
  // `_id` is an EasyBuy ObjectId and never equals an auth person's, so an `_id` equal to the request's
  // verified person proves the account was made for that person; it is not a typed email standing in
  // for identity.
  const accountPersonId =
    clean(input.accountPersonId) ?? (requestPersonId && accountId === requestPersonId ? accountId : null);

  if (requestPersonId && requestPersonId !== accountPersonId) {
    throw new ConversionIdentityMismatchError();
  }
  return accountPersonId;
};
