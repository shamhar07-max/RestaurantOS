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

### Fixed-combo backend foundation — 2026-10-11

Added transactional tests for exact bundle-price allocation with multiple component units and quantities, station routing, ingredient consumption without parent duplication, balanced postings, immutable accepted snapshots, complete-bundle amendments, shortage rollback and invalid/stale/nested/foreign configuration. HTTP evidence checks scoped configuration and explicit signed-offline combo rejection. No operator combo UI, variant workflow, aggregate combo availability display or offline component-version support is claimed; combo SKUs remain withheld from discovery until that work is complete.

Verification: production build/type check passed; complete backend suite 63/63 passed; complete browser suite 20/20 passed. After adding the scoped configuration read endpoint, focused offline/HTTP suite 5/5 passed. Restarted demo API returned HTTP 200 with database health confirmed.

### Catalogue operators and connected acceptance — 2026-10-11

Independent variant SKUs can be linked/unlinked with scoped optimistic versions. Fixed combos can be created and edited through manager drawers, inspected in POS and ordered directly. Combined ingredient stock and modifier allergens are computed before acceptance. Signed offline drafts require all component versions; online POS records version evidence and refuses mixed-version baskets. Historical names, prices, recipes and bundle identity remain immutable.

Production build/type check passed. Complete backend suite 69/69 passed; the subsequent focused catalogue suite 11/11 passed including a new preview/snapshot-name test (70 distinct backend tests verified). Complete browser suite 23/23 passed, including three new manager/POS/guest/offline workflows. Independent finish reviewer returned **ship** for this extension after 12 validated desktop/mobile captures; documentation audit confirmed the incumbent system and preserved DESIGN.md and its sidecar. Detector unavailable; review used manual craft checks. No full-OS, provider or commercial readiness claim.

### Multi-input production and recorded recall — 2026-10-11

Complete backend suite: 78/78 passed. New transactional checks cover multiple inputs, immutable FEFO source evidence, shortage rollback, production-in-progress/rejection/output-rounding balance, expiry/hold/role/version/closed-period guards, evidenced expiry correction, prepared-component allergen inheritance through nested batches and transfers, recursive reserved/consumed order exposure, outlet-limited trace and atomic recall quarantine with ancestor release controls. Production build/type check passed.

Focused production browser run: 3/3 passed, covering multi-input creation/release, rejected unsafe expiry followed by evidenced correction without reissue, and downstream trace/recall hold. The first focused run exposed an exact text-label locator mismatch on a select; accessible-role selectors corrected the test. The first expanded browser suite exceeded the existing 20-per-minute IP login limit. Test logins now pace requests without disabling or altering the application protection; final full-suite outcome is recorded below.

All 12 synthetic desktop/mobile form, released-evidence and recall screenshots were opened and inspected. The independent production finish reviewer passed this narrow extension with no required fixes; manual craft review used because the launcher/detector is unavailable. Dedicated correction, warning and post-hold states are behavior-tested and code-reviewed rather than separately captured. No new shipping raster assets. Incumbent design canon is preserved. This does not certify full OS, food safety procedure, regulatory recall completion or consumer identity.

Built development app restarted against the existing database: web root, health, owner demo login, authenticated bootstrap, batch register and scoped lot trace returned HTTP 200. Existing historical executing batches lacking immutable input-lot evidence remain blocked from release pending reconciliation; no invented genealogy is backfilled.

Final expanded full browser suite: **26/26 passed together** with the unchanged application login limit and paced demo test logins. Final build/type check passed again.
