import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { recordAction } from '../server/domain.mjs';
import { createPurchaseOrder,purchaseOrder,purchaseOrders,receivePurchaseOrder,purchaseOrderMatch,setReceiptQuality,receiptQuality } from '../server/purchasing-ext.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const tomorrow=()=>new Date(Date.now()+86400000).toISOString().slice(0,10);

test('CORE-02 a multi-line purchase order receives per line, rejects with evidence and matches its invoice',()=>{
  const {db,ctx}=fixture();
  const po=createPurchaseOrder(db,ctx,{name:'Weekly produce',supplierId:'supplier_green',deliveryDate:businessDate(),notes:'Split delivery',lines:[{ingredientId:'lettuce',quantity:1000,unitCost:1},{ingredientId:'tomato',quantity:2000,unitCost:1}]});
  assert.equal(po.status,'requested');assert.equal(po.lines.length,2);assert.equal(po.orderedValue,3000);
  recordAction(db,ctx,po.id,{action:'approved',version:po.version,reason:'Approved order'});
  setReceiptQuality(db,ctx,{required:['temperature','packaging'],evidence:'QA reviewed receiving checks'});
  assert.deepEqual(receiptQuality(db,ctx).required,['temperature','packaging']);
  let current=purchaseOrder(db,ctx,po.id),lines=current.lines;
  assert.throws(()=>receivePurchaseOrder(db,ctx,po.id,{version:current.version,evidence:'Arrival',lines:[{lineId:lines[0].id,accepted:1000,rejected:0,inspection:'pass',expiry:tomorrow(),lotCode:'LOT-A'}]}),/required receipt checks/);
  const partial=receivePurchaseOrder(db,ctx,po.id,{version:current.version,evidence:'Arrival note',lines:[
    {lineId:lines[0].id,accepted:600,rejected:0,inspection:'pass',expiry:tomorrow(),lotCode:'LOT-A',checks:{temperature:'pass',packaging:'pass'}},
    {lineId:lines[1].id,accepted:0,rejected:500,inspection:'fail',checks:{temperature:'pass',packaging:'fail'}},
  ]});
  assert.equal(partial.status,'part_received');assert.equal(partial.lines.find(l=>l.id===lines[0].id).received,600);assert.equal(partial.lines.find(l=>l.id===lines[1].id).rejected,500);
  current=purchaseOrder(db,ctx,po.id);lines=current.lines;
  assert.throws(()=>receivePurchaseOrder(db,ctx,po.id,{version:current.version,evidence:'Too much',lines:[{lineId:lines[0].id,accepted:900,rejected:0,inspection:'pass',expiry:tomorrow(),lotCode:'LOT-A2',checks:{temperature:'pass',packaging:'pass'}}]}),/outstanding line balance/);
  const full=receivePurchaseOrder(db,ctx,po.id,{version:current.version,evidence:'Balance arrived',lines:[
    {lineId:lines[0].id,accepted:400,rejected:0,inspection:'pass',expiry:tomorrow(),lotCode:'LOT-A2',checks:{temperature:'pass',packaging:'pass'}},
    {lineId:lines[1].id,accepted:1500,rejected:0,inspection:'pass',expiry:tomorrow(),lotCode:'LOT-B',checks:{temperature:'pass',packaging:'pass'}},
  ]});
  assert.equal(full.status,'received');assert.equal(full.receivedValue,2500);
  const lots=db.prepare("SELECT COUNT(*) n FROM lots WHERE origin=?").get(po.id).n;assert.equal(lots,3);
  const matched=purchaseOrderMatch(db,ctx,po.id,{version:full.version,invoiceReference:'SUP-9001',amount:2500,tax:0,evidence:'Three-way match'});
  assert.equal(matched.data.bill.variance,0);assert.equal(matched.data.bill.invoiceReference,'SUP-9001');
  db.close();
});

test('CORE-02 receiving requires an approved order and a supplier lot for accepted stock',()=>{
  const {db,ctx}=fixture();
  const po=createPurchaseOrder(db,ctx,{name:'Dairy run',supplierId:'supplier_prime',deliveryDate:businessDate(),notes:'Chilled',lines:[{ingredientId:'milk',quantity:500,unitCost:1}]});
  const line=purchaseOrder(db,ctx,po.id).lines[0];
  assert.throws(()=>receivePurchaseOrder(db,ctx,po.id,{version:po.version,evidence:'Early',lines:[{lineId:line.id,accepted:500,rejected:0,inspection:'pass',expiry:tomorrow(),lotCode:'M1'}]}),/Approve the purchase order/);
  recordAction(db,ctx,po.id,{action:'approved',version:po.version,reason:'Approved'});
  const current=purchaseOrder(db,ctx,po.id);
  assert.throws(()=>receivePurchaseOrder(db,ctx,po.id,{version:current.version,evidence:'No lot',lines:[{lineId:line.id,accepted:500,rejected:0,inspection:'pass',expiry:tomorrow()}]}),/Supplier lot code/);
  db.close();
});

test('CORE-02 a rejected receipt must record a non-passing inspection',()=>{
  const {db,ctx}=fixture();
  const po=createPurchaseOrder(db,ctx,{name:'Herbs',supplierId:'supplier_green',deliveryDate:businessDate(),notes:'Fresh',lines:[{ingredientId:'lettuce',quantity:300,unitCost:1}]});
  recordAction(db,ctx,po.id,{action:'approved',version:po.version,reason:'Approved'});
  const line=purchaseOrder(db,ctx,po.id).lines[0];
  assert.throws(()=>receivePurchaseOrder(db,ctx,po.id,{version:purchaseOrder(db,ctx,po.id).version,evidence:'Reject',lines:[{lineId:line.id,accepted:0,rejected:300,inspection:'pass'}]}),/A rejected quantity must record/);
  db.close();
});

test('CORE-02 the multi-line purchase order API is mounted and permission-scoped',async t=>{
  const {db}=fixture();
  const app=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');
  await new Promise(resolve=>app.once('listening',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const signIn=async role=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})});const body=await res.json();return {headers:{cookie:res.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':body.csrf,'x-outlet-id':'outlet_downtown'}};};
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));db.close();});
  const owner=await signIn('owner'),chef=await signIn('chef');
  const create=await fetch(base+'/api/purchasing/orders',{method:'POST',headers:owner.headers,body:JSON.stringify({name:'API order',supplierId:'supplier_green',deliveryDate:businessDate(),notes:'x',lines:[{ingredientId:'oat',quantity:100,unitCost:2}]})});
  assert.equal(create.status,201);const body=await create.json();assert.equal(body.lines.length,1);
  const list=await fetch(base+'/api/purchasing/orders',{headers:owner.headers});assert.equal((await list.json()).length,1);
  const denied=await fetch(base+'/api/purchasing/orders',{method:'POST',headers:chef.headers,body:JSON.stringify({name:'Nope',supplierId:'supplier_green',deliveryDate:businessDate(),notes:'x',lines:[{ingredientId:'oat',quantity:1,unitCost:1}]})});
  assert.equal(denied.status,403);
  const report=await fetch(base+'/api/purchasing/receipt-quality',{headers:owner.headers});assert.equal(report.status,200);
});

test('CORE-02 purchase orders are listed per outlet',()=>{
  const {db,ctx}=fixture();
  createPurchaseOrder(db,ctx,{name:'One',supplierId:'supplier_green',deliveryDate:businessDate(),notes:'x',lines:[{ingredientId:'oat',quantity:10,unitCost:2}]});
  createPurchaseOrder(db,ctx,{name:'Two',supplierId:'supplier_green',deliveryDate:businessDate(),notes:'y',lines:[{ingredientId:'milk',quantity:10,unitCost:1}]});
  assert.equal(purchaseOrders(db,ctx).length,2);
  db.close();
});
