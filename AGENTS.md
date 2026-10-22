# EasyBuy backend — agent notes

**Read first:** the platform rules in `C:\Users\HP\Desktop\Shortwork\AGENTS.md` (`../Shortwork/AGENTS.md` from here). They're canonical and override anything below.

- **Role:** the `easybuy` service. It owns the finance catalog, selling prices, plans, applications, approved items, receipts and repayments (database `EasybuyTracker`). Other services get this data only through its API or its events.
- **Request log:** `Middleware/requestLog.ts`, mounted first in `MainApp.ts`. Its fields are a cross-service contract (rules §6): keep it identical to the auth and store copies.
- **Database user:** in production, connect as the service's own user (`easybuy_api`, `readWrite@EasybuyTracker`), never an admin user. See `Shortwork/SECURITY-LOCKDOWN.md`.
- **Known risks to fix, not copy:** money stored as floats (rules §4); the check-then-create for "one active item per person" in `CreateEasyBoughtItem` (rules §3.8).
