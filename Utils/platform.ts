import { createTokenVerifier, type TokenVerifier } from "@melvingadgets/platform-kit";
import { config } from "../config/Config.js";

// Verifies platform tokens against the auth service's published keys (Shortwork/AGENTS.md §2.2).
// Null until AUTH_ISSUER is set, so the service runs unchanged before the rollout.
export const platformVerifier: TokenVerifier | null =
  config.auth.issuer && config.auth.jwksUrl
    ? createTokenVerifier({ issuer: config.auth.issuer, jwks: config.auth.jwksUrl })
    : null;
