import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, id, now, passwordHash } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createOrder } from '../server/domain.mjs';
import { createApp } from '../server/app.mjs';
import { runAssistant, intakeDocument, askCustomerAssistant, draftCommunication, aiActivity, setActivityStatus, aiAgents, providerConfig, setChatTransport } from '../server/ai-ext.mjs';

const fixture=(role='user_owner')=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare('SELECT * FROM users WHERE id=?').get(role);user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const plusUser=(db,idKey,role)=>db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,1)').run(idKey,'tenant_burj',`Test ${role}`, `${idKey}@test.local`,passwordHash('test-password-12'),role,JSON.stringify(['outlet_downtown']));
const rec=(db,module,key,status,data)=>db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?)').run(key,'tenant_burj','entity_burj','outlet_downtown',module,status,JSON.stringify(data),1,now(),now());
const zod=(e)=>e&&e.constructor&&e.constructor.name==='ZodError';

test('AI registry exposes all 10 guarded assistants and an unconnected provider by default',()=>{
  const {db,ctx}=fixture();
  const agents=aiAgents(db,ctx);
  assert.equal(agents.length,10);
  const ids=agents.map(a=>a.id);
  for(const required of ['owner_briefing','demand_assistant','purchasing_assistant','menu_cost_assistant','document_intake','reconciliation_assistant','customer_assistant','communication_drafter','kitchen_exception_assistant','wastage_assistant'])assert(ids.includes(required),required);
  for(const a of agents){assert(a.control&&a.control.length>12,`control missing for ${a.id}`);assert(a.roles.length,`roles missing for ${a.id}`);}
  const cfg=providerConfig();
  assert.equal(cfg.connected,false);
});

test('owner briefing summarises verified facts and logs an activity entry',async()=>{
  const {db,ctx}=fixture();
  const result=await runAssistant(db,ctx,'owner_briefing');
  assert.equal(result.requiresApproval,false);
  const labels=result.facts.map(f=>f.label);
  assert(labels.includes('Orders accepted today'));assert(labels.includes('Business date'));
  assert(!result.suggestion);
  const row=db.prepare("SELECT * FROM assistant_log WHERE agent='owner_briefing'").get();
  assert(row&&row.status==='accepted');
});

test('demand assistant forecasts from recorded sales with measured error',async()=>{
  const {db,ctx}=fixture();
  const empty=await runAssistant(db,ctx,'demand_assistant',{window:7,horizon:3});
  assert(empty.facts[0].value.includes('history'),empty.facts[0].value);
  for(const qty of [2,4,6])createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_1',idempotencyKey:`demand-key-${qty}`,lines:[{itemId:'burger_outlet_downtown',quantity:qty}]});
  const dates=['2026-05-01','2026-05-02','2026-05-03'];
  db.prepare('SELECT id FROM orders ORDER BY created_at LIMIT 3').all().forEach((o,i)=>db.prepare('UPDATE orders SET business_date=? WHERE id=?').run(dates[i],o.id));
  const result=await runAssistant(db,ctx,'demand_assistant',{itemId:'burger_outlet_downtown',window:2,horizon:1});
  assert.equal(result.requiresApproval,true);
  assert.equal(result.draft.quantity,5);
  assert(result.draft.ingredients.length>0,'production plan explodes the menu recipe');
  assert(result.facts.some(f=>f.label.startsWith('Backtest error')&&f.value.includes('3')),'backtest MAE reflects the 2-window vs actual difference');
  assert(result.facts.some(f=>f.label==='Backtest MAPE'));
});

test('purchasing assistant suggests orders from usage, reorder levels and packs, but raises nothing',async()=>{
  const {db,ctx}=fixture();
  const before=db.prepare("SELECT COUNT(*) n FROM records WHERE module='purchases'").get().n;
  const result=await runAssistant(db,ctx,'purchasing_assistant',{leadDays:2,coverDays:2});
  assert.equal(result.requiresApproval,true);
  assert(result.draft&&result.draft.lines.length>=1,'oat is below its reorder level');
  const oat=result.draft.lines.find(l=>l.name==='Oat milk');
  assert(oat&&oat.qty>0&&oat.packId,'suggestion rides the active oat supplier pack');
  const after=db.prepare("SELECT COUNT(*) n FROM records WHERE module='purchases'").get().n;
  assert.equal(after,before,'the assistant never creates a purchase order');
  assert(result.control.includes('Approval before ordering'));
});

test('menu-cost assistant flags contribution risk and never changes a price',async()=>{
  const {db,ctx}=fixture();
  const priceBefore=db.prepare("SELECT price FROM menu WHERE id='burger_outlet_downtown'").get().price;
  db.prepare("UPDATE ingredients SET unit_cost=100 WHERE id='beef'").run(); // burger recipe cost jumps above its price
  const result=await runAssistant(db,ctx,'menu_cost_assistant');
  assert.equal(result.requiresApproval,false);
  assert(result.facts.some(f=>f.label==='Contribution-risk items (margin < 15%)'&&f.value!=='0'));
  assert(result.facts.some(f=>f.label==='The house burger'),'burger turns contribution-negative and is flagged');
  const priceAfter=db.prepare("SELECT price FROM menu WHERE id='burger_outlet_downtown'").get().price;
  assert.equal(priceAfter,priceBefore,'no autonomous price change');
  assert(!result.draft);
});

test('reconciliation assistant surfaces payout variances and draft bills for the accountant',async()=>{
  const {db,ctx}=fixture();
  rec(db,'settlements','stl_var','unmatched',{name:'STL-1',channel:'Talabat',gross:500000,refunds:0,discounts:0,commission:50000,adjustments:0,payout:430000});
  rec(db,'settlements','stl_ok','unmatched',{name:'STL-2',channel:'Deliveroo',gross:200000,refunds:0,discounts:0,commission:20000,adjustments:0,payout:180000});
  rec(db,'bills','bill_draft1','draft',{name:'FB-2026-11',supplierId:'supplier_green',amount:120000,tax:6000,dueDate:'2026-06-01',notes:'awaiting match'});
  const result=await runAssistant(db,ctx,'reconciliation_assistant');
  assert.equal(result.requiresApproval,true);
  const variance=result.draft.settlements.find(s=>s.id==='stl_var');
  assert(variance&&variance.variance===-20000,'STL-1 expected 450000 vs payout 430000');
  assert(!result.draft.settlements.some(s=>s.id==='stl_ok'),'clean settlement is not an exception');
  assert(result.facts.some(f=>f.label==='Draft supplier bills awaiting matching'&&f.value==='1'));
});

test('customer assistant answers from approved data and escalates allergen questions',async()=>{
  const {db,ctx}=fixture();
  const price=await askCustomerAssistant(db,ctx,{question:'how much is the burger?'});
  assert.equal(price.escalated,false);assert(price.answer.includes('AED 42.00'),price.answer);assert.equal(price.quoted,true);
  const soldOut=await askCustomerAssistant(db,ctx,{question:'is everything in stock?'});
  assert(soldOut.answer.includes('available'));
  const allergen=await askCustomerAssistant(db,ctx,{question:'does the flat white contain milk allergens?'});
  assert.equal(allergen.escalated,true);
  assert(allergen.answer.includes('kitchen'),'escalation hands off to a person');
  const cashier=fixture('user_cashier');
  const asCashier=await askCustomerAssistant(cashier.db,cashier.ctx,{question:'price of the lemonade?'});
  assert(asCashier.answer.includes('AED 20.00'));
});

test('communication drafter produces a draft that never leaves the outbox',async()=>{
  const {db,ctx}=fixture();
  rec(db,'customers','c_grant','active',{name:'Granted Guest',consent:'granted',phone:'+971500000001'});
  rec(db,'customers','c_wit','active',{name:'Withdrawn Guest',consent:'withdrawn',phone:'+971500000002'});
  const result=await draftCommunication(db,ctx,{topic:'Weekend brunch reservations are open',tone:'friendly'});
  assert.equal(result.requiresApproval,true);assert.equal(result.posted,false);
  assert(result.draft.message.includes('brunch')||result.draft.message.includes('Weekend'),result.draft.message);
  assert.equal(Number(result.facts.find(f=>f.label==='Marketing consent granted').value),2);
  assert.equal(Number(result.facts.find(f=>f.label==='Active customers').value),4,'2 seeded + 2 added customers');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM message_log').get().n,0,'no message is queued or sent by the drafter');
  const row=db.prepare("SELECT * FROM assistant_log WHERE agent='communication_drafter'").get();
  assert(row&&row.status==='draft');
});

test('kitchen exception assistant reports overdue tickets from recorded state and stays read-only',async()=>{
  const {db,ctx}=fixture();
  const order=createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_1',idempotencyKey:'kitchen-key-001',lines:[{itemId:'burger_outlet_downtown',quantity:1}]});
  const taskId=order.tasks[0].id;
  db.prepare("UPDATE tasks SET status='preparing',started_at=? WHERE id=?").run(new Date(Date.now()-40*60000).toISOString(),taskId);
  const result=await runAssistant(db,ctx,'kitchen_exception_assistant');
  assert.equal(result.requiresApproval,false);
  const overdue=result.facts.find(f=>f.label==='Overdue tickets');
  assert(overdue&&overdue.value!=='0',JSON.stringify(result.facts));
  assert(result.facts.some(f=>f.label.includes('#')&&f.value.includes('overdue by 28 min')),'40 min started, 12 min prep');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,'preparing','the assistant cannot change preparation status');
  assert(!db.prepare('SELECT 1 FROM tasks WHERE id=? AND ready_at IS NOT NULL').get(taskId));
});

test('wastage assistant isolates waste patterns and leaves safety decisions to people',async()=>{
  const {db,ctx}=fixture();
  db.prepare('INSERT INTO movements VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id('mov'),ctx.tenantId,ctx.outletId,'beef','lot_beef_outlet_downtown',-200,'waste','agent_test',ctx.user.id,'expiry',now());
  const result=await runAssistant(db,ctx,'wastage_assistant');
  assert.equal(result.requiresApproval,true);
  assert(result.facts.some(f=>f.label==='Reason: expiry'&&f.value.includes('200')));
  assert(result.draft&&result.draft.note.includes('human'),'investigation note keeps decisions human');
  assert(result.facts.some(f=>f.label==='Stock expiring within 7 days'&&f.value!=='none'),'demo lots expire inside the window');
  assert(result.facts.some(f=>f.label==='Quarantined stock'));
});

test('role guardrails block assistants outside a role',async()=>{
  const chef=fixture('user_chef');
  await assert.rejects(()=>runAssistant(chef.db,chef.ctx,'owner_briefing'),e=>e.status===403&&e.message.includes('outside your role'));
  const kitchen=await runAssistant(chef.db,chef.ctx,'kitchen_exception_assistant');
  assert(kitchen.facts.length>0);assert.equal(kitchen.requiresApproval,false);
  plusUser(chef.db,'user_purchasing','purchasing');
  const purchasing={db:chef.db,ctx:{...chef.ctx,user:chef.db.prepare("SELECT * FROM users WHERE id='user_purchasing'").get()}};
  purchasing.ctx.user.outlet_ids=JSON.parse(purchasing.ctx.user.outlet_ids);
  const purchase=await runAssistant(purchasing.db,purchasing.ctx,'purchasing_assistant');
  assert(purchase.draft&&purchase.control.includes('Approval before ordering'));
  await assert.rejects(()=>runAssistant(purchasing.db,purchasing.ctx,'reconciliation_assistant'),e=>e.status===403);
});

test('an optional AI provider is mounted via environment and output is labelled a draft',async()=>{
  const {db,ctx}=fixture();
  process.env.AI_PROVIDER='mock';process.env.AI_MODEL='mock-x';
  try{
    const result=await runAssistant(db,ctx,'owner_briefing');
    assert.equal(result.provider.connected,true);assert.equal(result.provider.model,'mock-x');
    assert(result.suggestion&&result.suggestion.includes('mock provider'));
    assert.equal(result.requiresApproval,false);
  }finally{delete process.env.AI_PROVIDER;delete process.env.AI_MODEL;}
  // The LLM JSON path is exercised hermeticly with a stubbed transport.
  process.env.AI_PROVIDER='mock';
  setChatTransport(async()=>'{"supplier":"Fake Fresh Co","invoiceNumber":"CUSTOM-JSON-7","invoiceDate":"2026-06-01","net":950,"tax":50,"total":1000,"currency":"AED","lineItems":[{"description":"Beef 5kg","quantity":1,"amount":600}],"notes":""}');
  try{
    const doc=await intakeDocument(db,ctx,{text:'INVOICE INV-999\nSome supplier\nTotal 100 AED'});
    assert.equal(doc.method,'ai');
    assert.equal(doc.extracted.aiFields.invoiceNumber,'CUSTOM-JSON-7');
    assert.equal(doc.posted,false);
  }finally{
    setChatTransport(null);delete process.env.AI_PROVIDER;
  }
  const after=await runAssistant(db,ctx,'owner_briefing');
  assert.equal(after.provider.connected,false);
});

test('assistant drafts are tracked and can be accepted or dismissed by owners',async()=>{
  const {db,ctx}=fixture();
  await runAssistant(db,ctx,'purchasing_assistant');
  const draft=aiActivity(db,ctx).find(r=>r.agent==='purchasing_assistant'&&r.status==='draft');
  assert(draft);
  const accepted=setActivityStatus(db,ctx,draft.id,{status:'accepted'});
  assert.equal(accepted.status,'accepted');
  assert.equal(aiActivity(db,ctx).find(r=>r.id===draft.id).status,'accepted');
  await assert.rejects(async()=>setActivityStatus(db,ctx,draft.id,{status:'dismissed'}),e=>e.status===409);
  const cashier=fixture('user_cashier');
  await assert.rejects(async()=>setActivityStatus(cashier.db,cashier.ctx,draft.id,{status:'dismissed'}),e=>e.status===403);
});

test('document intake extracts deterministic fields and never posts',async()=>{
  const {db,ctx}=fixture();
  const out=await intakeDocument(db,ctx,{text:'INVOICE INV-2026-001\nGreen Valley Fresh\nDate 12-05-2026\n6 line items\nTotal 1,234.56 AED\nVAT 58.78'});
  assert.equal(out.posted,false);assert.equal(out.extracted.invoiceNumber,'INV-2026-001');
  assert.equal(out.extracted.invoiceDate,'2026-05-12');assert.equal(out.method,'deterministic');
  assert.equal(out.extracted.total,1234.56);assert.equal(out.extracted.currency,'AED');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE module='bills'").get().n,0,'no bill record is created by intake');
});

test('AI endpoints respond over HTTP with role gating',async()=>{
  const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);
  const app=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');
  await new Promise(resolve=>app.once('listening',resolve));
  const port=app.address().port;const base=`http://127.0.0.1:${port}`;
  const signIn=async role=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})});const session=await res.json();const cookie=res.headers.get('set-cookie').split(';')[0];return {headers:{'cookie':cookie,'content-type':'application/json','x-csrf-token':session.csrf,'x-outlet-id':'outlet_downtown'}};};
  const call=async(session,path,options={})=>{const res=await fetch(base+path,{...options,headers:{...session.headers,...(options.headers||{})}});return {status:res.status,body:await res.json()};};
  try{
    const owner=await signIn('owner');
    const status=await call(owner,'/api/ai/status');
    assert.equal(status.status,200);assert.equal(status.body.agents.length,10);assert.equal(status.body.provider.connected,false);
    const run=await call(owner,'/api/ai/agents/owner_briefing/run',{method:'POST',body:JSON.stringify({})});
    assert.equal(run.status,200);assert(run.body.facts.length);assert.equal(run.body.agent,'owner_briefing');
    const cash=await signIn('cashier');
    const denied=await call(cash,'/api/ai/agents/owner_briefing/run',{method:'POST',body:JSON.stringify({})});
    assert.equal(denied.status,403);
    const activity=await call(owner,'/api/ai/activity');
    assert.equal(activity.status,200);assert(activity.body.length>=1);
    const doc=await call(owner,'/api/ai/documents/intake',{method:'POST',body:JSON.stringify({text:'INVOICE 77\nAED total 500.00\nBetter Supply'})});
    assert.equal(doc.status,200);assert.equal(doc.body.extracted.invoiceNumber,'77');
  }finally{
    app.close();
  }
});

test('unknown assistants and invalid intents are rejected',async()=>{
  const {db,ctx}=fixture();
  await assert.rejects(()=>runAssistant(db,ctx,'not_an_agent'),e=>e.status===404);
  await assert.rejects(()=>runAssistant(db,ctx,'document_intake',{}),e=>e.status===409);
  await assert.rejects(()=>intakeDocument(db,ctx,{text:'short'}),zod);
  await assert.rejects(()=>draftCommunication(db,ctx,{topic:'x'}),zod);
});