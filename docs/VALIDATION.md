# Development validation — 11 October 2026

Initial operating format: dine-in + takeaway + delivery. All evidence uses synthetic data; no live financial or provider transactions were sent.

## Reproducible checks

- Clean lockfile installation previously passed with `npm ci --cache /workspace/.cache/npm --no-audit --no-fund`.
- `npm run build`: TypeScript checking and Vite production build passed for the continuation batch.
- `npm test`: original 28 domain/HTTP tests plus account/security/organisation/approvals (8), connected service (8), signed offline recovery (4), and hospitality/seating/deposits (9): 57 tests passed together.
- `npm run test:e2e`: 19 browser workflows passed together. Includes all workspaces, persistence, POS → kitchen → packing → handover, partial receiving/evidence, guest delivery, cashier restrictions, keyboard-safe mobile navigation, approval/access administration, organisation stations, held courses, ownership/amendments, seat tenders, and signed draft reload/sync. Menu-conflict review retains its draft until acceptance succeeds; draft-discard confirmation preserves data when cancelled.
- Screenshot capture rerun with reduced motion: course, amendment and offline desktop/mobile workflows passed. Evidence is under `.impeccable/review/` (ignored runtime artifacts).
- Consistent online backup and restoration of attachment bytes/SHA-256 passed in the baseline tests. Database backups exclude browser-held drafts and the separate authenticator encryption key; preserve these according to README.

The continuation tests verify forced password changes, encrypted MFA enrolment, challenge-only login, TOTP/recovery replay rejection, revoked sessions, tenant/outlet scope, cumulative refund approval, time-limited delegation, historical entity locks, independent held courses, safe amendment rollback and financial balance, exact packing/remake checks, seat-payment caps, and signed device/clock/menu/stock checks. Passing tests do not certify real terminals, banks or printer hardware.

## UI finish review

The initial independent Impeccable reviewer scored mobile-navigation, readable-text and pluralisation fixes resolved. The Stage 1 reviewer returned **ship** for the account security, approval/delegation and organisation extension, with minor copy corrections applied. Stage 2 review covers only the new connected-service and offline surfaces. Its final disposition was **ship** after scoring all three findings resolved: discard confirmation, accurate offline preparation status, and separated packing modifiers. The verdict scores this fix list; it is not whole-product approval. The documenter verified ordinary extensions preserve DESIGN.md and its sidecar. It reported pre-existing narrative and mobile guest-label drift without modifying the incumbent artifacts. Reviews do not certify every workspace or production readiness.

## Scope and source persistence

The supplied feature brief is retained in full. All 54 research catalogue entries are mapped: 23 implemented core, 23 partial, 8 planned. Definitions and remaining specialist capabilities are explicit in REQUIREMENTS.json and IMPLEMENTATION-PLAN.md.

The baseline source was committed and pushed to GitHub main (`1dae9a8`). This continuation adds account security, configurable approvals/delegations, organisation registers, course/packing/amendment/seat controls and durable signed offline recovery. Its final commit and remote verification are reported with the delivery. Deployment, production provider connection and regulator certification are not claimed.

## Next execution gates

Stage 1 still needs Arabic/RTL, approved logo masters and real operator/security policy validation. Stage 2 still needs prepared-item corrections after refunds/splits, per-unit sharing, waitlist/deposits/table merging, combos/variants, complete offline startup and printer fallback. Later stages retain the stock/production, finance, specialist-service, integration and rollout gates in IMPLEMENTATION-PLAN.md. An implemented screen or test does not close these gates.

Built development app restarted successfully: health, web root, owner demo login and authenticated bootstrap all returned HTTP 200 on port 3001, with existing outlet data and configured stations.

## Host-service continuation

Implemented and checked walk-in waitlist calling/seating/departure, physical table groups and protected release, UAE-time booking windows, reservation deposit receipts, application to an order/bill part, original-source partial refunds, cumulative booking approval across applied/unapplied amounts, deposit-aware till counts, and finance access to outstanding/cancelled booking advances. Existing order bills and kitchen evidence remain distinct when seating is combined.

New backend checks cover group capacity/member booking conflicts, occupancy and state/version guards, receipt/application/refund replay, no duplicate cash collection, approval bypass prevention, closed-period rollback and tenant/outlet/host-versus-finance permissions. New browser workflows cover waitlist departure, seating combination/release, recorded bank advance to a meal bill, and accountant deposit review.

The independent hospitality reviewer requested one state fix: summary loading/failure must not appear as a verified zero balance. Explicit loading/unavailable states and withheld controls are implemented; the post-fix five-workflow browser run passed, including delayed, failed and recovered summaries. The independent verdict was **ship**, scoring this state issue resolved. Ordinary extension documentation preserves the incumbent design artifacts. Tax treatment, legal receipts, closed-till corrections, automatic forfeiture/no-show terms and production validation remain staged gates.

Host-service built development app restarted against the existing database: web root, health, scoped waitlist, active table groups and finance reservation-deposit register returned HTTP 200. The final build passed. The 19-workflow full browser run plus post-fix five-workflow run cover 20 distinct browser workflows; they are reported separately rather than claiming a combined 20-test run.
