import { describe, expect, it } from "vitest";
import {
  resolveConversionPersonId,
  ConversionIdentityMismatchError,
} from "../Utils/conversionIdentity.js";

// F-1 (docs/BUG-AUDIT-2026-10-31b.md): converting an Apply request must not stamp the item with a
// personId that disagrees with the account it is attributed to. The rule is the release plan's
// (docs/RELEASE-PLAN-2026-10-31.md, Phase 2.4): the resolved account's personId only, refused on any
// mismatch. Pure, so it needs no replica set; the route-level "no item, no event" check is in
// resellerJourney.test.ts.

describe("resolveConversionPersonId", () => {
  it("uses the resolved account's personId when the request names the same person", () => {
    expect(resolveConversionPersonId({ requestPersonId: "person-A", accountPersonId: "person-A" })).toBe("person-A");
  });

  it("uses the account's personId when the request carries none (an anonymous application)", () => {
    expect(resolveConversionPersonId({ requestPersonId: null, accountPersonId: "person-A" })).toBe("person-A");
  });

  it("REFUSES when the request and the account name two different people (the F-1 split-brain)", () => {
    // Request submitted by B; the admin is converting into A's account (e.g. a typo in userEmail).
    expect(() => resolveConversionPersonId({ requestPersonId: "person-B", accountPersonId: "person-A" })).toThrow(
      ConversionIdentityMismatchError
    );
  });

  it("REFUSES when the account is linked to nobody: a typed email is not proof of identity (AGENTS.md §1.4)", () => {
    // The account was found by the email typed on the Apply form. Trusting the request's person here
    // is exactly how someone else's unlinked account would end up carrying the applicant's identity.
    expect(() => resolveConversionPersonId({ requestPersonId: "person-B", accountPersonId: null })).toThrow(
      ConversionIdentityMismatchError
    );
  });

  it("returns null when neither side carries an identity", () => {
    expect(resolveConversionPersonId({ requestPersonId: null, accountPersonId: null })).toBeNull();
    expect(resolveConversionPersonId({})).toBeNull();
  });

  it("treats blank or whitespace ids as absent: no false mismatch, never an empty-string personId", () => {
    expect(resolveConversionPersonId({ requestPersonId: "   ", accountPersonId: "person-A" })).toBe("person-A");
    expect(resolveConversionPersonId({ requestPersonId: "", accountPersonId: "  " })).toBeNull();
    expect(() => resolveConversionPersonId({ requestPersonId: "person-B", accountPersonId: "   " })).toThrow(
      ConversionIdentityMismatchError
    );
  });

  it("carries a machine-readable code for the route's 409", () => {
    try {
      resolveConversionPersonId({ requestPersonId: "person-B", accountPersonId: "person-A" });
      expect.unreachable("a mismatch must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConversionIdentityMismatchError);
      expect((error as ConversionIdentityMismatchError).code).toBe("person_mismatch");
    }
  });
});
