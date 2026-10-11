import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { createOrder,createRecord,recordAction,taxPolicy,taxFromGross } from '../server/domain.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const input=()=>({service:'takeaway',channel:'POS',idempotencyKey:randomUUID(),lines:[{itemId:'burger_outlet_downtown',quantity:1}]});
const advance=(db,ctx,r,action,extras={})=>recordAction(db,ctx,r.id,{action,version:r.version,reason:'Test approved evidence',evidence:'Signed test evidence',...extras});

async function server(t){
  const {db,ctx}=fixture();
  const app=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');
  await new Promise(resolve=>app.once('listening',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const signIn=async role=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})});const session=await res.json();return {headers:{'cookie':res.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'x-outlet-id':'outlet_downtown'}};};
  const call=async(session,path,options={})=>{const res=await fetch(base+path,{...options,headers:{...session.headers,...(options.headers||{})}});return {status:res.status,body:await res.json()};};
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));db.close();});
  return {db,ctx,base,owner:await signIn('owner'),cashier:await signIn('cashier'),accountant:await signIn('accountant'),call};
}

test('the default 5 percent policy preserves existing order and contract tax numbers',()=>{
  const {db,ctx}=fixture();
  assert.equal(taxPolicy(db,ctx).ratePercent,5,'the default VAT policy is 5 percent');
  assert.deepEqual(taxFromGross(4200,5),{net:4000,tax:200});
  const o=createOrder(db,ctx,input());
  assert.equal(o.total,4200);assert.equal(o.net,4000);assert.equal(o.tax,200);
  const base={name:'Contract',payer:'Company',site:'Site A',rate:1200,minimum:0,eligible:470,accepted:472,served:465,mealType:'lunch',startDate:'2020-01-01',endDate:'2099-01-01',notes:'Client approved terms'};
  let c=createRecord(db,ctx,'contracts',{...base,billingBasis:'accepted_meal'});c=advance(db,ctx,c,'approved');c=advance(db,ctx,c,'period_closed');
  assert.equal(c.data.invoice.net,566400);assert.equal(c.data.invoice.tax,28320);assert.equal(c.data.invoice.taxPercent,5);
  db.close();
});

test('the owner can change the VAT rate and new orders, amendments and contract invoices use it',async t=>{
  const {db,ctx,owner,call}=await server(t);
  const changed=await call(owner,'/api/settings/tax',{method:'POST',body:JSON.stringify({ratePercent:10,reason:'Federal Tax Authority rate change'})});
  assert.equal(changed.status,200);assert.equal(changed.body.ratePercent,10);assert.equal(changed.body.reviewed,true);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='tax'").get().value.includes('"ratePercent":10'),true);
  assert.equal(taxPolicy(db,ctx).ratePercent,10);
  const sold=await call(owner,'/api/orders',{method:'POST',body:JSON.stringify(input())});
  assert.equal(sold.status,201);
  assert.equal(sold.body.total,4200);assert.equal(sold.body.net,3818);assert.equal(sold.body.tax,382,'10/110 of 4200 rounds to 382');
  const amended=await call(owner,`/api/orders/${sold.body.id}/amendments`,{method:'POST',body:JSON.stringify({version:sold.body.version,idempotencyKey:randomUUID(),reason:'Add an espresso',addLines:[{itemId:'espresso_outlet_downtown',quantity:1}]})});
  assert.equal(amended.status,200);
  assert.equal(amended.body.total,5800);assert.equal(amended.body.net,5273);assert.equal(amended.body.tax,527,'amendment reprices the whole bill at the current rate');
  const base={name:'Contract',payer:'Company',site:'Site A',rate:1200,minimum:0,eligible:470,accepted:472,served:465,mealType:'lunch',startDate:'2020-01-01',endDate:'2099-01-01',notes:'Client approved terms'};
  let c=createRecord(db,ctx,'contracts',{...base,billingBasis:'accepted_meal'});c=advance(db,ctx,c,'approved');c=advance(db,ctx,c,'period_closed');
  assert.equal(c.data.invoice.tax,56640);assert.equal(c.data.invoice.total,623040);assert.equal(c.data.invoice.taxPercent,10);
  assert.equal(db.prepare('SELECT SUM(debit-credit) n FROM journal_lines').get().n,0,'re-rated postings still balance');
});

test('tax policy changes are owner-only and reject out-of-range rates',async t=>{
  const {cashier,accountant,owner,call}=await server(t);
  assert.equal((await call(cashier,'/api/settings/tax',{method:'POST',body:JSON.stringify({ratePercent:7,reason:'Cashier attempt to change VAT'})})).status,403);
  assert.equal((await call(accountant,'/api/settings/tax',{method:'POST',body:JSON.stringify({ratePercent:7,reason:'Accountant attempt to change VAT'})})).status,403);
  assert.equal((await call(owner,'/api/settings/tax',{method:'POST',body:JSON.stringify({ratePercent:101,reason:'Out of range rate'})})).status,400);
  assert.equal((await call(owner,'/api/settings/tax',{method:'POST',body:JSON.stringify({ratePercent:5,reason:'no'})})).status,400);
});

test('tax mappings stay hidden until an authorised approver signs them off',async t=>{
  const {db,ctx,owner,accountant,cashier,call}=await server(t);
  assert.equal((await call(cashier,'/api/records/tax_codes',{method:'POST',body:JSON.stringify({name:'Zero rated food',ratePercent:0,treatment:'zero_rated',account:'Output VAT',notes:'FTA zero-rated staple foods'})})).status,403,'a non-finance role cannot author tax mappings');
  const draft=await call(accountant,'/api/records/tax_codes',{method:'POST',body:JSON.stringify({name:'Zero rated food',ratePercent:0,treatment:'zero_rated',account:'Output VAT',notes:'FTA zero-rated staple foods'})});
  assert.equal(draft.status,201);assert.equal(draft.body.status,'draft');
  assert.equal((await call(owner,'/api/records/tax_codes',{method:'POST',body:JSON.stringify({name:'Zero rated food',ratePercent:0,treatment:'zero_rated',account:'Output VAT',notes:'Duplicate'})})).status,409,'tax code names are unique per outlet');
  assert.equal((await call(accountant,'/api/records/tax_codes',{method:'POST',body:JSON.stringify({name:'Bad standard',ratePercent:0,treatment:'standard',account:'Output VAT',notes:'Needs a positive rate'})})).status,400);
  let settings=await call(owner,'/api/settings',{});
  assert.deepEqual(settings.body.taxCodes,[],'a draft tax mapping is not published to billing settings');
  assert.equal(settings.body.tax.ratePercent,5);
  const approved=await call(owner,`/api/records/${draft.body.id}/action`,{method:'POST',body:JSON.stringify({action:'approved',version:draft.body.version,reason:'Reviewed against FTA guidance',evidence:'https://tax.gov.ae/legislation'})});
  assert.equal(approved.status,200);assert.equal(approved.body.status,'approved');
  settings=await call(owner,'/api/settings',{});
  assert.equal(settings.body.taxCodes.length,1);assert.equal(settings.body.taxCodes[0].name,'Zero rated food');assert.equal(settings.body.taxCodes[0].ratePercent,0);
});
