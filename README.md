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

## Fresh production database

Use a **separate empty DATA_DIR**. Configure ADMIN_EMAIL and a unique ADMIN_PASSWORD (at least 12 characters) securely in runtime settings, and APP_ORIGIN for the HTTPS host. Then build and run `npm start`. `NODE_ENV=production` disables demo access and uses Secure cookies. Credentials are never checked into files or logged. Set up the organisation, ingredients, opening counts, tables, users and menus through the owner settings. Do not promote the synthetic demo database to production.

Production rollout still needs the gates in the implementation plan, especially tax/invoice review, MFA/password lifecycle, provider authorisation, secret management, backups/encryption/TLS, load/device tests and jurisdiction-specific procedures. Settings accurately show providers as unconnected. Payroll preparation is not a validated WPS file; receipts are not structured eInvoices; the owner briefing is deterministic, not an LLM.

## Backup and recovery

`npm run backup` uses SQLite's consistent online backup API, including evidence-file BLOBs, and writes a mode-0600 file under `data/backups/`. Keep off-machine backups in an approved encrypted store. To restore: stop the app, preserve the existing database/WAL/SHM together, restore a backup to a fresh DATA_DIR as `restaurant.sqlite`, revoke restored sessions, run `PRAGMA integrity_check`, reconcile order/stock/journal/file counts, then start and validate the app. Never overwrite a running database. Tests restore backups into independent temporary paths and verify preserved totals. RPO/RTO and off-machine storage remain rollout decisions.

## Scope references

- [Original feature brief](docs/FEATURE-BRIEF.md)
- [Research text reference](docs/RESEARCH-REFERENCE.txt)
- [Brand text reference](docs/BRAND-REFERENCE.txt)
- [Staged execution and outstanding gates](docs/IMPLEMENTATION-PLAN.md)
- [Complete research catalogue status](docs/REQUIREMENTS.json)

The attachments are reference requirements, evidence and design inputs. Their links and recommendations do not authorise external communications, deployment, financial activity or regulator submissions.
