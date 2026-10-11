# DigitalBurj Restaurant & Food Service OS

Full-stack **staged development implementation**, based on the uploaded research, brand guide and feature brief. Initial format: dine-in, takeaway and delivery. All 18 workspaces are present; transactional core workflows are implemented and tested. The comprehensive enterprise blueprint is not yet production complete. See [the stage plan](docs/IMPLEMENTATION-PLAN.md) and [requirement status](docs/REQUIREMENTS.json) for exact boundaries.

## Run

Node **24+** is required for built-in SQLite. No separate database service is needed.

```sh
cd /workspace/RestaurantOS
npm ci --cache /workspace/.cache/npm
npm run dev
```

Vite runs on port 5173 and proxies the API on 3001. Sign in with **Explore demo workspace**; role selection is available. All demo data is synthetic. Mutations persist to `data/restaurant.sqlite`. Demo login is disabled in production.

To serve the built interface on the API port:

```sh
npm run build
npm run server
```

Internal health check: `curl --fail http://127.0.0.1:3001/api/health`. Guest ordering is available at the app-relative route `/?guest=outlet_downtown` in the demo. It accepts pickup and configured-zone delivery, routes to the real local kitchen queue, and never charges an online card.

## Validate

```sh
npm run build
npm test
npm run test:e2e
npm run backup
```

Browser tests use the checksum-verified npm `@sparticuz/chromium` distribution when the cloud network disallows Playwright's download host. No TLS, package signature or integrity checks are disabled. The Playwright config places font caches in writable paths and removes the Lambda single-process flag so contexts can close safely. Tests start a separate port-3002 server with an isolated temporary database; they do not modify the development dataset.

## Architecture

`server/db.mjs`: schema, password hashing, transaction/savepoint helper, audit and balanced postings. `server/domain.mjs`: FEFO/order/recipe/payment/production/purchase/tax rules plus physical stock moves and intercompany transfers. `server/service.mjs`: bill/table/disposal controls, per-unit seat sharing and controlled prepared-item corrections. `server/channels.mjs`: channel mapping, menu publishing, station capacity and settlement matching. `server/mes.mjs`: contract catering — rate versions, rosters, demand, dispatch, serving and subscriptions. `server/customers-ext.mjs`: complaint recovery, coupon/gift-card redemption and consent-filtered campaign messaging. `server/operations-ext.mjs`: publication impact, substitutions, supplier offers, catering resources and the ASP interface. `server/purchasing-ext.mjs`: multi-line purchase orders, receipt quality rules and supplier matching. `server/finance-ext.mjs`: legal invoices/credit notes, ageing, gift-card ledger, chargebacks, till corrections, deposit terms and fiscal period close. `server/catering-ext.mjs`: quote versions, equipment returns and profitability. `server/delivery-ext.mjs`: route plans and the daily delivery board. `server/safety-ext.mjs`: recall review, notification outbox/adapters and bulk-service identity. `server/bundles-ext.mjs`: configurable mix-and-match bundle administration. `server/analytics-ext.mjs`: backtested forecasting and operational variance. `server/ai-ext.mjs`: deterministic AI assistants (owner briefing, demand, purchasing, menu cost, document intake, reconciliation, customer, communication drafting, kitchen exceptions, wastage) with an optional environment-mounted language-model layer that only narrates verified facts. `server/printers.mjs`: printer job queue with interrupted-ticket recovery. `server/recipes.mjs`: versioned nested recipe/BOM explosion and production planning. `server/app.mjs`: authenticated/scoped API, guest routes, files, export and administration. `shared/modules.mjs`: shared form validation and role permissions. `src/`: responsive operational UI. Browser fonts are self-hosted with bundled OFL licences.

Money is stored as integer fils. Stock uses integer base units: grams, millilitres or units. Order prices and recipes are snapshots. UTC timestamps are retained; the operational business date uses Asia/Dubai. Stock balances derive from lots and logged movements, with independent order reservations. SQLite transactions roll back incomplete state, including nested flows.

Sessions are HTTP-only/SameSite cookies with 8-hour expiry and hashed tokens in the database. Passwords use salted scrypt. Mutations require the session's CSRF token and an allowed Origin. APIs and downloads enforce tenant/outlet/role access. Payroll has a separate owner/HR boundary. Refunds and safety release have explicit role gates. Uploaded PDF/PNG/JPEG/text files are size/type checked, stored as BLOBs with SHA-256, and downloaded as attachments; document content is not executed or treated as system instructions.

## Account security and approvals

Every role can open **Account security** from the sidebar to change its password, manage sessions and enrol a TOTP authenticator. Administrators can reset a user to a temporary password, require a change before operational access, deactivate/reactivate accounts and change role/outlet assignments. Resets, access changes and deactivation revoke sessions. Authenticator login uses short-lived, attempt-limited challenges and rejects code replay; recovery codes are hashed and usable once.

Authenticator secrets use AES-256-GCM encryption. Production enrolment requires securely configured `APP_SECURITY_KEY` (64 hexadecimal characters); without it enrolment is explicitly unavailable. Development creates a mode-0600 `data/security.key`, which is ignored by Git. Preserve the matching key separately from database backups; losing it makes enrolled authenticators unreadable. Do not rotate the key without a planned re-encryption/recovery process. Requiring MFA by role and reviewed operator recovery procedures remain rollout gates.

Owners configure amount/percentage limits for discounts and **cumulative** order refunds per outlet. Temporary named-user delegations are scoped, expire within 31 days and can be revoked. The default limits preserve the previous role permissions; configure pilot limits before use. The decision and policy/delegation history are audited.

Organisation administration registers entities, brands, stock locations and custom kitchen stations. Stations route actual menu items and appear in kitchen filters. Lots can be placed into and moved between stock locations, splitting a lot when only part is moved and carrying its allergens and movement ledger; a transfer to an outlet in another legal entity dispatches the goods with intercompany receivable/payable journals on both entities. An outlet with transactions cannot change legal entity.

## Connected service controls

Dine-in lines can carry seats, courses and hold flags. Whole-order hold/resume preserves separately held courses; firing a course never consumes stock until preparation starts. Ownership transfers are audited. Amendments add current menu snapshots or remove only unprepared lines, release the removed reservations, create kitchen tickets and balance the financial difference. A prepared (already consumed) item can never be silently restored or silently re-priced: reducing its charged amount on a settled, split or refunded bill runs through a **controlled correction workflow** — a manager, owner or accountant records a reason and evidence, the difference is returned through the controlled refund path, the consumed portion of the unsent food is reclassified as an Inventory loss, and an immutable, idempotent correction ledger preserves the original ticket.

Managers and owners can also configure **mix-and-match bundles**: a fixed-price product that lets a customer choose a fixed number of options per group (for example pick two mains). The POS resolves the selection at order time into component lines that carry their own recipes, stock reservations, allergens, kitchen stations and immutable snapshots under a shared bundle key; suspended configurations and stale-version edits are refused, and the choice counts are enforced exactly.

Seat, item and amount bill parts retain the original total and discount rounding. Payments against split bills must select a part and cannot exceed its balance. A shared item (for example a starter) can be apportioned **per unit across seats** before a by-seat split, so each diner is charged only for their share; seat shares are locked once the bill is paid or split. Takeaway, pickup and delivery handover/dispatch require a complete item-and-quantity packing checklist; a remake resets its affected check.

## Purchasing, receipts and matching

Supplier **purchase packs** define a supplier, ingredient, base units per pack and cost per pack. Ordering by pack derives the base-unit quantity and cost-per-base-unit transactionally; a pack from a different supplier or ingredient is rejected, and a manual base-unit quantity/cost remains available. A receipt records a pass/conditional/fail inspection with separate accepted and rejected quantities. Accepted stock creates an FEFO lot and a balanced receipt journal; rejected stock is recorded as a non-usable movement with no lot and never enters availability, while accepted-plus-rejected quantities close the purchase balance. Supplier bills match received net value against an owner-configured fixed-plus-percentage tolerance; a within-tolerance variance posts an explicit Purchase price variance line under authorised review, and an outside-tolerance difference is blocked. Supplier offers can be compared (active packs ranked by effective unit cost for the required quantity, then lead time) and an explicit ingredient substitution must be drafted and approved before it is surfaced operationally. **Multi-line purchase orders** send several ingredient lines to a supplier and receive them independently: partial receipts, per-line accepted/rejected quantities, supplier lot codes and expiries for every accepted unit, and owner-configured required **receipt quality checks** (for example refrigeration temperature and packaging) that must pass before accepted stock is taken on. Purchasing roles work in a dedicated workspace, not the generic record editor, so header-only purchase orders cannot be created by hand.

## Channels, tender close and tax

Marketplace orders are imported whole and idempotently by channel order id. Operators maintain per-channel external-to-menu mappings; if any external item reference is unmapped the **entire import is rejected atomically** and an actionable mapping exception is queued with the offending references. Mapping the items and retrying applies the original payload without duplicating the order. A menu version can be published per channel with an effective window and listed/retired, stations can be given a per-day capacity that throttles acceptance, and channel settlements can be matched order-by-order against imported provider orders. Real provider connectors and signed callbacks remain staged gates.

Daily till close computes expected cash (opening, collected, deposits, refunds, paid-in/paid-out, tips) and expected bank (collected less refunds), takes a declared bank count and a counted cash figure, and requires an explanation for any cash or bank variance; a till reconciles only when both variances are zero. Paid-in, paid-out and tip movements are idempotent and lock once the till closes.

An owner-only tax policy (rate plus reviewed evidence) drives order, amendment and contract-period VAT arithmetic, and an accountant-reviewed **tax-code register** (standard/zero-rated/exempt/out-of-scope with posting account) is exposed through settings. **Legal tax invoices and credit notes** are issued with sequential `INV-`/`CN-` numbering and an explicit net/tax/total VAT breakdown; they are documents that evidence the sale journal and never double-post revenue. Accounts **ageing** buckets payables by due date and receivables by current/late exposure, the **gift-card ledger** reconciles issued, redeemed and outstanding liability, a card **chargeback** posts an authorised loss against the original payment, a closed till accepts only an evidenced **financial correction**, and deposit **no-show terms** (owner-configurable forfeiture cap) bound forfeiture. A **fiscal period close** finalises a date range no later than the current business date: every closed date is frozen by the posting guard, all open orders and till sessions across the period must be resolved first, and the close is audited and reported. The default 5% is an illustration and **not** a tax assessment; jurisdiction sign-off remains external.

## Versioned recipes and serving evidence

A **sub-recipe** is a versioned bill of materials for a prepared output ingredient and may nest another sub-recipe. Revisions supersede the previous version while retaining history; a recipe nested by another active recipe cannot be suspended. Explosion recursively resolves a recipe or menu item into consolidated base-ingredient quantities with cost, availability/shortfall and inherited allergens, rejecting cycles and self-reference. A recipe drives production planning that creates a planned batch from its immediate inputs, or from base ingredients when it is planned deeply; a changed prepared component can be assessed for the menu items and live orders it affects. A daily production plan aggregates the day's demand snapshots against a configured capacity and reports any shortfall.

Contract catering adds a **meal calendar** (per-meal service days, shift windows and rate code) that resolves which meals are served on a date and derives expected headcount from the effective roster.

Catering **serving evidence** records individual-scan or group-count servings against a meal contract with a matching meal type. Verification requires authorised catering approval and advances the contract served count; a reconciliation view reports accepted/served/remaining/over-served, verified versus unverified evidence and scan-versus-count totals. Offline serving scans synchronise idempotently by scan id, replays are deduplicated, and a scan that would breach the accepted entitlement is flagged as a conflict without creating evidence. **Catering quotes** version and supersede prior approved amounts before service, equipment returned after an event reduces the allocation and flags damage, and actual cost produces an event margin against the approved quote. A payer-scoped client portal can approve contract invoices, and subscriptions support crediting unused entitlement, effective-dated delivery changes and renewal with a prepaid balance. Reviewed clinical/specialist diet procedures remain an externally governed process.

## AI & automation

The **AI & automation** workspace runs ten assistants that answer from verified workspace data: an owner briefing (today's sales, contribution, low stock and attention items), a demand assistant (backtested moving-average baseline feeding a production-plan draft with ingredients), a purchasing assistant (usage, on-hand, reorder levels and supplier packs into approval-required order suggestions), a menu-cost assistant (contribution per item that flags cost-review candidates without changing a price), supplier document intake (deterministic invoice extraction; fields merged from an AI provider when one is mounted), a reconciliation assistant (payout variances and draft bills for the accountant), a customer assistant (approved menu prices and availability; allergen questions are escalated to a person), a communication drafter (consent-aware draft messages that never send), a kitchen exception assistant (tickets past station prep time from recorded state only) and a wastage assistant (waste/expiry/quarantine patterns as investigation proposals). Every assistant runs deterministically on verified database queries; a language model, when configured, only narrates or extracts those facts and is always labelled a draft. Assistants never post journals, change prices, release food, decide food safety or send messages — every action they propose requires a human acceptance recorded in the assistant activity log. Credentials live only in the environment (`AI_PROVIDER` / `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`), never in the database; without a key the workspace stays fully deterministic. Free OpenAI-compatible providers (Groq, OpenRouter) or a local Ollama server can be mounted. **The language model is optional and unverified for commercial use** — resolve provider data-processing and biases with your own evaluations before relying on drafts.

## Specialist service extensions

Delivery orders can be grouped into **route plans** sequenced by promised delivery time, dispatched only with dispatch evidence and completed with recorded evidence, with a daily board that separates routed stops from unrouted assignments. A **recall review** requires every affected lot to be held before it closes and reports the affected lots and exposed orders; bulk-service scans can be linked to **individual eaters** so a recall identifies a person rather than a count, and recall notices queue in a **notification outbox** that dispatches only through a selected, registered external provider (transmission requires a live provider). Consent-filtered **campaign messaging** sends an approved campaign only to customers with granted marketing consent and records withdrawn/ungranted/contact-less customers as blocked with an auditable reason. Analytics provides a **backtested moving-average forecast** (its measured MAPE/bias are reported so error is visible) and an **operational variance** report that separates contribution, posted waste, labour hours versus labour cost, and kitchen delay counts.

## Fresh production database

Use a **separate empty DATA_DIR**. Configure ADMIN_EMAIL and a unique ADMIN_PASSWORD (at least 12 characters) securely in runtime settings, and APP_ORIGIN for the HTTPS host. Then build and run `npm start`. `NODE_ENV=production` disables demo access and uses Secure cookies. Credentials are never checked into files or logged. Set up the organisation, ingredients, opening counts, tables, users and menus through the owner settings. Do not promote the synthetic demo database to production.

Production rollout still needs the gates in the implementation plan, especially tax/invoice review, an approved MFA enforcement/recovery policy, provider authorisation, secret management, backups/encryption/TLS, load/device tests and jurisdiction-specific procedures. Settings accurately show providers as unconnected. An ASP interface exists (owner-gated provider selection, an adapter registry and an idempotent transmission lifecycle), but a production eInvoicing connection requires an externally certified ASP adapter; Payroll preparation is not a validated WPS file; receipts are not structured eInvoices; the AI language model is optional and unverified without your own evaluation.

## Backup and recovery

`npm run backup` uses SQLite's consistent online backup API, including evidence-file BLOBs, and writes a mode-0600 file under `data/backups/`. Keep off-machine backups in an approved encrypted store. To restore: stop the app, preserve the existing database/WAL/SHM together, restore a backup to a fresh DATA_DIR as `restaurant.sqlite`, revoke restored sessions, run `PRAGMA integrity_check`, reconcile order/stock/journal/file counts, then start and validate the app. Never overwrite a running database. Tests restore backups into independent temporary paths and verify preserved totals. RPO/RTO and off-machine storage remain rollout decisions.

## Scope references

- [Original feature brief](docs/FEATURE-BRIEF.md)
- [Research text reference](docs/RESEARCH-REFERENCE.txt)
- [Brand text reference](docs/BRAND-REFERENCE.txt)
- [Staged execution and outstanding gates](docs/IMPLEMENTATION-PLAN.md)
- [Complete research catalogue status](docs/REQUIREMENTS.json)

The attachments are reference requirements, evidence and design inputs. Their links and recommendations do not authorise external communications, deployment, financial activity or regulator submissions.

Offline orders are durable browser drafts, scoped to the signed-in user and outlet. Connect once to register a non-extractable browser signing key; drafts survive reloads and are checked for signature, device revocation, menu versions, approvals and available stock at acceptance. Conflicts can be restored at current prices for operator review. Revoke lost browsers from Account security; prepare a new key in POS after revocation. Older unsigned drafts are retained for review. Clearing browser storage removes unsynced drafts; the database backup does not contain them. An offline application shell (service worker plus manifest) caches the interface so the workspace can start without a connection, and kitchen/floor tickets are queued and either confirmed or retained on interruption with an attempt count and a controlled reprint. Physical printer hardware validation remains a rollout gate.

Tables & reservations includes a walk-in waitlist and combined physical seating. Seating rejects conflicting bookings, open orders and another seated walk-in party. New reservations/orders use the group’s first selected table; existing order bills, tenders and kitchen history remain separate. Releasing a group requires resolving occupants and bookings that need its capacity. Booking arrival/departure inputs use UAE time.

Reservation deposits are manually recorded cash/bank advances with receipt references. Cash requires an open receiving till; applying the advance creates an order tender without collecting money again. Unapplied refunds and applied-order refunds share cumulative booking approval limits, preserve original cash/bank evidence and do not restore food. Cancelled/no-show balances remain visible in Finance → Reservation deposits. Deposit **no-show terms** (owner-configurable forfeiture percentage and cancellation fee) bound forfeiture, and a closed original cash till accepts an evidenced **financial correction** instead of blocking reconciliation. Advance-tax treatment, legal deposit receipts and provider authorisation require the remaining financial/pilot gates; no online charging or automatic forfeiture beyond the configured cap is implemented.
