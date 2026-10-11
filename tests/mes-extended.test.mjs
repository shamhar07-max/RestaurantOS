import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { createRecord,recordAction,getRecord,contractRateAt } from '../server/domain.mjs';
import { addContractRate,contractRateSchedule,eaterRoster,effectiveRoster,reviseDemand,lockDemand,decideDemandException,produceDemand,syncOfflineServings,cateringReconciliation,issueClientToken,clientPortal,clientPortalApprove,subscriptionCredit,subscriptionDelivery,renewSubscription } from '../server/mes.mjs';
import { createSubRecipe } from '../server/recipes.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const contractBase=()=>({name:'Site meal contract',payer:'Example Co.',site:'Business Bay',billingBasis:'accepted_meal',rate:1200,minimum:0,eligible:100,accepted:100,served:0,mealType:'lunch',startDate:businessDate(),endDate:'2099-01-01',notes:'Client approved terms'});
const subscriptionBase=()=>({name:'Nadia · training account',plan:'Weekday lunch',entitlements:100,mealPrice:2000,address:'Old address',days:'Mon–Fri · 12:00',cutoff:'Previous day 18:00',notes:'Funded synthetic entitlement'});
const tomorrow=()=>new Date(Date.now()+86400000).toISOString().slice(0,10);

async function server(t){
  const {db,ctx}=fixture();
  const app=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');
  await new Promise(resolve=>app.once('listening',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const signIn=async r=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:r})});const session=await res.json();return {headers:{'cookie':res.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'x-outlet-id':'outlet_downtown'}};};
  const call=async(session,path,options={})=>{const res=await fetch(base+path,{...options,headers:{...session.headers,...(options.headers||{})}});return {status:res.status,body:await res.json()};};
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));db.close();});
  return {db,ctx,base,owner:await signIn('owner'),chef:await signIn('chef'),cashier:await signIn('cashier'),call};
}

test('MES-01 effective-dated rate versions leave a future change out of today and keep the closed invoice snapshot',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  const scheduled=addContractRate(db,ctx,c.id,{rate:1500,billingBasis:'accepted_meal',minimum:0,effectiveFrom:'2099-01-01',reason:'Annual CPI uplift'});
  assert.equal(scheduled.data.rate,1200,'a future change does not move the current rate');
  assert.equal(contractRateSchedule(db,ctx,c.id).versions.length,2);
  assert.equal(contractRateAt(getRecord(db,ctx,c.id),businessDate()).rate,1200);
  const applied=addContractRate(db,ctx,c.id,{rate:1400,billingBasis:'accepted_meal',minimum:0,effectiveFrom:businessDate(),reason:'Immediate uplift'});
  assert.equal(applied.data.rate,1400);
  assert.throws(()=>addContractRate(db,ctx,c.id,{rate:1450,billingBasis:'accepted_meal',minimum:0,effectiveFrom:businessDate(),reason:'Duplicate'}),/already takes effect/);
  const approved=recordAction(db,ctx,c.id,{action:'approved',version:getRecord(db,ctx,c.id).version,reason:'Client approved',evidence:'Signed terms'});
  const closed=recordAction(db,ctx,approved.id,{action:'period_closed',version:approved.version,reason:'Period close',evidence:'Client statement'});
  assert.equal(closed.data.invoice.rateVersion,3);
  assert.equal(closed.data.invoice.net,140000,'the closed period bills at the rate effective on the close date');
  db.close();
});

test('MES-03 eaters are modelled separately from the payer and aggregate entitlements',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  createRecord(db,ctx,'eaters',{name:'Eater A',contractId:c.id,externalRef:'B-1',entitlement:5,site:'Business Bay',notes:''});
  const eater=createRecord(db,ctx,'eaters',{name:'Eater B',contractId:c.id,externalRef:'B-2',entitlement:3,site:'Business Bay',notes:''});
  const roster=eaterRoster(db,ctx,c.id);
  assert.equal(roster.people,2);assert.equal(roster.eligible,8);assert.equal(roster.site,'Business Bay');
  recordAction(db,ctx,eater.id,{action:'suspended',version:eater.version,reason:'On leave'});
  assert.equal(eaterRoster(db,ctx,c.id).eligible,5);
  assert.throws(()=>createRecord(db,ctx,'eaters',{name:'Bad',contractId:'missing',externalRef:'',entitlement:1,site:'x',notes:''}),/not found/);
  db.close();
});

test('MES-04 roster changes apply only from their effective date',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  const join=createRecord(db,ctx,'roster_events',{name:'Cohort join',contractId:c.id,action:'join',quantity:10,fromSite:'',toSite:'Business Bay',effectiveFrom:businessDate(),notes:'Client confirmed'});
  recordAction(db,ctx,join.id,{action:'applied',version:join.version,reason:'Approved'});
  assert.equal(effectiveRoster(db,ctx,c.id).headcount,110);
  const future=createRecord(db,ctx,'roster_events',{name:'Future leave',contractId:c.id,action:'leave',quantity:20,fromSite:'Business Bay',toSite:'',effectiveFrom:'2099-01-01',notes:'Scheduled'});
  recordAction(db,ctx,future.id,{action:'applied',version:future.version,reason:'Scheduled'});
  assert.equal(effectiveRoster(db,ctx,c.id).headcount,110,'a future leave does not change today');
  assert.equal(effectiveRoster(db,ctx,c.id,'2099-06-01').headcount,90);
  assert.throws(()=>createRecord(db,ctx,'roster_events',{name:'Bad transfer',contractId:c.id,action:'transfer',quantity:1,fromSite:'',toSite:'',effectiveFrom:businessDate(),notes:'x'}),/from and a to site/);
  db.close();
});

test('MES-05 a change after the cutoff creates an exception rather than rewriting the snapshot',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  const open=createRecord(db,ctx,'demand_snapshots',{name:'Lunch run',contractId:c.id,mealType:'lunch',date:businessDate(),quantity:80,cutoffAt:'2099-01-01T12:00',notes:'Baseline'});
  const revised=reviseDemand(db,ctx,open.id,{quantity:90,version:open.version,reason:'Client added seats'});
  assert.equal(revised.late,false);assert.equal(revised.demand.data.quantity,90);
  const locked=lockDemand(db,ctx,open.id,{version:revised.demand.version,reason:'Cutoff reached'});
  assert.equal(locked.status,'locked');
  const late=reviseDemand(db,ctx,open.id,{quantity:120,version:locked.version,reason:'Late client request'});
  assert.equal(late.late,true);assert.equal(late.exception.status,'open');assert.equal(late.demand.data.quantity,90,'the locked snapshot is unchanged');
  const decided=decideDemandException(db,ctx,late.exception.id,{decision:'approved',version:late.exception.version,reason:'Approved additional meals'});
  assert.equal(decided.status,'approved');
  const demand=getRecord(db,ctx,open.id);assert.equal(demand.data.quantity,120);assert.equal(demand.data.appliedChanges.length,1);
  const past=createRecord(db,ctx,'demand_snapshots',{name:'Past cutoff',contractId:c.id,mealType:'lunch',date:businessDate(),quantity:10,cutoffAt:'2000-01-01T00:00',notes:'x'});
  assert.equal(reviseDemand(db,ctx,past.id,{quantity:12,version:past.version,reason:'Late'}).late,true);
  db.close();
});

test('MES-07 a demand snapshot creates a linked planned batch',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  const recipe=createSubRecipe(db,ctx,{name:'House sauce base',outputId:'sauce',outputQuantity:1000,lines:[{ingredientId:'tomato',quantity:600},{ingredientId:'oil',quantity:200}],notes:'Batch sauce'});
  const demand=createRecord(db,ctx,'demand_snapshots',{name:'Lunch demand',contractId:c.id,mealType:'lunch',date:businessDate(),quantity:100,cutoffAt:'2099-01-01T12:00',notes:'x'});
  const produced=produceDemand(db,ctx,demand.id,{recipeId:recipe.id,expiry:tomorrow(),notes:'Plan lunch'});
  assert.ok(produced.batchId);assert.equal(produced.batch.status,'planned');
  assert.equal(getRecord(db,ctx,demand.id).data.production.length,1);
  assert.ok(produced.inputs.some(i=>i.ingredientId==='tomato'));
  assert.throws(()=>produceDemand(db,ctx,demand.id,{expiry:tomorrow()}),/Link a production recipe/);
  db.close();
});

test('MES-08 bulk dispatch records partial acceptance with a variance',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  const d=createRecord(db,ctx,'dispatches',{name:'Morning run',contractId:c.id,demandId:'',date:businessDate(),dispatched:100,accepted:90,rejected:10,notes:'Vehicle DX-1, seal 4455'});
  assert.equal(d.status,'planned');
  const dispatched=recordAction(db,ctx,d.id,{action:'dispatched',version:d.version,reason:'Loaded',evidence:'Seal 4455 photographed'});
  assert.equal(dispatched.status,'dispatched');
  const accepted=recordAction(db,ctx,d.id,{action:'accepted',version:dispatched.version,reason:'Site count',evidence:'Signed delivery note'});
  assert.equal(accepted.status,'accepted');assert.equal(accepted.data.variance,-10);assert.equal(accepted.data.accepted,90);
  assert.throws(()=>createRecord(db,ctx,'dispatches',{name:'Bad',contractId:c.id,date:businessDate(),dispatched:10,accepted:9,rejected:2,notes:'x'}),/cannot exceed/);
  db.close();
});

test('MES-10 offline serving deduplicates scans and flags conflicts without creating evidence',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  const first=syncOfflineServings(db,ctx,{scans:[{scanId:'scan-1',contractId:c.id,date:businessDate(),mealType:'lunch',method:'individual_scan',quantity:40,site:'Business Bay',evidence:''}]});
  assert.equal(first.accepted,1);assert.equal(first.conflicts,0);
  const replay=syncOfflineServings(db,ctx,{scans:[{scanId:'scan-1',contractId:c.id,date:businessDate(),mealType:'lunch',method:'individual_scan',quantity:40,site:'Business Bay',evidence:''}]});
  assert.equal(replay.duplicates,1);assert.equal(replay.results[0].servingId,first.results[0].servingId);
  const over=syncOfflineServings(db,ctx,{scans:[{scanId:'scan-2',contractId:c.id,date:businessDate(),mealType:'lunch',method:'group_count',quantity:200,site:'Business Bay',evidence:''}]});
  assert.equal(over.conflicts,1);assert.equal(over.results[0].status,'conflict');assert.equal(over.results[0].servingId,null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE module='servings'").get().n,1,'a conflict does not create serving evidence');
  db.close();
});

test('MES-13 reconciliation reports produced, dispatched, served, remaining and waste',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  const demand=createRecord(db,ctx,'demand_snapshots',{name:'Service',contractId:c.id,mealType:'lunch',date:businessDate(),quantity:100,cutoffAt:'2099-01-01T12:00',notes:'x'});
  const d=createRecord(db,ctx,'dispatches',{name:'Run',contractId:c.id,demandId:demand.id,date:businessDate(),dispatched:100,accepted:90,rejected:10,notes:'Seal'});
  recordAction(db,ctx,d.id,{action:'dispatched',version:d.version,reason:'Loaded',evidence:'Seal'});
  recordAction(db,ctx,d.id,{action:'accepted',version:getRecord(db,ctx,d.id).version,reason:'Site',evidence:'Signed'});
  const scan=createRecord(db,ctx,'servings',{name:'Site line',contractId:c.id,date:businessDate(),mealType:'lunch',method:'individual_scan',quantity:80,site:'Business Bay',evidence:'Scan export'});
  recordAction(db,ctx,scan.id,{action:'verified',version:scan.version,reason:'Verified',evidence:'Scan accepted'});
  const recon=cateringReconciliation(db,ctx,c.id);
  assert.equal(recon.planned,100);assert.equal(recon.dispatched,100);assert.equal(recon.accepted,90);assert.equal(recon.rejected,10);assert.equal(recon.served,80);assert.equal(recon.remainingAccepted,10);
  db.close();
});

test('MES-14 client portal is scoped to the payer and can approve an issued invoice',()=>{
  const {db,ctx}=fixture();
  const mine=createRecord(db,ctx,'contracts',contractBase());
  const other=createRecord(db,ctx,'contracts',{...contractBase(),name:'Other payer',payer:'Another Co.'});
  const approved=recordAction(db,ctx,mine.id,{action:'approved',version:mine.version,reason:'Approved',evidence:'Signed'});
  recordAction(db,ctx,approved.id,{action:'period_closed',version:approved.version,reason:'Close',evidence:'Client statement'});
  const {token}=issueClientToken(db,ctx,{payer:'Example Co.',reason:'Invite client'});
  const portal=clientPortal(db,token);
  assert.ok(portal.contracts.some(c=>c.id===mine.id));assert.ok(!portal.contracts.some(x=>x.id===other.id),'another payer is not visible');
  assert.throws(()=>clientPortalApprove(db,token,{contractId:other.id,evidence:'Wrong payer'}),/does not belong/);
  assert.equal(clientPortalApprove(db,token,{contractId:mine.id,evidence:'Approved by client finance'}).ok,true);
  assert.ok(clientPortal(db,token).contracts.find(c=>c.id===mine.id).clientApproval);
  db.close();
});

test('MES-16 crediting a subscription recognises unused entitlement',()=>{
  const {db,ctx}=fixture();
  const s=createRecord(db,ctx,'subscriptions',subscriptionBase());
  recordAction(db,ctx,s.id,{action:'fulfil',version:s.version,reason:'Delivered',evidence:'Delivery note'});
  const res=subscriptionCredit(db,ctx,s.id,{reason:'Client pause',refund:true});
  assert.equal(res.credit.meals,99);assert.equal(res.credit.amount,198000);assert.equal(res.credit.refund,true);
  assert.equal(getRecord(db,ctx,s.id).data.credits.length,1);
  db.close();
});

test('MES-17 delivery calendar and address changes are effective-dated',()=>{
  const {db,ctx}=fixture();
  const s=createRecord(db,ctx,'subscriptions',subscriptionBase());
  const today=businessDate(),next=tomorrow();
  createRecord(db,ctx,'subscription_changes',{name:'Move',subscriptionId:s.id,effectiveFrom:next,address:'New address',days:'Mon–Fri',notes:'Client confirmed'});
  createRecord(db,ctx,'subscription_changes',{name:'Immediate',subscriptionId:s.id,effectiveFrom:today,address:'Interim address',days:'Mon–Thu',notes:'Client confirmed'});
  const now=subscriptionDelivery(db,ctx,s.id,today);
  assert.equal(now.address,'Interim address');assert.deepEqual(now.futureChanges,[next]);
  assert.equal(subscriptionDelivery(db,ctx,s.id,next).address,'New address');
  assert.throws(()=>createRecord(db,ctx,'subscription_changes',{name:'Bad',subscriptionId:s.id,effectiveFrom:'2000-01-01',address:'x',days:'x',notes:'x'}),/today or a future date/);
  db.close();
});

test('MES-18 renewal funds entitlements and reports the prepaid balance',()=>{
  const {db,ctx}=fixture();
  const s=createRecord(db,ctx,'subscriptions',subscriptionBase());
  recordAction(db,ctx,s.id,{action:'fulfil',version:s.version,reason:'Delivered',evidence:'Note'});
  const balance=renewSubscription(db,ctx,s.id,{entitlements:50,paymentReference:'REC-1'});
  assert.equal(balance.funded,150);assert.equal(balance.delivered,1);assert.equal(balance.remaining,149);assert.equal(balance.prepaidValue,298000);
  assert.equal(balance.renewals.length,1);
  db.close();
});

test('MES endpoints enforce catering permission and the public client portal', async t=>{
  const {db,owner,chef,cashier,call,base}=await server(t);
  const created=await call(owner,'/api/records/contracts',{method:'POST',body:JSON.stringify(contractBase())});
  assert.equal(created.status,201);
  const contractId=created.body.id;
  assert.equal((await call(owner,`/api/contracts/${contractId}/rates`,{method:'POST',body:JSON.stringify({rate:1300,billingBasis:'accepted_meal',minimum:0,effectiveFrom:tomorrow(),reason:'Scheduled uplift'})})).status,200);
  assert.equal((await call(cashier,`/api/contracts/${contractId}/roster`,{})).status,403,'the cashier cannot read catering rosters');
  assert.equal((await call(chef,'/api/catering/servings/offline',{method:'POST',body:JSON.stringify({scans:[{scanId:'x',contractId,date:businessDate(),mealType:'lunch',method:'individual_scan',quantity:1,site:'Business Bay',evidence:'e'}]})})).status,403);
  const synced=await call(owner,'/api/catering/servings/offline',{method:'POST',body:JSON.stringify({scans:[{scanId:'off-1',contractId,date:businessDate(),mealType:'lunch',method:'individual_scan',quantity:5,site:'Business Bay',evidence:''}]})});
  assert.equal(synced.status,200);assert.equal(synced.body.accepted,1);
  const recon=await call(owner,`/api/catering/reconciliation?contractId=${contractId}`,{});
  assert.equal(recon.status,200);assert.equal(recon.body.planned,0);
  const token=await call(owner,'/api/catering/client-tokens',{method:'POST',body:JSON.stringify({payer:'Example Co.',reason:'Invite client'})});
  assert.equal(token.status,201);
  const publicRes=await fetch(base+`/api/catering/client/${token.body.token}`);
  const portal=await publicRes.json();
  assert.equal(publicRes.status,200);assert.equal(portal.payer,'Example Co.');assert.ok(portal.contracts.some(c=>c.id===contractId));
});
