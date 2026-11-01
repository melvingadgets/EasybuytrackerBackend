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
  - **Journey events** (`Utils/journeyEvents.ts`, kit `journey.ts`): `easybuy.request.submitted/approved/rejected`, `easybuy.item.created` and — since 2026-10-29 — `easybuy.payment.approved` (a repayment proof was approved), each in the same transaction as its change. The last one is what the invoice service turns into a repayment document (`../docs/invoice-service.md`); its `personId` comes from the account's field only, never the account `_id`, and the naira float is converted with `toKobo()` there.
  - **`personId` on Apply requests:** set only from a verified Melvin user token (`Middleware/platformPerson.ts`), never from the body.
  - **New routes:** `GET /api/v1/public/easybuy-requests/mine` (signed in) and `GET /api/v1/internal/people/:personId/journey` (scope `easybuy:journey.read`, for the reseller service).
  - **Migration:** `migrate-reseller-fields.ts` (indexes + before/after counts).
  - **A shadow's `personId` (2026-11-01, E-2):** `syncLocalShadowUser` stamps it, and the unique index refuses a second claim on one person, returning the account that already holds them. Shadows made earlier are stamped by `migrate-shadow-person-ids.ts`: dry-run by default, confirms each `_id` through auth's people lookup, and needs `svc-easybuy`'s secret at run time. Until it runs on a database, those shadows still send a null person on `easybuy.payment.approved`; the journey route already finds them by `_id`.
  - **Swift Device multiplier bug:** the dashboard applies AuraPay's markups to Swift Device loans (`DashboardController.ts:98–110`). It is known and **deliberately not fixed** (the user said not to).
- **Repayment reminders (2026-11-01; design: `Shortwork/docs/notifications.md` §13):** a daily job writes `easybuy.repayment.due` (kit 0.8.0) for each unpaid instalment reaching a stage: 3 days before, the due day, and overdue. Auth turns it into a notice and an alert.
  - **Where:** `Utils/repaymentSchedule.ts` is pure and holds every date and money rule. `Service/RepaymentReminders.ts` reads, writes and schedules. `run-repayment-reminders.ts` runs it by hand, as a dry run by default.
  - **Exactly once:** the unique index on `repaymentreminders` `(itemId, instalment, stage)` decides, in the same transaction as the event. Never add a "has this been sent?" read before the write (rules §3.8).
  - **Keep the schedule equal to the dashboard's** (`DashboardController.getNormalizedItemSchedule`): first instalment one interval after `createdAt`, 7 or 30 days apart. A test pins the two together. Change them together.
  - **Amounts** come from the kit's `multiplyKobo` and `splitInstalments`, with the item's own provider's markup. Unlike the dashboard, this doesn't apply AuraPay's table to Swift Device (the bug below).
  - **Scheduler:** in-process, every 15 minutes, starting a run only 08:00–20:00 Lagos. It starts only with `REPAYMENT_REMINDERS_ENABLED=true` and `EVENTS_ENABLED=true`. Switch it on only once the relay routes the event and auth reads it, or the reminder dead-letters at auth and is spent.
  - **Skipped and counted, never guessed:** `no_person`, `person_mismatch` (the F-1 rule), `unknown_plan`, `on_hold` (a future `manualNextDueDate`).
- **Application documents (2026-10-27):** after submitting, an Apply applicant adds their last 3 months' bank statement, their NIN and a photo holding their NIN (`Controller/ApplicationDocumentsController.ts`, `Utils/applicationDocuments.ts`).
  - Stored apart from the request in `applicationdocuments`. **The NIN is stored as typed, not encrypted**: the owner removed the encryption and its `EASYBUY_DOCUMENTS_KEY` on 2026-10-28, so the collection holds readable national IDs and any backup or database export carries them. Only the SuperAdmin documents route selects it (`select: false`); files are **private** Cloudinary assets (`type: "authenticated"`, `Utils/documentStorage.ts`), readable only through 5-minute signed links from the SuperAdmin route, and each view is audited (`PUBLIC_REQUEST_DOCUMENTS_VIEW`). Never log a NIN, a file or a link; never expose them to resellers or in the journey route.
  - Who may upload: the signed-in owner (verified Melvin token) or the holder of the request's upload key (returned once at submission as `documentsToken`, stored as a hash, 30 days). Anyone else gets 404.
  - Files are identified by their bytes (PDF/JPEG/PNG/WebP), 4 MB max (Apply proxies through Vercel, ~4.5 MB per request), at most 3 statement files, and a statement needs the down-payment confirmation.
  - Requests created since then carry `documentsRequired: true` and can't be approved until all three are in (409 `documents_incomplete`); older requests approve as before. Approval or rejection locks the documents.
- **Tests:** `npm test` (vitest) needs a replica set (`MONGO_RS_HOST`, default `127.0.0.1:27028`) for the outbox transaction tests; it drops its throwaway database afterwards.
- **Known risks to fix, not copy:** money stored as floats (rules §4); the check-then-create for "one active item per person" in `CreateEasyBoughtItem` (rules §3.8).


## 8. Engineering Standards & Testing Discipline
1. **No Fake, Tautological, or Vacuous Tests:**
   - Never write tests that merely assert tautologies, mock out the very behaviors under test without exercising system logic, or exist solely to artificially inflate pass counts or coverage.
   - Tests must execute real application code paths, exercise genuine business logic, and validate actual state changes, edge cases, and failure modes against authoritative contracts and models.
   - Every test must be capable of failing if the code breaks or regresses.
2. **Error Handling & Information Leakage Prevention:**
   - Maintain disciplined, robust error handling across all layers.
   - Use explicit types, readable formatting, and sanitized user-facing errors.
   - **Zero leakage of sensitive internals:** Never expose stack traces, database errors, internal system paths, environment values, credentials, tokens, or sensitive user data in client responses or unauthenticated error payloads.
3. **Repository Documentation & CI/CD Synchronization:**
   - Each repository's `AGENTS.md` is self-contained and authoritative locally. Read it before starting work.
   - Maintain repository-specific `docs/` as the canonical documentation for that repository.
   - Keep repository `docs/`, `README.md`, secrets references, and deployment guides strictly synchronized after every change.
   - Maintain each repository's own GitHub Actions CI/CD workflows. Do not reintroduce a root git repository or root workflow without explicit user authorization.
   - When cross-repository layout changes occur, update the workspace overview accordingly.
   - Run relevant repository verification and affected shared contract checks before finishing.
   - Rebuild only affected consumers and verify health. Preserve composed identities, data volumes, existing credentials, and retained rollback histories.
4. **Hierarchical CI/CD Pipeline & Neo-Cloud Deployment Gating:**
   - Every repository must maintain its own dedicated GitHub Actions CI/CD workflow (`.github/workflows/ci-cd.yml`).
   - **System Build Verification:** Clean build of the application or service artifacts (`npm run build`, `tsc`, or container build) with zero unresolved errors or broken assets.
   - **Hierarchical Test Progression:** Tests must be structured and executed in strict hierarchical tiers:
     1. *Unit Tests*: Fast, isolated tests verifying pure functions, models, domain calculations, and finite state machines.
     2. *Integration Tests*: Component-level and database/cache/service integrations executing actual application code paths with genuine transactions and state changes.
     3. *End-to-End (E2E) & Contract Tests*: Full critical path flows and producer-consumer schema conformance tests against authoritative shared contracts.
   - **Code Quality & Disciplined Linting:** Enforce strict static analysis, type checking (`tsc --noEmit`), and linting rules across all commits and pull requests.
   - **Vulnerability & Dependency Auditing:** Automated security auditing of codebase and packages (`npm audit --audit-level=high`, `pip audit` for Python components, and vulnerability scanning). Detect, block, and resolve security advisories before artifact promotion.
   - **Gated Neo-Cloud Deployment:**
     - Deployments run only after build verification, quality linting, vulnerability audits, and all hierarchical test tiers succeed completely (100% green).
     - **Backends** (`unified-auth-service`, `EasybuytrackerBackend`, `store`, `reseller-service`, `invoice-service`, `whatsapp-backend`) deploy to **Railway**.
     - **Frontends** (`melvin-os`, `EasybuyFrontend`, `computer-village`) deploy to **Vercel**.
     - Shared contracts and libraries (`melvin-platform-kit`) run CI verification and contract validation prior to consumer usage.

## 9. Bug Audit Output Location & Persistent Severity-Based QA Reporting
1. **Audit Output Location:**
   - Every repository must write all bug audit reports and findings exclusively to its own ignored `qa-report/bug-audit/` folder. Create it when needed.
   - **Explicit Exception to Documentation Placement:** Never write bug audits to `docs/` or any other documentation folder, `qa-reports/bug-audit/`, or directly to `qa-report/`. Keep audits component-local and preserve existing unrelated reports.
2. **Persistent Severity-Based QA Ledger:**
   - Keep active bugs, functional/UI issues, reliability gaps, and security vulnerabilities in the repository's ignored `qa-report/bug-audit/` directory, exclusively in four reusable severity files:
     - `Critical.md`: Immediate severe compromise or widespread irreversible loss.
     - `High.md`: Major security, authorization, financial, or core-workflow failures.
     - `Medium.md`: Material but limited-impact failures.
     - `Low.md`: Minor usability, visual, or low-impact defects.
   - Create this fixed set once and reuse it for all later audits. Do not create per-audit, per-date, per-feature, or per-issue Markdown reports, and never place audit findings in `docs/`.
   - Identify the issue category within the entry; all categories share these severity files.
   - If a severity file has no open issues, retain the reusable file with a brief statement: `No open issues`. Remove that statement when adding a new issue.
   - These files represent the cumulative active QA ledger, not a claim that untested areas have no bugs.
3. **Issue Entry Format & Discovery Timestamps:**
   - Give every new issue its own heading containing a clear title and its actual discovery date/time in Africa/Lagos, including the UTC offset:
     `## <Issue Title> — YYYY-MM-DD HH:mm WAT (UTC+01:00)`
   - Do not invent discovery timestamps for older findings. Preserve the original timestamp when updating an existing issue.
   - Each entry records:
     - Affected component / files or flow
     - Reproducible evidence (sanitized: never include credentials, tokens, or unnecessary personal information)
     - Actual impact
     - Verification criteria needed to close it
   - Update an existing entry for the same root cause instead of duplicating it on subsequent audits. Move the entry if its severity changes.
4. **Lifecycle & Closure Discipline:**
   - After fixing an issue and passing the relevant verification, delete that issue's entire section from its severity file, preserving unrelated open findings.
   - Do not keep resolved entries, strike-through histories, or duplicate fixed-issue reports in the active ledger.
   - Keep an issue open when verification is incomplete or blocked, and state what remains.
   - Publish and verify replacement severity entries before removing superseded audit reports. Remove fixed findings only after their relevant fix verification passes; retain unresolved or blocked findings with honest status. Consolidating historical reports must not invent discovery timestamps, convert acceptance gaps into confirmed exploits, or silently erase unresolved findings.
5. **Strict Directory Cleanliness:**
   - After every bug audit, `qa-report/bug-audit/` must contain **only** the four persistent severity files: `Critical.md`, `High.md`, `Medium.md`, and `Low.md`.
   - Do not retain any other files or subfolders there: no dated summaries, separate issue reports, screenshots, logs, JSON, traces, HTML, or evidence archives.
   - Temporary audit scratch output may be used while working, but remove audit-generated scratch artifacts before concluding. Do not relocate extra bug-audit reports/artifacts into `docs/` or another QA directory to evade this rule.
