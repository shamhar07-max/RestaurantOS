import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { createOrder,taskAction,orderAction,pay,refund,createRecord,recordAction,inventory,holdLot,orderDetail } from '../server/domain.mjs';
import { createApp } from '../server/app.mjs';
import { splitBill,transferTable,disposeLot } from '../server/service.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const role=(ctx,name)=>({...ctx,user:{...ctx.user,id:`user_${name}`,role:name,outlet_ids:['outlet_downtown']}});
const input=(lines=[{itemId:'burger_outlet_downtown',quantity:1}])=>({service:'takeaway',channel:'POS',idempotencyKey:randomUUID(),lines});
const stock=(db,ctx,key)=>inventory(db,ctx).find(i=>i.id===key);
const advance=(db,ctx,r,action,extras={})=>recordAction(db,ctx,r.id,{action,version:r.version,reason:'Test approved evidence',evidence:'Signed test evidence',...extras});

test('bill allocations are exact and immutable; table transfers stay within the outlet',()=>{
  const {db,ctx}=fixture();const o=createOrder(db,ctx,{...input(),service:'dine_in',tableId:'table_outlet_downtown_1'});
  assert.throws(()=>splitBill(db,ctx,o.id,{parts:[{name:'A',amount:2000},{name:'B',amount:2000}],reason:'Guest request'}),/exact original total/);
  splitBill(db,ctx,o.id,{parts:[{name:'A',amount:2100},{name:'B',amount:2100}],reason:'Guest request'});
  assert.throws(()=>splitBill(db,ctx,o.id,{parts:[{name:'A',amount:2100},{name:'B',amount:2100}],reason:'Guest request'}),/immutable/);
  assert.throws(()=>transferTable(db,ctx,o.id,{tableId:'table_outlet_marina_1',reason:'Guest request'}),/not found/);
  assert.equal(transferTable(db,ctx,o.id,{tableId:'table_outlet_downtown_2',reason:'Guest request'}).table_id,'table_outlet_downtown_2');db.close();
});
test('disposal blocks reserved food and unauthorised users',()=>{
  const {db,ctx}=fixture();const o=createOrder(db,ctx,input());const body={quantity:1,reason:'Approved disposal'};
  assert.throws(()=>disposeLot(db,ctx,'lot_beef_outlet_downtown',body),/reserved/);
  assert.throws(()=>disposeLot(db,role(ctx,'cashier'),'lot_beef_outlet_downtown',body),error=>error.status===403);
  orderAction(db,ctx,o.id,{action:'cancel',reason:'Release before disposal'});
  const before=stock(db,ctx,'beef').on_hand;disposeLot(db,role(ctx,'safety'),'lot_beef_outlet_downtown',body);assert.equal(stock(db,ctx,'beef').on_hand,before-1);db.close();
});
test('closed business date prevents acceptance and rolls back its stock reservations',()=>{
  const {db,ctx}=fixture();db.prepare('INSERT INTO periods VALUES(?,?,?,?,?,?,?)').run(ctx.tenantId,ctx.outletId,businessDate(),'closed','Approved close',ctx.user.id,new Date().toISOString());
  assert.throws(()=>createOrder(db,ctx,input()),/financially closed/);assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);assert.equal(stock(db,ctx,'beef').reserved,0);db.close();
});
test('required modifier groups reject missing or excessive choices before stock is reserved',()=>{
  const {db,ctx}=fixture();const options=JSON.parse(db.prepare("SELECT modifiers FROM menu WHERE id='burger_outlet_downtown'").get().modifiers);options[0].group={id:'choice',name:'Choice',min:1,max:1};db.prepare("UPDATE menu SET modifiers=? WHERE id='burger_outlet_downtown'").run(JSON.stringify(options));
  assert.throws(()=>createOrder(db,ctx,input()),/choose 1 to 1/);assert.equal(stock(db,ctx,'beef').reserved,0);
  assert.equal(createOrder(db,ctx,input([{itemId:'burger_outlet_downtown',quantity:1,modifierIds:[options[0].id]}])).total,4700);db.close();
});

test('modifier snapshots route to correct stations; one ready station does not finish the order',()=>{
  const {db,ctx}=fixture();const o=createOrder(db,ctx,input([{itemId:'burger_outlet_downtown',quantity:1,modifierIds:['cheese']},{itemId:'latte_outlet_downtown',quantity:1,modifierIds:['oat']}]));
  assert.equal(o.total,7300);assert.deepEqual(o.tasks.map(t=>t.station).sort(),['drinks','grill']);assert.equal(o.lines.find(l=>l.name==='Flat white').recipe.some(r=>r.ingredientId==='milk'),false);assert.equal(o.lines[0].modifiers[0].name,'Add cheddar');
  taskAction(db,ctx,o.tasks[0].id,{action:'start'});let updated=taskAction(db,ctx,o.tasks[0].id,{action:'ready'});assert.equal(updated.status,'preparing');
  taskAction(db,ctx,o.tasks[1].id,{action:'start'});updated=taskAction(db,ctx,o.tasks[1].id,{action:'ready'});assert.equal(updated.status,'ready');db.close();
});
test('stock reservations prevent overselling and failed acceptance rolls back all postings',()=>{
  const {db,ctx}=fixture();const before=stock(db,ctx,'bun').on_hand;
  assert.throws(()=>createOrder(db,ctx,input([{itemId:'burger_outlet_downtown',quantity:40}])),/Insufficient/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM journals').get().n,0);assert.equal(stock(db,ctx,'bun').on_hand,before);db.close();
});
test('cancellation before preparation releases reservations without consuming food',()=>{
  const {db,ctx}=fixture();const before=stock(db,ctx,'beef');const o=createOrder(db,ctx,input());assert.equal(stock(db,ctx,'beef').available,before.available-180);
  orderAction(db,ctx,o.id,{action:'cancel',reason:'Guest changed plans'});assert.equal(stock(db,ctx,'beef').on_hand,before.on_hand);assert.equal(stock(db,ctx,'beef').reserved,0);db.close();
});
test('cancellation after preparation preserves consumption and records loss evidence',()=>{
  const {db,ctx}=fixture();const before=stock(db,ctx,'beef').on_hand;const o=createOrder(db,ctx,input());taskAction(db,ctx,o.tasks[0].id,{action:'start'});orderAction(db,ctx,o.id,{action:'cancel',reason:'Customer left after cooking'});
  assert.equal(stock(db,ctx,'beef').on_hand,before-180);assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE action='wastage.prepared_cancellation'").get().n,1);db.close();
});
test('remake consumes an additional portion; repeated preparation is blocked',()=>{
  const {db,ctx}=fixture();const before=stock(db,ctx,'beef').on_hand;const o=createOrder(db,ctx,input());taskAction(db,ctx,o.tasks[0].id,{action:'start'});assert.throws(()=>taskAction(db,ctx,o.tasks[0].id,{action:'start'}),/queued/);orderAction(db,ctx,o.id,{action:'remake',lineId:o.lines[0].id,reason:'Approved overcooked remake'});assert.equal(stock(db,ctx,'beef').on_hand,before-360);db.close();
});
test('partial original-tender refund affects only money and is idempotent',()=>{
  const {db,ctx}=fixture();const o=createOrder(db,ctx,input());taskAction(db,ctx,o.tasks[0].id,{action:'start'});const paid=pay(db,ctx,o.id,{amount:o.total,method:'cash',idempotencyKey:randomUUID()});const before=stock(db,ctx,'beef').on_hand;const body={paymentId:paid.payments[0].id,amount:1000,reason:'Approved service recovery',idempotencyKey:randomUUID()};refund(db,ctx,o.id,body);const updated=refund(db,ctx,o.id,body);assert.equal(updated.refunded,1000);assert.equal(updated.refunds.length,1);assert.equal(stock(db,ctx,'beef').on_hand,before);assert.throws(()=>refund(db,ctx,o.id,{...body,amount:4000,idempotencyKey:randomUUID()}),/exceeds/);db.close();
});
test('split tenders sum to the bill and prevent overpayment and duplicate charging',()=>{
  const {db,ctx}=fixture();const o=createOrder(db,ctx,input());const p={amount:2000,method:'cash',idempotencyKey:randomUUID()};pay(db,ctx,o.id,p);let updated=pay(db,ctx,o.id,p);assert.equal(updated.paid,2000);assert.equal(updated.due,2200);updated=pay(db,ctx,o.id,{amount:2200,method:'cash',idempotencyKey:randomUUID()});assert.equal(updated.paymentStatus,'paid');assert.throws(()=>pay(db,ctx,o.id,{amount:1,method:'cash',idempotencyKey:randomUUID()}),/exceeds/);db.close();
});
test('duplicate channel event produces one order, reservation set and sale origin',()=>{
  const {db,ctx}=fixture();const payload={...input(),channel:'Talabat'};const a=createOrder(db,ctx,payload),b=createOrder(db,ctx,payload);assert.equal(a.id,b.id);assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM journals WHERE type='sale'").get().n,1);db.close();
});
test('unknown channel item is rejected without partial postings',()=>{const {db,ctx}=fixture();assert.throws(()=>createOrder(db,ctx,input([{itemId:'external-unmapped',quantity:1}])),/not mapped/);assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);db.close();});
test('partial supplier receiving preserves balance and stale replay cannot add more stock',()=>{
  const {db,ctx}=fixture();let r=createRecord(db,ctx,'purchases',{name:'PO-Test',supplierId:'supplier_green',ingredientId:'oat',quantity:1000,unitCost:2,deliveryDate:businessDate()});r=advance(db,ctx,r,'approved');const before=stock(db,ctx,'oat').on_hand,version=r.version;
  r=advance(db,ctx,r,'receive',{quantity:400,expiry:'2099-01-01',lotCode:'SUP-1'});assert.equal(r.status,'part_received');assert.equal(r.data.received,400);assert.equal(stock(db,ctx,'oat').on_hand,before+400);assert.throws(()=>recordAction(db,ctx,r.id,{action:'receive',version,quantity:400,expiry:'2099-01-01',lotCode:'SUP-1',evidence:'Replay'}),/changed/);
  r=advance(db,ctx,r,'receive',{quantity:600,expiry:'2099-01-01',lotCode:'SUP-2'});assert.equal(r.status,'received');assert.equal(r.data.received,1000);db.close();
});
test('batch issues raw input once; subsequent sale consumes prepared component only',()=>{
  const {db,ctx}=fixture();let batch=createRecord(db,ctx,'batches',{name:'SAUCE-TEST',inputId:'tomato',inputQuantity:500,outputId:'sauce',outputQuantity:400,expiry:'2099-01-01',notes:'Approved test recipe'});const tomatoBefore=stock(db,ctx,'tomato').on_hand,sauceBefore=stock(db,ctx,'sauce').on_hand;
  batch=advance(db,ctx,batch,'executing');batch=advance(db,ctx,batch,'quality_hold');batch=advance(db,ctx,batch,'released',{quantity:400});assert.equal(stock(db,ctx,'tomato').on_hand,tomatoBefore-500);assert.equal(stock(db,ctx,'sauce').on_hand,sauceBefore+400);const o=createOrder(db,ctx,input());taskAction(db,ctx,o.tasks[0].id,{action:'start'});assert.equal(stock(db,ctx,'tomato').on_hand,tomatoBefore-500);assert.equal(stock(db,ctx,'sauce').on_hand,sauceBefore+370);db.close();
});
test('expired and quarantined lots cannot be allocated or released by cashier',()=>{
  const {db,ctx}=fixture();const lot='lot_beef_outlet_downtown';holdLot(db,ctx,lot,{status:'quarantined',reason:'Supplier recall'});assert.throws(()=>createOrder(db,ctx,input()),/Insufficient/);assert.throws(()=>holdLot(db,role(ctx,'cashier'),lot,{status:'available',reason:'Override hold'}),/permit|Only/);db.prepare("UPDATE lots SET expiry='2000-01-01' WHERE id=?").run(lot);assert.throws(()=>holdLot(db,ctx,lot,{status:'available',reason:'Safety review'}),/Expired/);db.close();
});
test('quarantining a reserved lot blocks later preparation and prevents stock consumption',()=>{const {db,ctx}=fixture();const o=createOrder(db,ctx,input());holdLot(db,ctx,'lot_beef_outlet_downtown',{status:'quarantined',reason:'Recall after acceptance'});assert.throws(()=>taskAction(db,ctx,o.tasks[0].id,{action:'start'}),/held/);assert.equal(db.prepare('SELECT consumed FROM order_lines WHERE id=?').get(o.lines[0].id).consumed,0);db.close();});
test('till shortage appears in closing evidence',()=>{
  const {db,ctx}=fixture();let till=createRecord(db,ctx,'tills',{name:'TILL-A',opening:10000});const o=createOrder(db,ctx,input());pay(db,ctx,o.id,{amount:4200,method:'cash',tillId:till.id,idempotencyKey:randomUUID()});till=advance(db,ctx,till,'closed',{counted:14000});assert.equal(till.data.expected,14200);assert.equal(till.data.variance,-200);assert.throws(()=>pay(db,ctx,createOrder(db,ctx,input()).id,{amount:100,method:'cash',tillId:till.id,idempotencyKey:randomUUID()}),/open till/);db.close();
});
test('marketplace settlement reconciles gross, fees, refunds and payout independently',()=>{
  const {db,ctx}=fixture();let r=createRecord(db,ctx,'settlements',{name:'PAYOUT-TEST',channel:'Talabat',gross:10500,refunds:0,discounts:0,commission:2625,adjustments:0,payout:7875,notes:'Test provider statement'});assert.equal(r.data.variance,0);r=advance(db,ctx,r,'reconciled');assert.equal(r.status,'reconciled');const mismatch=createRecord(db,ctx,'settlements',{name:'BAD',channel:'Direct',gross:10000,payout:9000,notes:'Mismatched statement'});assert.throws(()=>advance(db,ctx,mismatch,'reconciled'),/variance/);db.close();
});
test('reservations reject overlapping times and capacity violations',()=>{
  const {db,ctx}=fixture();const b={name:'Guest',tableId:'table_outlet_downtown_1',partySize:4,startsAt:'2099-01-01T12:00',endsAt:'2099-01-01T13:00'};createRecord(db,ctx,'reservations',b);assert.throws(()=>createRecord(db,ctx,'reservations',{...b,name:'Other',startsAt:'2099-01-01T12:30'}),/already reserved/);assert.throws(()=>createRecord(db,ctx,'reservations',{...b,partySize:8}),/capacity/);createRecord(db,ctx,'reservations',{...b,startsAt:'2099-01-01T13:00',endsAt:'2099-01-01T14:00'});db.close();
});
test('stock in transit is not usable at either branch; receiving preserves source expiry',()=>{
  const {db,ctx}=fixture();let r=createRecord(db,ctx,'transfers',{name:'TR-TEST',ingredientId:'beef',quantity:500,destinationId:'outlet_marina'});const sourceBefore=stock(db,ctx,'beef').on_hand,dest={...ctx,outletId:'outlet_marina'},destBefore=stock(db,dest,'beef').on_hand,sourceExpiry=db.prepare('SELECT expiry FROM lots WHERE id=?').get('lot_beef_outlet_downtown').expiry;
  r=advance(db,ctx,r,'in_transit');assert.equal(stock(db,ctx,'beef').on_hand,sourceBefore-500);assert.equal(stock(db,dest,'beef').on_hand,destBefore);r=advance(db,ctx,r,'received',{expiry:'2099-01-01'});assert.equal(stock(db,dest,'beef').on_hand,destBefore+500);assert.equal(db.prepare('SELECT expiry FROM lots WHERE origin=?').get(r.id).expiry,sourceExpiry);db.close();
});
test('472 accepted-meal illustration and fixed-person contracts produce different immutable invoices',()=>{
  const {db,ctx}=fixture();const base={name:'Contract',payer:'Company',site:'Site A',rate:1200,minimum:0,eligible:470,accepted:472,served:465,mealType:'lunch',startDate:businessDate(),endDate:'2099-01-01',notes:'Client approved terms'};
  let a=createRecord(db,ctx,'contracts',{...base,billingBasis:'accepted_meal'});a=advance(db,ctx,a,'approved');a=advance(db,ctx,a,'period_closed');assert.equal(a.data.invoice.net,566400);assert.equal(a.data.invoice.tax,28320);assert.equal(a.data.invoice.total,594720);
  let b=createRecord(db,ctx,'contracts',{...base,billingBasis:'fixed_person'});b=advance(db,ctx,b,'approved');b=advance(db,ctx,b,'period_closed');assert.equal(b.data.invoice.net,564000);assert.throws(()=>advance(db,ctx,a,'approved'),/Cannot/);db.close();
});
test('subscription entitlement, pause and cancellation remain distinct from payment',()=>{
  const {db,ctx}=fixture();let r=createRecord(db,ctx,'subscriptions',{name:'Subscriber',plan:'Test plan',entitlements:1,mealPrice:3000,address:'Site',days:'Monday',cutoff:'Prior day'});r=advance(db,ctx,r,'paused');assert.throws(()=>advance(db,ctx,r,'fulfil'),/active/);r=advance(db,ctx,r,'active');r=advance(db,ctx,r,'fulfil');assert.equal(r.data.used,1);assert.throws(()=>advance(db,ctx,r,'fulfil'),/entitlement/);db.close();
});
test('safety deviation creates an owned action; ordinary manager cannot close it',()=>{const {db,ctx}=fixture();const check=createRecord(db,ctx,'safety',{name:'Storage test',procedure:'APPROVED-1',type:'temperature',reading:'Test failed value',criterion:'Approved criterion',result:'deviation',responsible:'Noor'});assert.ok(check.data.incidentId);const incident=db.prepare('SELECT * FROM records WHERE id=?').get(check.data.incidentId);assert.equal(incident.status,'open');assert.throws(()=>recordAction(db,role(ctx,'manager'),check.id,{action:'reviewed',version:1,evidence:'Test review'}),/responsible/);db.close();});
test('menu changes preserve original order price and recipe version',()=>{const {db,ctx}=fixture();const o=createOrder(db,ctx,input());db.prepare("UPDATE menu SET price=6000,version=version+1,recipe='[]' WHERE id='burger_outlet_downtown'").run();const old=orderDetail(db,ctx,o.id);assert.equal(old.total,4200);assert.equal(old.lines[0].recipe_version,1);assert.ok(old.lines[0].recipe.length);db.close();});
test('every journal balances across sale, receipt, refund and cancellation scenarios',()=>{const {db,ctx}=fixture();const o=createOrder(db,ctx,input());const p=pay(db,ctx,o.id,{amount:4200,method:'cash',idempotencyKey:randomUUID()});orderAction(db,ctx,o.id,{action:'cancel',reason:'Approved cancellation'});refund(db,ctx,o.id,{amount:4200,paymentId:p.payments[0].id,reason:'Return original tender',idempotencyKey:randomUUID()});const imbalances=db.prepare('SELECT journal_id,SUM(debit-credit) net FROM journal_lines GROUP BY journal_id HAVING net!=0').all();assert.deepEqual(imbalances,[]);assert.equal(db.prepare('SELECT SUM(debit-credit) net FROM journal_lines').get().net,0);db.close();});
test('backup restore retains stock, orders, financial origins and audit evidence',async()=>{
  const {db,ctx}=fixture();const o=createOrder(db,ctx,input());taskAction(db,ctx,o.tasks[0].id,{action:'start'});const content=Buffer.from('Signed delivery evidence');const digest=createHash('sha256').update(content).digest('hex');db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?)').run('backup_file',ctx.tenantId,ctx.outletId,o.id,'evidence.txt','text/plain',digest,content,ctx.user.id,new Date().toISOString());const dir=mkdtempSync(join(tmpdir(),'restaurant-backup-'));try{const path=join(dir,'restored.sqlite');await backup(db,path);const restored=openDatabase(path);assert.equal(orderDetail(restored,ctx,o.id).total,o.total);assert.equal(stock(restored,ctx,'beef').on_hand,stock(db,ctx,'beef').on_hand);assert.equal(restored.prepare('SELECT COUNT(*) n FROM journals').get().n,db.prepare('SELECT COUNT(*) n FROM journals').get().n);const file=restored.prepare("SELECT * FROM attachments WHERE id='backup_file'").get();assert.equal(Buffer.from(file.content).toString(),content.toString());assert.equal(createHash('sha256').update(file.content).digest('hex'),file.sha256);assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');restored.close();}finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('HTTP permissions reject cross-outlet, cross-tenant, salary export and CSRF access',async()=>{
  const {db,ctx}=fixture();const order=createOrder(db,ctx,input());db.prepare("INSERT INTO tenants VALUES('tenant_other','Other operator')").run();db.prepare("INSERT INTO entities VALUES('entity_other','tenant_other','Other entity','')").run();db.prepare("INSERT INTO outlets(id,tenant_id,entity_id,name,brand,format) VALUES('outlet_other','tenant_other','entity_other','Other outlet','Other','dine_in')").run();
  const server=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'cashier'})});const cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json();const headers={'cookie':cookie,'content-type':'application/json','x-csrf-token':session.csrf};
  try {
    assert.equal((await fetch(base+'/api/orders',{headers:{...headers,'x-outlet-id':'outlet_marina'}})).status,403);
    assert.equal((await fetch(base+'/api/orders',{headers:{...headers,'x-outlet-id':'outlet_other'}})).status,403);
    assert.equal((await fetch(base+'/api/records/payroll',{headers})).status,403);
    assert.equal((await fetch(base+'/api/export/journal',{headers})).status,403);
    assert.equal((await fetch(base+`/api/orders/${order.id}/refunds`,{method:'POST',headers,body:JSON.stringify({})})).status,403);
    assert.equal((await fetch(base+'/api/orders',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(input())})).status,403);
    assert.equal((await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json','origin':'https://untrusted.example'},body:'{}'})).status,403);
    const anonymous=await fetch(base+'/api/orders');assert.equal(anonymous.status,401);
    const summary=await (await fetch(base+'/api/summary',{headers})).json();assert.equal(summary.contribution,null);
  }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});
