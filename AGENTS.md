# EasyBuy backend — agent notes

**Read first:** the platform rules in `C:\Users\HP\Desktop\Shortwork\AGENTS.md` (`../Shortwork/AGENTS.md` from here). They're canonical and override anything below.

- **Role:** the `easybuy` service. It owns the finance catalog, selling prices, plans, applications, approved items, receipts and repayments (database `EasybuyTracker`). Other services get this data only through its API or its events.
- **Request log:** `Middleware/requestLog.ts`, mounted first in `MainApp.ts`. Its fields are a cross-service contract (rules §6): keep it identical to the auth and store copies.
- **Database user:** in production, connect as the service's own user (`easybuy_api`, `readWrite@EasybuyTracker`), never an admin user. See `Shortwork/SECURITY-LOCKDOWN.md`.
- **Service-token API (U2):** `/api/v1/internal/*` (`Router/InternalRouter.ts`).
  - Each route needs a platform service token with its own scope: `catalog` → `easybuy:catalog.read`, `quote` → `easybuy:quote.read`.
  - Money here is integer kobo only. Quotes come from the kit's `quoteInstalments`, never a local copy of the formula.
  - These routes skip the public per-IP limits; the token is the gate. `AUTH_ISSUER` unset → 503.
- **Tests:** `npm test` (vitest) uses a throwaway database on the local MongoDB and drops it afterwards.
- **Known risks to fix, not copy:** money stored as floats (rules §4); the check-then-create for "one active item per person" in `CreateEasyBoughtItem` (rules §3.8).
