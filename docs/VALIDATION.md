# Development validation — 11 October 2026

Initial operating format: dine-in + takeaway + delivery. Development evidence uses synthetic data; no live financial or provider transactions were sent.

## Reproducible checks

- `npm ci --cache /workspace/.cache/npm --no-audit --no-fund`: clean lockfile installation passed (158 packages).
- `npm run build`: TypeScript checking and Vite production build passed.
- `npm test`: 28 domain/HTTP tests passed. Includes atomic stock rollback, FEFO/quarantine, station readiness, cancellation/remakes/refunds, bill allocations and table scope, period locks, required modifiers, partial receipts, batches, transfers, contract calculations, safety permissions, financial balance, CSRF/outlet/tenant restrictions, and backup restore of evidence bytes and SHA-256.
- `npm run test:e2e`: all 7 browser tests passed. Includes all 15 workspaces, persisted login/data, POS → split tenders → kitchen → handover/complete, partial receiving with persisted attachment, guest delivery acceptance, restricted cashier navigation, mobile keyboard containment/restoration, and responsive screenshots.
- `npm run backup`: consistent online backup completed; runtime data/backups remain ignored by Git.
- Restarted the built development app: health, web root, owner demo login and authenticated bootstrap all returned HTTP 200 on the API port.

## UI finish review

Independent Impeccable reviewer returned **ship within reviewed scope** after scoring all three findings resolved: keyboard-safe mobile navigation, readable important mobile text, and correct item pluralisation. Evidence consists of the desktop overview, mobile overview, mobile POS captures and targeted code. This does not certify every workspace or production readiness.

## Scope and persistence

The complete supplied feature brief is retained. All 54 research catalogue entries are mapped: 19 implemented core, 27 partial, 8 planned. Status definitions and remaining specialist capabilities are explicit in REQUIREMENTS.json and IMPLEMENTATION-PLAN.md. Passing checks do not turn partial records into completed enterprise workflows.

The repository was initially empty. Source is currently local in `/workspace/RestaurantOS`; no Git commit, push, deployment or provider connection has been performed. The cloud setup draft was saved successfully with the correct checkout path and installation/start instructions. The user must review and save changes in environment settings, then publish the environment to activate that configuration. Fresh-task recovery from a remote clone is not claimed until source has been committed/pushed and independently restored.
