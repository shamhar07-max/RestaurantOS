import { z } from 'zod';
import { id, now, transaction, audit, businessDate } from './db.mjs';
import { assert, summary, inventory, menu, parseRecord } from './domain.mjs';
import { allowed } from '../shared/modules.mjs';
import { forecastDemand, backtestForecast, operationalVariance } from './analytics-ext.mjs';

// AI & automation (brief section 19).
//
// Every assistant is deterministic first: facts come only from verified
// database queries. A language model may be mounted behind an OpenAI-compatible
// endpoint (`openai` / `groq` / `openrouter` / `ollama`) with credentials kept
// in the environment, never in the database. When no provider is configured the
// assistants still work — they answer entirely from the verified facts.
//
// Guardrails (mirroring the brief):
//  - Assistants never post journals, change prices, release stock or decide
//    food safety. They produce facts, suggestions and *drafts*.
//  - Each agent has a documented control and a required approval step for any
//    action it proposes.
//  - Communication drafts can never send; sending only happens through the
//    existing approved-campaign path.
//  - Kitchen exceptions report recorded state only; the assistant cannot mark
//    a task ready or invent preparation status.

const dayMs = 86400000;
const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * dayMs).toISOString().slice(0, 10);
const aed = (n) => `AED ${(Number(n) / 100).toFixed(2)}`;
const fact = (label, value, evidence = 'Verified database query') => ({ label, value: String(value), evidence });

// ---------------------------------------------------------------------------
// Language-model provider (optional). Credentials live in the environment only.
// ---------------------------------------------------------------------------
const providerDefaults = { openai: 'https://api.openai.com/v1', groq: 'https://api.groq.com/openai/v1', openrouter: 'https://openrouter.ai/api/v1', ollama: 'http://localhost:11434/v1', mock: '' };
export function providerConfig() {
  const provider = (process.env.AI_PROVIDER || 'none').toLowerCase();
  const baseUrl = (process.env.AI_BASE_URL || providerDefaults[provider] || '').trim().replace(/\/+$/, '');
  const model = (process.env.AI_MODEL || '').trim();
  const key = process.env.AI_API_KEY || '';
  let connected = false;
  if (provider === 'mock') connected = true;
  else if (provider === 'none') connected = false;
  else if (provider === 'ollama') connected = !!baseUrl;
  else connected = !!baseUrl && !!key;
  return { provider, baseUrl, model, key, connected };
}
export function aiProviderStatus() { const c = providerConfig(); return { provider: c.provider, model: c.model, connected: c.connected }; }

const CHAT_TIMEOUT_MS = 25000;
// Test seam: lets hermetic tests drive the language-model path without a network.
let customChat = null;
export function setChatTransport(fn) { customChat = fn; }
async function chat(cfg, system, user, maxTokens = 640) {
  if (customChat) return customChat(system, user);
  if (cfg.provider === 'mock') return 'Assistant note (mock provider): review the verified facts in the workspace and confirm decisions with a responsible team member before acting. Language-model output is always a draft and never executes an action.';
  if (!cfg.connected) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
      body: JSON.stringify({ model: cfg.model || 'default', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2, max_tokens: maxTokens }),
      signal: controller.signal, redirect: 'follow',
    });
    if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`AI provider returned ${res.status}: ${body.slice(0, 200)}`); }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('AI provider returned no completion text.');
    return content.trim();
  } finally { clearTimeout(timer); }
}
function parseJsonContent(content) {
  const clean = content.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Agent definitions.
// ---------------------------------------------------------------------------
function runOwnerBriefing(db, ctx) {
  const s = summary(db, ctx);
  const records = db.prepare('SELECT * FROM records WHERE tenant_id=? AND outlet_id=? ORDER BY created_at DESC').all(ctx.tenantId, ctx.outletId).map(parseRecord);
  const requested = records.filter(r => r.module === 'purchases' && r.status === 'requested').length;
  const incidents = records.filter(r => r.module === 'incidents' && r.status !== 'resolved').length;
  const holds = records.filter(r => r.module === 'batches' && r.status === 'quality_hold').length;
  const low = inventory(db, ctx).filter(i => i.available < i.reorder_level).slice(0, 5).map(i => `${i.name} (${i.available} ${i.unit})`);
  const variance = readVariance(db, ctx);
  const facts = [
    fact('Business date', s.businessDate),
    fact('Orders accepted today', s.orderCount),
    fact('Open orders', s.openOrders),
    fact('Net sales today', aed(s.netSales)),
    fact('Recorded collections', aed(s.collected)),
    fact('Contribution (net sales − posted food cost)', aed(s.contribution)),
    fact('Low-stock ingredients', low.length ? low.join(' · ') : 'none'),
    fact('Purchasing approvals pending', requested),
    fact('Open safety incidents', incidents),
    fact('Batches on quality hold', holds),
    ...(variance ? [fact('7-day contribution margin', variance.contributionMargin === null ? '—' : `${variance.contributionMargin}%`), fact('7-day recorded delays', variance.delayCount)] : []),
  ];
  return { facts, suggestion: null, draft: null, actions: s.actions.slice(0, 6), hint: 'Summarise today in a short, calm owner brief for a restaurant manager.' };
}
function readVariance(db, ctx) {
  if (!['owner', 'manager', 'accountant'].includes(ctx.user.role)) return null;
  try { return operationalVariance(db, ctx, {}); } catch { return null; }
}

function runDemand(db, ctx, input) {
  permitReports(ctx);
  const b = z.object({ itemId: z.string().max(200).optional(), window: z.number().int().min(1).max(90).default(7), horizon: z.number().int().min(1).max(30).default(7) }).strict().parse(input || {});
  let forecast = null, backtest = null, error = null;
  try {
    forecast = forecastDemand(db, ctx, { itemId: b.itemId, window: b.window, horizon: b.horizon });
  } catch (e) { error = e.message; }
  if (forecast) {
    try { backtest = backtestForecast(db, ctx, { itemId: b.itemId, window: b.window, horizon: 1 }); } catch { backtest = null; }
  }
  const item = b.itemId ? menu(db, ctx).find(i => i.id === b.itemId) : null;
  const facts = [];
  if (error) facts.push(fact('Forecast unavailable', error));
  else {
    facts.push(fact('Item', item ? `${item.name} (${b.itemId})` : 'All items'),
      fact('Method', forecast.basis),
      fact('Forecast base (' + forecast.horizon + '-period plan)', `${forecast.base} units`),
      fact('Observed range', `${forecast.low} – ${forecast.high}`),
      fact('Forecast horizon', `${forecast.horizon} forward period(s)`));
    if (backtest) facts.push(fact('Backtest error (MAE)', backtest.mae * 100 + ' fils-equivalent units scale'), fact('Backtest bias', backtest.bias), fact('Backtest MAPE', `${backtest.mape}%`));
  }
  const ingredients = item && forecast ? item.recipe.map(r => ({ ingredientId: r.ingredientId, quantity: Math.max(1, Math.round(r.quantity * forecast.base)) })) : null;
  const draft = forecast ? { kind: 'production_plan', itemId: b.itemId || null, itemName: item?.name || 'All items', quantity: forecast.base, horizon: b.horizon, ingredients, note: 'Manager review required before planning a batch. The assistant never raises a batch.' } : null;
  return { facts, suggestion: draft ? draft.note : null, draft, hint: 'Explain the forecast and its measured uncertainty in plain language.' };
}
function permitReports(ctx) {
  if (!['owner', 'manager', 'accountant'].includes(ctx.user.role)) assert(false, 'Demand analysis requires owner, manager or accountant.', 403);
}

function runPurchasing(db, ctx, input) {
  const b = z.object({ days: z.number().int().min(1).max(90).default(7), leadDays: z.number().int().min(1).max(60).default(2), coverDays: z.number().int().min(0).max(30).default(2), safetyUnits: z.number().int().min(0).max(1_000_000).default(0) }).strict().parse(input || {});
  const items = inventory(db, ctx);
  const since = new Date(Date.now() - b.days * dayMs).toISOString();
  const usageRows = db.prepare("SELECT ingredient_id, COALESCE(SUM(-quantity),0) used FROM movements WHERE tenant_id=? AND outlet_id=? AND type IN ('sale','remake','waste','production_issue') AND created_at>=? GROUP BY ingredient_id").all(ctx.tenantId, ctx.outletId, since);
  const used = new Map(usageRows.map(r => [r.ingredient_id, r.used]));
  const packs = db.prepare("SELECT id,data FROM records WHERE tenant_id=? AND outlet_id=? AND module='packs' AND status='active'").all(ctx.tenantId, ctx.outletId).map(parseRecord);
  const suppliers = new Map(db.prepare("SELECT id,data FROM records WHERE tenant_id=? AND outlet_id=? AND module='suppliers' AND status='approved'").all(ctx.tenantId, ctx.outletId).map(parseRecord).map(r => [r.id, r.data]));
  const lines = [];
  for (const item of items) {
    const daily = (used.get(item.id) || 0) / b.days;
    const needed = Math.round(daily * (b.leadDays + b.coverDays)) + b.safetyUnits;
    const target = Math.max(needed, item.reorder_level || 0);
    const shortage = Math.max(0, target - item.available);
    if (!shortage) continue;
    const packOptions = packs.filter(p => p.data.ingredientId === item.id)
      .map(p => ({ pack: p, supplier: suppliers.get(p.data.supplierId) || null, eff: (p.data.packSize > 0) ? p.data.packCost / p.data.packSize : Infinity }))
      .sort((x, y) => x.eff - y.eff);
    const best = packOptions[0];
    const supplier = best?.supplier || null;
    const lead = best ? (Number(supplier?.leadDays) || b.leadDays) : Math.max(b.leadDays, item.reorder_level ? 1 : b.leadDays);
    const packCount = best ? Math.ceil(shortage / best.pack.data.packSize) : 1;
    const qty = best ? packCount * best.pack.data.packSize : shortage;
    lines.push({ ingredientId: item.id, name: item.name, unit: item.unit, available: item.available, reorder: item.reorder_level, dailyUse: Math.round(daily * 100) / 100, shortage, qty, packId: best?.pack.id || null, packCount: packCount || null, leadDays: lead, supplierName: supplier?.name || null, unitCostFils: best ? Math.round(best.eff) : item.unit_cost });
  }
  lines.sort((a, b2) => b2.shortage - a.shortage);
  const facts = [fact('Purchase suggestions', lines.length)]; 
  if (!lines.length) facts.push(fact('Nothing to order', 'No ingredient currently needs replenishment for the projected horizon.'));
  for (const l of lines.slice(0, 8)) {
    const via = l.packId ? ` · pack ${Math.ceil(l.qty / (lines.find(x => x === l)?.packCount * (l.packCount || 1)) || 1)}` : '';
    facts.push(fact(`${l.name} (${l.unit})`, `short ${l.shortage} · suggest ${l.qty}${via} · available ${l.available} · reorder ${l.reorder}${l.supplierName ? ' · ' + l.supplierName : ''}`));
  }
  const draft = lines.length ? { kind: 'purchase_suggestion', horizonDays: b.days, leadDays: b.leadDays, lines: lines.slice(0, 12), note: 'Approval is required before any purchase order is raised. The assistant never creates or sends an order.' } : null;
  return { facts, suggestion: draft?.note || null, draft, hint: 'Summarise which items need ordering and why, based only on the listed facts.' };
}

function runMenuCost(db, ctx) {
  const items = menu(db, ctx).filter(i => !i.variantParentId);
  const rows = items.map(i => {
    const contribution = (i.price || 0) - (i.estimatedCost || 0);
    return { id: i.id, name: i.name, category: i.category, price: i.price, cost: i.estimatedCost, contribution, margin: i.price ? contribution / i.price : 0, sellable: !!i.available && !!i.stockAvailable };
  });
  const weak = rows.filter(r => r.margin < 0.15 || r.contribution < 0).sort((a, b2) => a.margin - b2.margin);
  const unsellable = rows.filter(r => !r.sellable);
  const facts = [fact('Menu items reviewed', rows.length)];
  if (weak.length) {
    facts.push(fact('Contribution-risk items (margin < 15%)', weak.length));
    for (const r of weak.slice(0, 6)) facts.push(fact(r.name, `${r.category} · price ${aed(r.price)} · recipe cost ${aed(r.cost)} · contribution ${aed(r.contribution)} (${Math.round(r.margin * 100)}%)`));
  } else facts.push(fact('Contribution review', 'Every active menu item currently clears a 15% contribution margin against current recipe cost.'));
  if (unsellable.length) facts.push(fact('Sellable but flagged', `${unsellable.length} item(s) cannot currently be sold (availability or insufficient stock): ${unsellable.slice(0, 5).map(r => r.name).join(', ') || 'none'}`));
  return {
    facts,
    suggestion: weak.length ? 'Review portioning, supplier price and menu price for the flagged items. The assistant never changes a price.' : 'No price action needed from current recipe cost. Re-check after receiving-price or recipe changes.',
    draft: null,
    hint: 'Explain, neutrally, that these are cost-review candidates and that prices must be changed by a manager only.',
  };
}

function runReconciliation(db, ctx) {
  const records = db.prepare('SELECT * FROM records WHERE tenant_id=? AND outlet_id=?').all(ctx.tenantId, ctx.outletId).map(parseRecord);
  const settlements = records.filter(r => r.module === 'settlements' && r.status === 'unmatched');
  const exceptions = settlements.map(r => {
    const d = r.data;
    const expected = (d.gross || 0) - (d.refunds || 0) - (d.discounts || 0) - (d.commission || 0) - (d.adjustments || 0);
    const actual = d.payout || 0;
    return { id: r.id, name: d.name || r.id, channel: d.channel || '', gross: d.gross || 0, expected, actual, variance: actual - expected };
  }).filter(l => l.variance !== 0);
  const draftBills = records.filter(r => r.module === 'bills' && r.status === 'draft').length;
  const chargebacks = db.prepare("SELECT COUNT(*) n FROM chargebacks WHERE tenant_id=? AND outlet_id=? AND status<>'resolved'").get(ctx.tenantId, ctx.outletId).n;
  const refunds = db.prepare('SELECT COALESCE(SUM(r.amount),0) n FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.tenant_id=? AND r.outlet_id=?').get(ctx.tenantId, ctx.outletId).n;
  const facts = [fact('Unmatched settlements', settlements.length), fact('Settlement variances', exceptions.length), fact('Draft supplier bills awaiting matching', draftBills), fact('Open chargebacks', chargebacks), fact('Approved refunds posted', aed(refunds))];
  for (const e of exceptions.slice(0, 6)) facts.push(fact(`${e.channel} · ${e.name}`, `gross ${aed(e.gross)} · expected payout ${aed(e.expected)} · actual ${aed(e.actual)} · variance ${aed(e.variance)}`));
  if (!exceptions.length) facts.push(fact('Settlement check', 'Every unmatched settlement reconciles to its expected payout.'));
  const draft = { kind: 'reconciliation_exceptions', settlements: exceptions.slice(0, 12), note: 'The accountant must approve each exception before any match is recorded.' };
  return { facts, suggestion: exceptions.length ? `${exceptions.length} settlement(s) need an accountant to investigate payout variance.` : 'No payout exceptions right now.', draft, hint: 'Frame exceptions as accounts-work requiring accountant approval, never as automatically matched.' };
}

function runKitchen(db, ctx) {
  const nowMs = Date.now();
  const openIds = db.prepare("SELECT id FROM orders WHERE tenant_id=? AND outlet_id=? AND status NOT IN ('cancelled','completed','handed_over')").all(ctx.tenantId, ctx.outletId).map(r => r.id);
  const rows = [];
  for (const oid of openIds) {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
    const tasks = db.prepare("SELECT * FROM tasks WHERE order_id=? AND status NOT IN ('ready','cancelled')").all(oid);
    for (const t of tasks) {
      const prepMax = db.prepare('SELECT COALESCE(MAX(m.prep_minutes),0) p FROM line_service s JOIN order_lines l ON l.id=s.line_id JOIN menu m ON m.id=l.item_id WHERE s.task_id=?').get(t.id).p;
      const base = t.started_at || order.created_at;
      const wait = Math.max(0, Math.round((nowMs - new Date(base).getTime()) / 60000));
      const overdue = wait - prepMax;
      const items = db.prepare('SELECT l.name,l.quantity FROM line_service s JOIN order_lines l ON l.id=s.line_id WHERE s.task_id=?').all(t.id).map(l => `${l.quantity}× ${l.name}`).join(', ') || '—';
      rows.push({ taskId: t.id, orderId: oid, number: order.number, station: t.station, status: t.status, items, customer: order.customer || '', channel: order.channel, prepMinutes: prepMax, waitMinutes: wait, overdueMinutes: overdue, delayReason: t.delay_reason || null });
    }
  }
  const overdue = rows.filter(r => r.overdueMinutes > 0).sort((a, b2) => b2.overdueMinutes - a.overdueMinutes);
  const backlog = rows.reduce((a, r) => { a[r.station] = (a[r.station] || 0) + 1; return a; }, {});
  const facts = [fact('Open kitchen tasks', rows.length), fact('Station backlog', Object.entries(backlog).map(([s, n]) => `${s}: ${n}`).join(' · ') || 'none')];
  if (overdue.length) {
    facts.push(fact('Overdue tickets', overdue.length));
    for (const r of overdue.slice(0, 8)) facts.push(fact(`#${r.number} · ${r.station}`, `${r.items} · waiting ${r.waitMinutes} min, prep ${r.prepMinutes} min · overdue by ${r.overdueMinutes} min${r.delayReason ? ' · delay: ' + r.delayReason : ''} · ${r.channel}${r.customer ? ' · ' + r.customer : ''}`));
  } else facts.push(fact('Ticket health', 'No ticket is past its station prep time.'));
  return { facts, suggestion: overdue.length ? `${overdue.length} ticket(s) are past station prep time — fire the most overrun station keepers. Facts reflect recorded kitchen state only.` : null, draft: null, hint: 'Highlight the most overdue tickets using only the listed facts. Never claim a task is ready.' };
}

function runWastage(db, ctx) {
  const from = new Date(Date.now() - 30 * dayMs).toISOString();
  const byReason = db.prepare("SELECT m.reason,SUM(-m.quantity*l.unit_cost) cost,SUM(-m.quantity) qty,COUNT(*) n FROM movements m LEFT JOIN lots l ON l.id=m.lot_id WHERE m.tenant_id=? AND m.outlet_id=? AND m.type IN ('waste','disposal') AND m.created_at>=? GROUP BY m.reason ORDER BY cost DESC").all(ctx.tenantId, ctx.outletId, from);
  const byIngredient = db.prepare("SELECT m.ingredient_id,i.name,SUM(-m.quantity*l.unit_cost) cost,SUM(-m.quantity) qty FROM movements m JOIN ingredients i ON i.id=m.ingredient_id LEFT JOIN lots l ON l.id=m.lot_id WHERE m.tenant_id=? AND m.outlet_id=? AND m.type IN ('waste','disposal') AND m.created_at>=? GROUP BY m.ingredient_id ORDER BY cost DESC LIMIT 8").all(ctx.tenantId, ctx.outletId, from);
  const today = businessDate();
  const expiring = db.prepare("SELECT i.name,l.code,l.expiry,l.quantity,l.unit_cost FROM lots l JOIN ingredients i ON i.id=l.ingredient_id WHERE l.tenant_id=? AND l.outlet_id=? AND l.status='available' AND l.expiry>=? AND l.expiry<=? AND l.quantity>0 ORDER BY l.expiry").all(ctx.tenantId, ctx.outletId, today, addDays(today, 7));
  const quarantined = inventory(db, ctx).filter(i => (i.quarantined || 0) > 0).map(i => `${i.name} (${i.quarantined} ${i.unit})`);
  const totalCost = byReason.reduce((s, r) => s + (r.cost || 0), 0);
  const facts = [
    fact('Waste / disposal cost · last 30 days', aed(totalCost)),
    fact('Recorded waste events', byReason.reduce((s, r) => s + r.n, 0)),
    ...byReason.slice(0, 5).map(r => fact(`Reason: ${r.reason || 'unspecified'}`, `${r.qty} units · ${aed(r.cost)}`)),
    ...byIngredient.slice(0, 5).map(r => fact(`Top ingredient: ${r.name}`, `${r.qty} units · ${aed(r.cost)}`)),
    fact('Stock expiring within 7 days', expiring.length ? expiring.map(e => `${e.name} (${e.quantity} ${e.quantity} units)`).join(' · ') : 'none'),
    fact('Quarantined stock', quarantined.length ? quarantined.join(' · ') : 'none'),
  ];
  const draft = { kind: 'wastage_review', byReason: byReason.slice(0, 10), byIngredient: byIngredient.slice(0, 10), expiring: expiring.slice(0, 10), note: 'Investigation suggestions only. Release, quarantining and disposal remain human decisions with recorded evidence.' };
  return { facts, suggestion: totalCost ? 'Investigate the flagged patterns with the kitchen. The assistant never decides whether stock is safe.' : 'No recorded waste pattern in the last 30 days.', draft, hint: 'Reframe findings as investigation proposals, never as a safety decision.' };
}

// ---------------------------------------------------------------------------
// Agent registry.
// ---------------------------------------------------------------------------
const agents = [
  { id: 'owner_briefing', name: 'Owner briefing', description: 'A verified picture of today — sales, contribution, attention items — for owner, manager and accountant.', roles: ['owner', 'manager', 'accountant'], requiresApproval: false, control: 'Uses verified queries', endpoint: 'run', run: runOwnerBriefing },
  { id: 'demand_assistant', name: 'Demand assistant', description: 'Backtested demand baseline over a moving window, with measured error, feeding a production-plan draft.', roles: ['owner', 'manager', 'accountant'], requiresApproval: true, control: 'Manager reviews production decisions before a batch is planned', endpoint: 'run', run: runDemand, inputs: [{ key: 'itemId', label: 'Menu item ID (blank = all items)', type: 'text' }, { key: 'window', label: 'Moving window · days', type: 'number', initial: '7' }, { key: 'horizon', label: 'Forecast horizon', type: 'number', initial: '7' }] },
  { id: 'purchasing_assistant', name: 'Purchasing assistant', description: 'Reorder suggestions from usage, on-hand, reorder levels and supplier packs.', roles: ['owner', 'manager', 'purchasing'], requiresApproval: true, control: 'Approval before ordering — no order is ever raised without management approval', endpoint: 'run', run: runPurchasing, inputs: [{ key: 'days', label: 'Usage look-back · days', type: 'number', initial: '7' }, { key: 'leadDays', label: 'Lead time · days', type: 'number', initial: '2' }, { key: 'coverDays', label: 'Cover days', type: 'number', initial: '2' }, { key: 'safetyUnits', label: 'Safety stock · base units', type: 'number', initial: '0' }] },
  { id: 'menu_cost_assistant', name: 'Menu-cost assistant', description: 'Contribution per item from current recipe cost; flags cost-review candidates without ever changing a price.', roles: ['owner', 'manager', 'accountant'], requiresApproval: false, control: 'No autonomous price changes', endpoint: 'run', run: runMenuCost },
  { id: 'document_intake', name: 'Document intake', description: 'Extract supplier invoice information from pasted text (or an AI provider, when configured) into a bill draft.', roles: ['owner', 'manager', 'accountant'], requiresApproval: true, control: 'Validation before posting — every draft is entered by an accountant in Finance', endpoint: 'documents/intake', inputs: [{ key: 'text', label: 'Invoice text', type: 'textarea', required: true }, { key: 'filename', label: 'Filename (optional)', type: 'text' }] },
  { id: 'reconciliation_assistant', name: 'Reconciliation assistant', description: 'Finds settlement payout variances, draft bills and open write-offs for the accountant to approve.', roles: ['owner', 'manager', 'accountant'], requiresApproval: true, control: 'Accountant approves every exception', endpoint: 'run', run: runReconciliation },
  { id: 'customer_assistant', name: 'Customer assistant', description: 'Answers approved menu and booking questions; escalates allergen questions to a person.', roles: ['owner', 'manager', 'cashier', 'waiter', 'accountant', 'chef'], requiresApproval: false, control: 'Answers only from approved data; escalates uncertain allergen questions', endpoint: 'customers/ask', inputs: [{ key: 'question', label: 'Customer question', type: 'text', required: true }] },
  { id: 'communication_drafter', name: 'Communication drafter', description: 'Drafts customer messages from consent statistics and campaign context — drafts never send.', roles: ['owner', 'manager'], requiresApproval: true, control: 'Approved sending rules — drafts never send', endpoint: 'communications/draft', inputs: [{ key: 'topic', label: 'Campaign topic', type: 'text', required: true }, { key: 'audience', label: 'Audience rule', type: 'text' }, { key: 'tone', label: 'Tone', type: 'text' }] },
  { id: 'kitchen_exception_assistant', name: 'Kitchen exception assistant', description: 'Highlights tickets past station prep time from recorded kitchen state only.', roles: ['owner', 'manager', 'chef'], requiresApproval: false, control: 'Cannot invent preparation status — facts come from kitchen task records', endpoint: 'run', run: runKitchen },
  { id: 'wastage_assistant', name: 'Wastage assistant', description: 'Patterns in waste, expiry and quarantine — as investigation proposals, never a safety decision.', roles: ['owner', 'manager', 'safety'], requiresApproval: true, control: 'No automatic safety decision — release and disposal stay with people', endpoint: 'run', run: runWastage },
];
export function aiAgents(db, ctx) {
  assert(allowed(ctx.user.role, 'ai', 'read'), 'Your role cannot view the AI workspace.', 403);
  return agents.map(({ run: _run, ...meta }) => meta);
}

function buildOutcome(agent, base, suggestion, cfg, providerError) {
  const connected = cfg.connected && !providerError;
  return {
    agent: agent.id, name: agent.name, description: agent.description, generatedAt: now(),
    deterministic: true, requiresApproval: agent.requiresApproval || !!base.requiresApproval,
    control: agent.control, roles: agent.roles,
    provider: { provider: connected ? cfg.provider : (cfg.provider === 'none' ? 'none' : cfg.provider), model: connected ? cfg.model : null, connected, providerError: providerError || null },
    facts: base.facts || [], suggestion: suggestion || base.suggestion || null, draft: base.draft || null, actions: base.actions || null,
    note: 'Assistants produce drafts and suggestions from verified database queries. They never post journals, change prices or decide food safety.',
  };
}
function logRun(db, ctx, agent, outcome, kind = 'run') {
  transaction(db, () => {
    const lid = id('ai');
    db.prepare('INSERT INTO assistant_log VALUES(?,?,?,?,?,?,?,?,?,?)').run(lid, ctx.tenantId, ctx.outletId, agent.id, kind, agent.requiresApproval ? 'draft' : 'accepted', JSON.stringify(outcome), 'Facts sourced only from verified database queries; language-model text is explanatory draft output.', ctx.user.id, now());
    audit(db, ctx, `ai.${agent.id}_ran`, lid, { agent: agent.id, requiresApproval: agent.requiresApproval });
    return lid;
  });
}
async function narrate(cfg, agent, facts, hint, maxTokens = 420) {
  const data = (facts || []).map(f2 => `- ${f2.label}: ${f2.value} (evidence: ${f2.evidence})`).join('\n');
  const system = `You are "${agent.name}" in RestaurantOS, assisting ${agent.roles.join(' and ')} roles. Guardrail: ${agent.control}.`;
  const user = `Write at most 120 words of plain operational guidance using ONLY these verified facts. Never invent numbers, records, names or states. Never instruct an action that bypasses the guardrail.${hint ? ` Context: ${hint}` : ''}\n\n${data || '(no facts yet — describe that there is nothing to review)'}`;
  return chat(cfg, system, user, maxTokens);
}

export async function runAssistant(db, ctx, agentId, input = {}) {
  const agent = agents.find(a => a.id === agentId);
  assert(agent, 'Unknown assistant.', 404);
  assert(agent.endpoint === 'run', 'This assistant runs through its dedicated endpoint.', 409);
  assert(agent.roles.includes(ctx.user.role), 'This assistant is outside your role.', 403);
  const base = agent.run(db, ctx, input || {});
  const cfg = providerConfig();
  let suggestion = base.suggestion || null, providerError = null;
  if (cfg.connected) { try { suggestion = await narrate(cfg, agent, base.facts, base.hint); } catch (e) { providerError = e.message; } }
  const outcome = buildOutcome(agent, base, suggestion, cfg, providerError);
  logRun(db, ctx, agent, outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Document intake.
// ---------------------------------------------------------------------------
function deterministicExtraction(t) {
  const ref = (t.match(/\b(?:INV(?:OICE)?|REF|BILL|PO|NO)[.:\s#-]+([A-Za-z0-9][A-Za-z0-9/._-]{1,29})/i) || [])[1] || null;
  const dateRow = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/) || t.match(/\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})\b/);
  let invoiceDate = null;
  if (dateRow) invoiceDate = dateRow[1].length === 4 ? `${dateRow[1]}-${dateRow[2]}-${dateRow[3]}` : `${dateRow[3]}-${String(dateRow[2]).padStart(2, '0')}-${String(dateRow[1]).padStart(2, '0')}`;
  const totalRow = [...t.matchAll(/(?:total|grand total|amount due|balance due|net due)[^0-9]{0,14}\s*([\d.,]{1,16})/gi)].map(m => parseFloat(m[1].replaceAll(',', ''))).filter(Number.isFinite);
  const taxRow = [...t.matchAll(/(?:vat|tax|input tax)[^0-9]{0,14}\s*([\d.,]{1,16})/gi)].map(m => parseFloat(m[1].replaceAll(',', ''))).filter(Number.isFinite);
  const gross = totalRow.length ? Math.max(...totalRow) : null;
  const tax = taxRow.length ? Math.max(...taxRow) : (gross != null ? Math.round((gross * 5 / 105) * 100) / 100 : null);
  const net = gross != null && tax != null ? Math.round((gross - tax) * 100) / 100 : null;
  const supplier = (t.split(/\n/)[0] || '').trim().slice(0, 120) || null;
  const lines = (t.match(/\n/gi) || []).length + 1;
  const currency = /AED|د.إ|UAE dirham|fils/i.test(t) ? 'AED' : null;
  return { supplier, invoiceNumber: ref, invoiceDate, net: net != null ? Math.round(net * 100) / 100 : null, tax: tax != null ? Math.round(tax * 100) / 100 : null, total: gross != null ? Math.round(gross * 100) / 100 : null, currency, lineCountEstimate: lines, confidence: 'deterministic', note: 'Deterministic extraction from the pasted text. Verify every figure before posting.' };
}
export async function intakeDocument(db, ctx, input) {
  assert(['owner', 'manager', 'accountant'].includes(ctx.user.role), 'Supplier document intake requires owner, manager or accountant.', 403);
  const b = z.object({ text: z.string().trim().min(10).max(50_000), filename: z.string().max(200).default('') }).strict().parse(input);
  const extracted = deterministicExtraction(b.text);
  let method = 'deterministic', model = null, aiNote = null;
  const cfg = providerConfig();
  if (cfg.connected) {
    try {
      const content = await chat(cfg,
        'You extract supplier invoices into JSON. Return ONLY a JSON object with keys: supplier, invoiceNumber, invoiceDate (YYYY-MM-DD), net, tax, total, currency, lineItems (array of {description, quantity, amount}), notes. Use null when a field is absent.',
        `Extract the invoice fields from this text:\n\n${b.text}`, 800);
      const ai = parseJsonContent(content);
      if (ai && typeof ai === 'object') { extracted.aiFields = ai; method = 'ai'; model = cfg.model; }
    } catch (e) { aiNote = `AI extraction unavailable (${e.message}); deterministic fields remain as a guide.`; }
  }
  const outcome = { id: null, filename: b.filename, extracted, method, model, posted: false, aiNote, control: 'Validation before posting — an accountant must enter and verify the bill in Finance. Nothing is posted by this assistant.', generatedAt: now() };
  const lid = transaction(db, () => {
    const rowId = id('ai');
    db.prepare('INSERT INTO assistant_log VALUES(?,?,?,?,?,?,?,?,?,?)').run(rowId, ctx.tenantId, ctx.outletId, 'document_intake', 'invoice_extraction', 'draft', JSON.stringify(outcome), 'Supplier document intake draft; validation before posting is mandatory.', ctx.user.id, now());
    audit(db, ctx, 'ai.document_extracted', rowId, { method, filename: b.filename });
    return rowId;
  });
  return { ...outcome, id: lid };
}

// ---------------------------------------------------------------------------
// Customer assistant.
// ---------------------------------------------------------------------------
export async function askCustomerAssistant(db, ctx, input) {
  assert(allowed(ctx.user.role, 'orders', 'read') || allowed(ctx.user.role, 'menu', 'read'), 'Your role cannot ask the customer assistant.', 403);
  const b = z.object({ question: z.string().trim().min(2).max(600) }).strict().parse(input);
  const q = b.question.toLowerCase().slice(0, 600);
  const items = menu(db, ctx).map(i => ({ name: i.name, category: i.category, price: i.price, available: !!i.available && !!i.stockAvailable, allergens: i.allergens || [] }));
  const allergensPresent = (items.find(i => i.allergens.length) || {}).allergens || [];
  const escalate = /allerg|intoleran|safe to eat|gluten|nut free|vegan|vegetarian|ingredient|contains|halal|kosher/.test(q);
  let answer = '', escalated = escalate;
  const quoted = (text, src = 'approved menu data') => ({ answer: text, escalated, source: src, quoted: true });
  if (escalate) return quoted('Allergen and ingredient confirmation must come from the kitchen. A team member will confirm with you before ordering — I cannot promise allergen safety automatically.', 'escalated to a person');
  if (/price|cost|how much|charge|aed|fils/.test(q)) {
    const hits = items.map(i => `${i.name}: ${aed(i.price)}`).join(' · ') || 'The menu is being updated.';
    return quoted(`Price list (VAT inclusive): ${hits}`);
  }
  if (/open|hour|close|when do you/.test(q)) return quoted('We serve across the business day; ask a host for today’s service times. You can also place a pickup order.', 'approved service information');
  if (/book|reserve|table|deposit/.test(q)) return quoted('Bookings are confirmed through the tables workspace; published deposit terms apply. Mention party size and preferred time to the host.', 'approved booking information');
  if (/avail|have |stock|sold out|in stock/.test(q)) {
    const soldOut = items.filter(i => !i.available);
    return quoted(soldOut.length ? `Currently unavailable: ${soldOut.map(i => i.name).join(', ')}. Everything else on the menu is available today.` : 'Everything on today’s menu is available.', 'approved menu data');
  }
  const menuLine = items.slice(0, 12).map(i => i.name).join(', ');
  return quoted(`Today I can confirm menu availability and prices. Here is the menu: ${menuLine}${items.length > 12 ? ' …' : ''}. For anything about allergens or ingredients I will connect you to the kitchen.`);
}

// ---------------------------------------------------------------------------
// Communication drafter.
// ---------------------------------------------------------------------------
export async function draftCommunication(db, ctx, input) {
  assert(['owner', 'manager'].includes(ctx.user.role), 'Communication drafting requires owner or manager.', 403);
  const b = z.object({ topic: z.string().trim().min(3).max(500), audience: z.string().trim().max(300).default('all active customers with consent'), channel: z.enum(['whatsapp_business', 'sms_gateway', 'email_relay']).default('whatsapp_business'), tone: z.string().trim().max(100).default('warm and concise') }).strict().parse(input);
  const customers = db.prepare("SELECT data FROM records WHERE tenant_id=? AND outlet_id=? AND module='customers' AND status='active'").all(ctx.tenantId, ctx.outletId).map(r => JSON.parse(r.data));
  const consented = customers.filter(c => c.consent === 'granted').length;
  const lastMessages = db.prepare('SELECT status,COUNT(*) n FROM message_log WHERE tenant_id=? AND outlet_id=? GROUP BY status').all(ctx.tenantId, ctx.outletId);
  const cfg = providerConfig();
  let message = null, providerError = null;
  if (cfg.connected) {
    try {
      message = await chat(cfg,
        `You draft restaurant marketing messages. Restraint, honesty, GDPR/UAE privacy: never promise, never invent offers, never exceed 140 words.`,
        `Topic: ${b.topic}\nAudience: ${b.audience}\nTone: ${b.tone}\nOnly ${consented} of ${customers.length} active customers have granted marketing consent — draft a message that works without price claims.\n`, 260);
    } catch (e) { providerError = e.message; }
  }
  if (!message) message = `Hello from Fig & Pear,\n\n${b.topic}.\n\nWe’re glad to keep you posted. Reply or speak to a host to stop updates at any time.`;
  const outcome = { draft: { channel: b.channel, audience: b.audience, tone: b.tone, message }, facts: [fact('Active customers', customers.length), fact('Marketing consent granted', consented), ...lastMessages.map(m => fact(`Last campaign · ${m.status}`, m.n))], requiresApproval: true, posted: false, provider: { ...aiProviderStatus(), providerError: providerError || null }, control: 'Approved sending rules — this draft never sends. Sending happens only through an approved campaign by a manager.', generatedAt: now() };
  const lid = transaction(db, () => {
    const rowId = id('ai');
    db.prepare('INSERT INTO assistant_log VALUES(?,?,?,?,?,?,?,?,?,?)').run(rowId, ctx.tenantId, ctx.outletId, 'communication_drafter', 'communication_draft', 'draft', JSON.stringify(outcome), 'Communication draft; requires approved campaign + manager sending.', ctx.user.id, now());
    audit(db, ctx, 'ai.communication_drafted', rowId, { channel: b.channel, topic: b.topic });
    return rowId;
  });
  return { ...outcome, id: lid };
}

// ---------------------------------------------------------------------------
// Activity log.
// ---------------------------------------------------------------------------
export function aiActivity(db, ctx) {
  assert(['owner', 'manager', 'accountant'].includes(ctx.user.role) || allowed(ctx.user.role, 'ai', 'read'), 'Assistant activity is restricted.', 403);
  return db.prepare('SELECT * FROM assistant_log WHERE tenant_id=? AND outlet_id=? ORDER BY created_at DESC LIMIT 120').all(ctx.tenantId, ctx.outletId).map(r => ({ ...r, payload: safeParse(r.payload), actor: db.prepare('SELECT name FROM users WHERE id=?').get(r.actor_id)?.name || r.actor_id }));
}
function safeParse(json) { try { return JSON.parse(json); } catch { return { raw: json }; } }
export function setActivityStatus(db, ctx, activityId, input) {
  assert(['owner', 'manager', 'accountant'].includes(ctx.user.role), 'Approving or dismissing assistant drafts requires owner, manager or accountant.', 403);
  const b = z.object({ status: z.enum(['accepted', 'dismissed']), reason: z.string().trim().max(500).optional() }).strict().parse(input);
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM assistant_log WHERE id=? AND tenant_id=? AND outlet_id=?').get(activityId, ctx.tenantId, ctx.outletId);
    assert(row, 'Assistant activity not found.', 404);
    assert(row.status === 'draft', 'Only draft activity can be accepted or dismissed.', 409);
    db.prepare('UPDATE assistant_log SET status=? WHERE id=?').run(b.status, activityId);
    audit(db, ctx, `ai.activity_${b.status}`, activityId, { agent: row.agent, reason: b.reason || '' });
    return { id: activityId, status: b.status };
  });
}

// ---------------------------------------------------------------------------
// Mount.
// ---------------------------------------------------------------------------
export function mountAiExt(app, db) {
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  app.get('/api/ai/status', (req, res) => res.json({ provider: aiProviderStatus(), agents: aiAgents(db, req.ctx), note: 'Assistants run on verified database queries. Language-model output — when a provider is mounted — is explanatory only and never executes an action. Drafts still require human approval.' }));
  app.post('/api/ai/agents/:id/run', asyncRoute(async (req, res) => res.json(await runAssistant(db, req.ctx, req.params.id, req.body))));
  app.post('/api/ai/documents/intake', asyncRoute(async (req, res) => res.json(await intakeDocument(db, req.ctx, req.body))));
  app.post('/api/ai/customers/ask', asyncRoute(async (req, res) => res.json(await askCustomerAssistant(db, req.ctx, req.body))));
  app.post('/api/ai/communications/draft', asyncRoute(async (req, res) => res.json(await draftCommunication(db, req.ctx, req.body))));
  app.get('/api/ai/activity', (req, res) => res.json(aiActivity(db, req.ctx)));
  app.post('/api/ai/activity/:id/status', (req, res) => res.json(setActivityStatus(db, req.ctx, req.params.id, req.body)));
}