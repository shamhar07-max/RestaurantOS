# DigitalBurj Restaurant & Food Service OS

Full-stack **staged development implementation**, based on the uploaded research, brand guide and feature brief. Initial format: dine-in, takeaway and delivery. All 15 workspaces are present; transactional core workflows are implemented and tested. The comprehensive enterprise blueprint is not yet production complete. See [the stage plan](docs/IMPLEMENTATION-PLAN.md) and [requirement status](docs/REQUIREMENTS.json) for exact boundaries.

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

`server/db.mjs`: schema, password hashing, transaction/savepoint helper, audit and balanced postings. `server/domain.mjs`: FEFO/order/recipe/payment/production/purchase rules. `server/service.mjs`: bill/table/disposal controls. `server/app.mjs`: authenticated/scoped API, guest routes, files, export and administration. `shared/modules.mjs`: shared form validation and role permissions. `src/`: responsive operational UI. Browser fonts are self-hosted with bundled OFL licences.

Money is stored as integer fils. Stock uses integer base units: grams, millilitres or units. Order prices and recipes are snapshots. UTC timestamps are retained; the operational business date uses Asia/Dubai. Stock balances derive from lots and logged movements, with independent order reservations. SQLite transactions roll back incomplete state, including nested flows.

Sessions are HTTP-only/SameSite cookies with 8-hour expiry and hashed tokens in the database. Passwords use salted scrypt. Mutations require the session's CSRF token and an allowed Origin. APIs and downloads enforce tenant/outlet/role access. Payroll has a separate owner/HR boundary. Refunds and safety release have explicit role gates. Uploaded PDF/PNG/JPEG/text files are size/type checked, stored as BLOBs with SHA-256, and downloaded as attachments; document content is not executed or treated as system instructions.

## Account security and approvals

Every role can open **Account security** from the sidebar to change its password, manage sessions and enrol a TOTP authenticator. Administrators can reset a user to a temporary password, require a change before operational access, deactivate/reactivate accounts and change role/outlet assignments. Resets, access changes and deactivation revoke sessions. Authenticator login uses short-lived, attempt-limited challenges and rejects code replay; recovery codes are hashed and usable once.

Authenticator secrets use AES-256-GCM encryption. Production enrolment requires securely configured `APP_SECURITY_KEY` (64 hexadecimal characters); without it enrolment is explicitly unavailable. Development creates a mode-0600 `data/security.key`, which is ignored by Git. Preserve the matching key separately from database backups; losing it makes enrolled authenticators unreadable. Do not rotate the key without a planned re-encryption/recovery process. Requiring MFA by role and reviewed operator recovery procedures remain rollout gates.

Owners configure amount/percentage limits for discounts and **cumulative** order refunds per outlet. Temporary named-user delegations are scoped, expire within 31 days and can be revoked. The default limits preserve the previous role permissions; configure pilot limits before use. The decision and policy/delegation history are audited.

Organisation administration registers entities, brands, stock locations and custom kitchen stations. Stations route actual menu items and appear in kitchen filters. Stock locations currently provide the structure register; physical lot placement/moves remain an inventory-stage task. An outlet with transactions cannot change legal entity.

## Connected service controls

Dine-in lines can carry seats, courses and hold flags. Whole-order hold/resume preserves separately held courses; firing a course never consumes stock until preparation starts. Ownership transfers are audited. Amendments add current menu snapshots or remove only unprepared lines, release the removed reservations, create kitchen tickets and balance the financial difference. Prepared-item removal, reductions below recorded payments, refunded orders and immutable bill splits require a separate correction workflow.

Seat, item and amount bill parts retain the original total and discount rounding. Payments against split bills must select a part and cannot exceed its balance. Takeaway, pickup and delivery handover/dispatch require a complete item-and-quantity packing checklist; a remake resets its affected check.

## Fresh production database

Use a **separate empty DATA_DIR**. Configure ADMIN_EMAIL and a unique ADMIN_PASSWORD (at least 12 characters) securely in runtime settings, and APP_ORIGIN for the HTTPS host. Then build and run `npm start`. `NODE_ENV=production` disables demo access and uses Secure cookies. Credentials are never checked into files or logged. Set up the organisation, ingredients, opening counts, tables, users and menus through the owner settings. Do not promote the synthetic demo database to production.

Production rollout still needs the gates in the implementation plan, especially tax/invoice review, an approved MFA enforcement/recovery policy, provider authorisation, secret management, backups/encryption/TLS, load/device tests and jurisdiction-specific procedures. Settings accurately show providers as unconnected. Payroll preparation is not a validated WPS file; receipts are not structured eInvoices; the owner briefing is deterministic, not an LLM.

## Backup and recovery

`npm run backup` uses SQLite's consistent online backup API, including evidence-file BLOBs, and writes a mode-0600 file under `data/backups/`. Keep off-machine backups in an approved encrypted store. To restore: stop the app, preserve the existing database/WAL/SHM together, restore a backup to a fresh DATA_DIR as `restaurant.sqlite`, revoke restored sessions, run `PRAGMA integrity_check`, reconcile order/stock/journal/file counts, then start and validate the app. Never overwrite a running database. Tests restore backups into independent temporary paths and verify preserved totals. RPO/RTO and off-machine storage remain rollout decisions.

## Scope references

- [Original feature brief](docs/FEATURE-BRIEF.md)
- [Research text reference](docs/RESEARCH-REFERENCE.txt)
- [Brand text reference](docs/BRAND-REFERENCE.txt)
- [Staged execution and outstanding gates](docs/IMPLEMENTATION-PLAN.md)
- [Complete research catalogue status](docs/REQUIREMENTS.json)

The attachments are reference requirements, evidence and design inputs. Their links and recommendations do not authorise external communications, deployment, financial activity or regulator submissions.

Offline orders are durable browser drafts, scoped to the signed-in user and outlet. Connect once to register a non-extractable browser signing key; drafts survive reloads and are checked for signature, device revocation, menu versions, approvals and available stock at acceptance. Conflicts can be restored at current prices for operator review. Revoke lost browsers from Account security; prepare a new key in POS after revocation. Older unsigned drafts are retained for review. Clearing browser storage removes unsynced drafts; the database backup does not contain them. The workspace must already be loaded online: offline application startup and printer interruption testing remain pending.

Tables & reservations includes a walk-in waitlist and combined physical seating. Seating rejects conflicting bookings, open orders and another seated walk-in party. New reservations/orders use the group’s first selected table; existing order bills, tenders and kitchen history remain separate. Releasing a group requires resolving occupants and bookings that need its capacity. Booking arrival/departure inputs use UAE time.

Reservation deposits are manually recorded cash/bank advances with receipt references. Cash requires an open receiving till; applying the advance creates an order tender without collecting money again. Unapplied refunds and applied-order refunds share cumulative booking approval limits, preserve original cash/bank evidence and do not restore food. Cancelled/no-show balances remain visible in Finance → Reservation deposits. A closed original cash till requires a future finance correction workflow. Advance-tax treatment, legal deposit receipts, commercial cancellation/forfeiture terms and provider authorisation require the remaining financial/pilot gates; no automatic forfeiture or online charging is implemented.
