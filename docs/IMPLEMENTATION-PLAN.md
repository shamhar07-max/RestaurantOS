# Restaurant OS — staged execution

Initial format confirmed by the user: **dine-in + takeaway + delivery**. Scope includes every workspace and capability in the uploaded feature brief and all 54 catalogue requirements in the research report. This is a staged product build; a visible screen does not establish that every specialist workflow is complete.

## Stage 1 — foundation and identity

Implemented: React/TypeScript app, Node/Express API, persistent SQLite/WAL database, tenant/legal entity/outlet schema, session authentication, password hashing, role/outlet checks, CSRF and origin checks, user administration, audit, ingredient/table/outlet setup, branded responsive interface. Fig/Pear colours and self-hosted Manrope/Fraunces follow the supplied guide. The actual logo masters were not uploaded; the UI uses a typographic product name instead of recreating the logo.

Remaining gates: configurable delegations and approval limits, MFA, password lifecycle and session revocation, additional legal entities/brands/stock locations/stations in admin UI, reviewed Arabic translation and RTL, jurisdiction-specific operator setup and security review. Specialist formats do not gain regulatory approval by selecting a setting.

## Stage 2 — connected restaurant service

Implemented: POS, item search/categories, notes, price and recipe snapshots, ingredient-aware modifiers, required/max modifier validation at API, branch availability, separate order/payment states, kitchen station routing and timers, delay reasons, consume-on-preparation, full-station readiness, handover/close, pre/post-preparation cancellation, remake, original-tender partial refunds, split tenders, immutable bill amount/item allocations, table transfer history, reservation conflict/capacity checks, guest pickup/delivery and private tracking, live refresh events, local offline draft queue.

Remaining gates: course hold/fire, item/seat-specific payment allocations, order amendments and amendment tickets, held orders/transfer ownership, waitlist/deposits/merge tables, combos/variants, durable signed offline queue and device conflict handling, packing checklist, printer reprint/fallback protocol and hardware tests. Offline drafts do not represent accepted orders or authorised card payments.

## Stage 3 — supply, ingredients and production

Implemented: supplier approval, purchase approval, inspected partial receipts with lot/expiry/evidence, stock reservation and FEFO, negative-stock blocking, quarantine/release permissions, stock counts/variance approval, waste/disposal, single-input batch issue/yield/quality hold/output release, source expiry retained across internal outlet transfers, movement ledger and lot trace queries, evidence files.

Remaining gates: supplier offer comparison and purchase packs/unit conversions; multi-line purchase orders and rejected receipts; ingredient substitutions and receipt quality rules; nested versioned recipe/BOM editor and multi-input batches; capacity planning and demand linkage; partial transfer receiving and intercompany treatment; full recall exposure traversal and reviewed shelf-life/label procedure.

## Stage 4 — financial control

Implemented: integer-fils pricing and cumulative-refund tax rounding, balanced journals for sales, consumption, tenders, refunds, losses, receipts, supplier matching/payment and transfers; trial balance/journal export; cash till close/shortage; manual settlement arithmetic and mismatch blocking; issued contract invoice evidence; closed business-date posting locks; restricted payroll preparation.

Remaining gates: accountant-approved configurable tax mapping, complete legal invoices/credit notes and deposits/customer advances; accounts ageing; cash movements/tips/gift-card/voucher ledgers; payment gateway/terminal authorisation and signed callbacks; chargebacks; bank and actual order-level marketplace matching; validated payroll/WPS export; financial corrections and period close with a pilot accountant. The default 5% UAE illustration is **not** a tax assessment. Manual bank evidence is not an online bank integration.

## Stage 5 — service extensions

Implemented baseline records: catering event lifecycle, guest/venue/quote/deposit notes, resource notes; fixed-person/accepted-meal/minimum/site contract calculation; frozen issued period evidence; subscription funded meal count, pause/resume/cancel and delivery evidence; dispatcher/rider/address/zone/promise/acceptance records; customer consent, complaint/campaign drafts, nonnegative/idempotent loyalty ledger; staff/shift/attendance/leave/overtime records; operator-defined safety checks with owned deviation incidents, evidence review and compliance register.

Remaining gates: event quote/change-order versions, resource conflict planning/equipment returns and actual profitability; effective-dated roster/headcount/meal calendars/cutoffs; demand snapshot → multi-input batch → bulk dispatch → partial acceptance → serving → invoice evidence; individual/group serving and duplicate/offline scans; client portal; subscription renewal, credit policy, address/calendar versioning and route plans; refund/complaint linkage; coupon/gift-card eligibility; consent-filtered messaging; reviewed multilingual safety procedures, calibration and training expiry. These extensions are a baseline, not a completed mess or specialist production package.

## Stage 6 — integrations, insights and automation

Implemented: explicit disconnected-provider register, deterministic owner briefing from verified queries, sales/item/channel and posted-consumption reports with calculation definitions, CSV export, stock/approval/safety attention queue.

Remaining gates: authorised Talabat/Deliveroo/Careem connectors with signed/idempotent callbacks, outbox/retries/mapping exceptions/menu acknowledgements; capacity throttling shared between brands; notification adapters; ASP eInvoicing; Foodwatch and WPS only after validation; forecasting backtests, supplier invoice extraction and optional LLM assistants with scoped tools/human review; complete labour/waste/delay/contribution variance reporting. AI never releases held food, invents readings or makes clinical-diet decisions.

## Stage 7 — pilot and rollout

Implemented development evidence: automated transactional, HTTP/access, persistence/restore and browser workflows; build/type checks; consistent database backup command and documented setup/start commands. Uploaded evidence files are stored in SQLite so backups include them.

Remaining gates: several complete real service/close cycles, operator signoff, bank/provider sandbox and production certification, device/printer interruption, recovery drill with attachments and documented RPO/RTO, load tests/concurrent devices, migration/import validation, monitoring/alerts, hosting/TLS/encryption/retention assessment, support/manual fallback runbooks, staff training, commercial onboarding. No deployment, publication, regulator certification or live provider connection is claimed.

## Critical controls

One event creates one order; one tender key records one payment. Reservations block overlapping bookings. Cashiers cannot release held stock or refund tenders. Expired/held/reserved stock cannot be silently consumed. A refund never restores food. Original prices/recipes remain immutable. Remakes issue more stock. Transfers reduce source stock before destination acceptance. Issued financial evidence cannot return to draft. Every journal balances in integer fils. Exports and files obey scope. Offline status remains pending/failed until the server accepts it. Loyalty balances derive from movements. Safety deviations create accountable tasks. AI recommendations are distinct from verified events.

These controls are implemented where listed above and exercised in the existing tests. Broader acceptance is tracked in REQUIREMENTS.json and the complete supplied FEATURE-BRIEF.md. Each pending feature remains part of scope; it is not omitted because its screen exists.
