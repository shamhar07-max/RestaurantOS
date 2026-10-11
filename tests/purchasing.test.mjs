import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { createRecord,recordAction,inventory,purchaseMatchPolicy } from '../server/domain.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const stock=(db,ctx,key)=>inventory(db,ctx).find(i=>i.id===key);
const advance=(db,ctx,r,action,extras={})=>recordAction(db,ctx,r.id,{action,version:r.version,reason:'Test approved evidence',evidence:'Signed test evidence',...extras});

test('purchase packs convert to base units and receipts use lot evidence',()=>{
  const {db,ctx}=fixture();
  const pack=createRecord(db,ctx,'packs',{name:'Oat milk · 12 L',supplierId:'supplier_green',ingredientId:'oat',packSize:12000,packCost:24000,notes:'Synthetic supplier pack'});
  assert.equal(pack.status,'active');assert.equal(pack.data.packSize,12000);
  let r=createRecord(db,ctx,'purchases',{name:'PO-Pack',supplierId:'supplier_green',ingredientId:'oat',packId:pack.id,packQuantity:2,deliveryDate:businessDate()});
  assert.equal(r.data.quantity,24000);assert.equal(r.data.unitCost,2);assert.equal(r.data.packName,'Oat milk · 12 L');assert.equal(r.data.packSize,12000);assert.equal(r.data.packCost,24000);assert.equal(r.data.rejected,0);
  r=advance(db,ctx,r,'approved');const before=stock(db,ctx,'oat').on_hand;
  r=advance(db,ctx,r,'receive',{quantity:24000,expiry:'2099-01-01',lotCode:'PACK-1'});
  assert.equal(r.status,'received');assert.equal(stock(db,ctx,'oat').on_hand,before+24000);assert.equal(db.prepare("SELECT quantity FROM lots WHERE origin=?").get(r.id).quantity,24000);db.close();
});

test('purchase packs are scoped to their supplier and ingredient',()=>{
  const {db,ctx}=fixture();
  const pack=createRecord(db,ctx,'packs',{name:'Beef · 5 kg',supplierId:'supplier_prime',ingredientId:'beef',packSize:5000,packCost:30000,notes:'Synthetic pack'});
  assert.throws(()=>createRecord(db,ctx,'purchases',{name:'PO-Bad',supplierId:'supplier_green',ingredientId:'beef',packId:pack.id,packQuantity:1,deliveryDate:businessDate()}),/another supplier/);
  assert.throws(()=>createRecord(db,ctx,'purchases',{name:'PO-Bad2',supplierId:'supplier_prime',ingredientId:'oat',packId:pack.id,packQuantity:1,deliveryDate:businessDate()}),/another ingredient/);
  assert.throws(()=>createRecord(db,ctx,'purchases',{name:'PO-Bad3',supplierId:'supplier_prime',ingredientId:'beef',quantity:0,unitCost:0,deliveryDate:businessDate()}),/base-unit quantity/);
  const manual=createRecord(db,ctx,'purchases',{name:'PO-Manual',supplierId:'supplier_prime',ingredientId:'beef',quantity:5000,unitCost:6,deliveryDate:businessDate()});
  assert.equal(manual.data.unitCost,6);db.close();
});

test('rejected receipts are recorded but never become usable stock',()=>{
  const {db,ctx}=fixture();let r=createRecord(db,ctx,'purchases',{name:'PO-Reject',supplierId:'supplier_green',ingredientId:'oat',quantity:1000,unitCost:2,deliveryDate:businessDate()});r=advance(db,ctx,r,'approved');
  const before=stock(db,ctx,'oat').on_hand;
  r=advance(db,ctx,r,'receive',{quantity:400,rejected:100,inspection:'fail',expiry:'2099-01-01',lotCode:'REJ-1',reason:'Damaged cartons rejected at inspection'});
  assert.equal(r.status,'part_received');assert.equal(r.data.received,400);assert.equal(r.data.rejected,100);assert.equal(r.data.lastInspection.outcome,'fail');assert.equal(stock(db,ctx,'oat').on_hand,before+400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lots WHERE origin=?").get(r.id).n,1);
  assert.equal(db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM movements WHERE type='receipt_rejected' AND origin=?").get(r.id).n,100);
  assert.throws(()=>recordAction(db,ctx,r.id,{action:'receive',version:r.version,rejected:600,inspection:'fail',evidence:'Too much'}),/exceeds/);
  r=advance(db,ctx,r,'receive',{rejected:500,inspection:'conditional',reason:'Balance rejected after re-inspection'});
  assert.equal(r.status,'received');assert.equal(r.data.rejected,600);assert.equal(stock(db,ctx,'oat').on_hand,before+400);db.close();
});

test('a rejected quantity cannot be recorded as a passing inspection',()=>{
  const {db,ctx}=fixture();let r=createRecord(db,ctx,'purchases',{name:'PO-Inspect',supplierId:'supplier_green',ingredientId:'oat',quantity:200,unitCost:2,deliveryDate:businessDate()});r=advance(db,ctx,r,'approved');
  assert.throws(()=>advance(db,ctx,r,'receive',{quantity:100,rejected:50,inspection:'pass',expiry:'2099-01-01',lotCode:'X'}),/conditional or failed/);
  assert.equal(stock(db,ctx,'oat').on_hand,650);db.close();
});

test('supplier bills match within the owner purchase tolerance and post the variance',()=>{
  const {db,ctx}=fixture();
  assert.deepEqual(purchaseMatchPolicy(db,ctx),{toleranceFils:0,tolerancePercent:0});
  let r=createRecord(db,ctx,'purchases',{name:'PO-Match',supplierId:'supplier_green',ingredientId:'oat',quantity:1000,unitCost:2,deliveryDate:businessDate()});r=advance(db,ctx,r,'approved');r=advance(db,ctx,r,'receive',{quantity:1000,expiry:'2099-01-01',lotCode:'MATCH-1'});
  let bill=createRecord(db,ctx,'bills',{name:'INV-MATCH',supplierId:'supplier_green',purchaseId:r.id,amount:2105,tax:100,dueDate:businessDate(),notes:'Invoice match evidence'});
  assert.throws(()=>advance(db,ctx,bill,'matched'),/outside the/);
  db.prepare("INSERT INTO settings VALUES(?,?,'purchaseMatch',?) ON CONFLICT(tenant_id,outlet_id,key) DO UPDATE SET value=excluded.value").run(ctx.tenantId,ctx.outletId,JSON.stringify({toleranceFils:5,tolerancePercent:0}));
  assert.deepEqual(purchaseMatchPolicy(db,ctx),{toleranceFils:5,tolerancePercent:0});
  bill=advance(db,ctx,bill,'matched',{reason:'Approved small supplier price variance'});
  assert.equal(bill.status,'matched');assert.equal(bill.data.matchVariance,5);assert.equal(bill.data.matchTolerance,5);
  assert.equal(db.prepare("SELECT COALESCE(SUM(debit-credit),0) n FROM journal_lines WHERE account='Purchase price variance'").get().n,5);
  assert.equal(db.prepare('SELECT SUM(debit-credit) n FROM journal_lines').get().n,0);db.close();
});

test('purchase tolerance policy is owner only and defaults to zero through the API',async()=>{
  const {db,ctx}=fixture();
  const server=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const signIn=async role=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})});const session=await res.json();return {cookie:res.headers.get('set-cookie').split(';')[0],headers:{'cookie':res.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'x-outlet-id':'outlet_downtown'}};};
  try {
    const owner=await signIn('owner');const settings=await (await fetch(base+'/api/settings',{headers:owner.headers})).json();assert.deepEqual(settings.purchaseMatch,{toleranceFils:0,tolerancePercent:0});
    assert.equal((await fetch(base+'/api/settings/purchase-match',{method:'POST',headers:owner.headers,body:JSON.stringify({toleranceFils:25,tolerancePercent:1,reason:'Owner approved supplier variance policy'})})).status,200);
    assert.deepEqual(purchaseMatchPolicy(db,ctx),{toleranceFils:25,tolerancePercent:1});
    const cashier=await signIn('cashier');assert.equal((await fetch(base+'/api/settings/purchase-match',{method:'POST',headers:cashier.headers,body:JSON.stringify({toleranceFils:100,tolerancePercent:5,reason:'Unauthorised widening attempt'})})).status,403);
    assert.deepEqual(purchaseMatchPolicy(db,ctx),{toleranceFils:25,tolerancePercent:1});
  } finally {await new Promise(resolve=>server.close(resolve));db.close();}
});
