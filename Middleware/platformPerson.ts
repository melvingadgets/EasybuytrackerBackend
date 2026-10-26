import type { NextFunction, Request, Response } from "express";
import { bearerToken, type TokenVerifier } from "@melvingadgets/platform-kit";

// For public routes anyone may call that should still record WHO called when the caller is
// signed in to Melvin OS (an Apply request made from inside the OS). A valid unified user token
// sets req.person and req.caller; no token, a legacy EasyBuy token or a bad token leaves the
// request anonymous. The person is never taken from the body (Shortwork/AGENTS.md §2.5).
export const optionalPlatformPerson =
  (verifier: TokenVerifier | null) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const token = bearerToken(req.headers.authorization);
    if (!verifier || !token) {
      next();
      return;
    }
    verifier
      .verifyUserToken(token)
      .then((person) => {
        req.person = person;
        req.caller = { type: "user", id: person.personId };
        next();
      })
      .catch(() => next());
  };
