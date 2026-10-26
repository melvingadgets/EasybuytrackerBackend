# EasyBuy backend — agent notes

**Read first:** the platform rules in `C:\Users\HP\Desktop\Shortwork\AGENTS.md` (`../AGENTS.md` from here; this repo lives in the Shortwork workspace). They're canonical and override anything below.

- **Role:** the `easybuy` service. It owns the finance catalog, selling prices, plans, applications, approved items, receipts and repayments (database `EasybuyTracker`). Other services get this data only through its API or its events.
- **Request log:** `Middleware/requestLog.ts`, mounted first in `MainApp.ts`. Its fields are a cross-service contract (rules §6): keep it identical to the auth and store copies.
- **Database user:** in production, connect as the service's own user (`easybuy_api`, `readWrite@EasybuyTracker`), never an admin user. See `Shortwork/SECURITY-LOCKDOWN.md`.
- **Service-token API (U2):** `/api/v1/internal/*` (`Router/InternalRouter.ts`).
  - Each route needs a platform service token with its own scope: `catalog` → `easybuy:catalog.read`, `quote` → `easybuy:quote.read`.
  - Money here is integer kobo only. Quotes come from the kit's `quoteInstalments`, never a local copy of the formula.
  - These routes skip the public per-IP limits; the token is the gate. `AUTH_ISSUER` unset → 503.
- **Events (U3):** when `EVENTS_ENABLED=true`, a SuperAdmin price change writes its `easybuy.price.updated` event to the `outbox` in the same transaction as the price row (`SuperAdminController.ts`). One event per row whose price actually changed; money in kobo. Off by default (additive rollout); needs a replica set (Atlas is one). `Utils/messaging.ts` bridges mongoose to the kit's outbox helpers.
- **Reseller programme (2026-10-26, branch `feat/reseller-programme`; see `Shortwork/RESELLER-PLAN.md`):**
  - **Service charge:** 8% of the financed amount, `EASYBUY_SERVICE_FEE_BPS` / `_BASE`, in `Utils/serviceFee.ts`. It is fixed in kobo on the item when a request is converted or an admin creates an item (`serviceFeeKobo/Bps/Base`), and the public catalog publishes the rule for Apply.
  - **Journey events** (`Utils/journeyEvents.ts`, kit `journey.ts`): `easybuy.request.submitted/approved/rejected` and `easybuy.item.created`, each in the same transaction as its change.
  - **`personId` on Apply requests:** set only from a verified Melvin user token (`Middleware/platformPerson.ts`), never from the body.
  - **New routes:** `GET /api/v1/public/easybuy-requests/mine` (signed in) and `GET /api/v1/internal/people/:personId/journey` (scope `easybuy:journey.read`, for the reseller service).
  - **Migration:** `migrate-reseller-fields.ts` (indexes + before/after counts).
  - **Swift Device multiplier bug:** the dashboard applies AuraPay's markups to Swift Device loans (`DashboardController.ts:98–110`). It is known and **deliberately not fixed** (the user said not to).
- **Tests:** `npm test` (vitest) needs a replica set (`MONGO_RS_HOST`, default `127.0.0.1:27028`) for the outbox transaction tests; it drops its throwaway database afterwards.
- **Known risks to fix, not copy:** money stored as floats (rules §4); the check-then-create for "one active item per person" in `CreateEasyBoughtItem` (rules §3.8).
