import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createRecord,getRecord } from '../server/domain.mjs';
import { allocateCateringResources } from '../server/operations-ext.mjs';
import { createCateringQuote,cateringQuotes,returnCateringResource,recordCateringActual,cateringProfitability } from '../server/catering-ext.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const future=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);

test('CATER-QUOTE quotes are versioned and a revision supersedes the prior approved version',()=>{
  const {db,ctx}=fixture();
  const event=createRecord(db,ctx,'catering',{name:'Launch party',customer:'Studio Nine',date:future(10),venue:'Business Bay',guests:40,quoteAmount:300000,deposit:0,resources:'3 staff',notes:'Menu pending'});
  const v1=createCateringQuote(db,ctx,{eventId:event.id,amount:300000,notes:'Initial quote',evidence:'Emailed 1'});
  assert.equal(v1.data.version,1);assert.equal(v1.status,'approved');
  const v2=createCateringQuote(db,ctx,{eventId:event.id,amount:340000,notes:'Added canapes',evidence:'Emailed 2'});
  assert.equal(v2.data.version,2);assert.equal(v2.data.supersedes,v1.id);
  const all=cateringQuotes(db,ctx,event.id);
  assert.equal(all.length,2);
  assert.equal(all.find(q=>q.id===v1.id).status,'superseded');
  assert.equal(all.find(q=>q.id===v2.id).status,'approved');
  assert.equal(cateringQuotes(db,ctx).length,2);
  db.close();
});

test('CATER-RES equipment returns reduce the allocation and flag damage',()=>{
  const {db,ctx}=fixture();
  const event=createRecord(db,ctx,'catering',{name:'Gala',customer:'Payer',date:future(5),venue:'Hotel',guests:80,quoteAmount:500000,deposit:0,resources:'x',notes:'x'});
  const resource=createRecord(db,ctx,'catering_resources',{name:'Chafing set',type:'equipment',quantity:10,notes:'Stainless'});
  allocateCateringResources(db,ctx,event.id,{allocations:[{resourceId:resource.id,quantity:4}],reason:'Event confirmed'});
  const afterGood=returnCateringResource(db,ctx,event.id,{resourceId:resource.id,quantity:2,condition:'good',notes:'Returned clean'});
  assert.equal(afterGood.data.resourceAllocations.find(a=>a.resourceId===resource.id).quantity,2);
  const afterDamage=returnCateringResource(db,ctx,event.id,{resourceId:resource.id,quantity:2,condition:'damaged',notes:'Bent lid'});
  assert.equal(afterDamage.data.resourceAllocations.length,0);
  assert.equal(afterDamage.data.resourceReturns.filter(r=>r.condition==='damaged').length,1);
  assert.throws(()=>returnCateringResource(db,ctx,event.id,{resourceId:resource.id,quantity:1,condition:'good',notes:'extra'}),/not allocated/);
  db.close();
});

test('CATER-PROFIT actual cost produces an event margin against the approved quote',()=>{
  const {db,ctx}=fixture();
  const event=createRecord(db,ctx,'catering',{name:'Conference lunch',customer:'Payer',date:future(7),venue:'Site',guests:100,quoteAmount:315000,deposit:0,resources:'x',notes:'x'});
  createCateringQuote(db,ctx,{eventId:event.id,amount:315000,notes:'Quote',evidence:'Email'});
  const profit=recordCateringActual(db,ctx,event.id,{actualCost:200000,notes:'Food and labour',evidence:'Supplier plus rota'});
  assert.equal(profit.quoteAmount,315000);assert.equal(profit.actualCost,200000);assert.equal(profit.margin,115000);
  assert.equal(profit.marginPercent,36.51);
  db.close();
});
