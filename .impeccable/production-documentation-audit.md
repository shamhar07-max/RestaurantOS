# Production documentation audit

Date: 2026-10-11. Verdict: documented ordinary extension; no design-canon additions required.

## Preserved canon and primitives

Reviewed `DESIGN.md`, `.impeccable/design.json`, the production surface brief, `src/Production.tsx`, the production integration in `src/screens.tsx`, and the relevant CSS. The extension preserves Fig & Pear colors, Manrope interface type, Fraunces drawer titles, warm ruled surfaces, modest corners, and the existing responsive drawer/table model. It reuses `Drawer`, `Field`, `DataTable`, primary/secondary/text buttons, result boxes, panel notes, and catalogue section patterns. No new reusable color, typography, elevation, motion, or component primitive warrants a canon entry. `PRODUCT.md`, `DESIGN.md`, and the sidecar remain unchanged.

## Extent and limits

Production adds independently measured ingredient rows, issued lot/expiry/cost/allergen evidence, yield against planned output, and reviewed expiry correction. Inventory trace adds recorded downstream lots and recall-chain hold controls. Source release does not automatically release descendants. The existing navigation, batch register, quality workflow, evidence attachments, and contextual side sheets remain the authority.

Trace covers recorded lot relationships and affected-order exposure; bulk service does not establish individual consumer identity. Recall hold does not contact customers or certify recall completion. Allergen evidence is not an allergen-free declaration. These operational limits remain visible in the interface rather than becoming visual-system rules.

## Evidence and raster provenance

The 12 review PNGs are `.impeccable/review/production-{form,evidence,recall}[-details]-{desktop,mobile}.png`. `tests/browser/production.spec.mjs` generates them with Playwright against synthetic demo data at 1440×1000 and 390×844, with reduced motion and animations disabled. Each scenario captures the drawer top and scrolled details. These are generated UI evidence, not photographs, externally licensed artwork, or shipping raster assets. This extension ships no new raster assets.

The fresh finish reviewer inspected all 12 captures and reported no required fixes. This documentation pass sampled the mobile form, desktop evidence details, and mobile recall details against the code/canon. Reported validation: focused production browser tests 3 passed, backend tests 78 passed, and build passed. The parent subsequently verified the full browser suite: 26/26 passed with paced demo logins honoring the unchanged 20/minute limit. This audit does not claim broader visual coverage.

Documentation scope is complete. No redesign, drift repair, or unrelated canon regeneration was performed.
