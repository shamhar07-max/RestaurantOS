import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { createRecord,recordAction,getRecord } from '../server/domain.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const role=(ctx,name)=>({...ctx,user:{...ctx.user,id:`user_${name}`,role:name,outlet_ids:['outlet_downtown']}});
const contractBase=()=>({name:'Site meal contract',payer:'Example Co.',site:'Business Bay',billingBasis:'accepted_meal',rate:1200,minimum:0,eligible:100,accepted:100,served:0,mealType:'lunch',startDate:businessDate(),endDate:'2099-01-01',notes:'Client approved terms'});
const serving=(contractId,patch={})=>({name:'Service line',contractId,date:businessDate(),mealType:'lunch',method:'individual_scan',quantity:40,site:'Business Bay',evidence:'Scan export SHA-256 attached',...patch});

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

test('verified serving evidence advances the contract served count and reconciles',()=>{
  const {db,ctx}=fixture();
  let contract=createRecord(db,ctx,'contracts',contractBase());contract=recordAction(db,ctx,contract.id,{action:'approved',version:contract.version,reason:'Client approved',evidence:'Signed terms'});
  const scan=createRecord(db,ctx,'servings',serving(contract.id));
  assert.equal(scan.status,'recorded');
  assert.throws(()=>recordAction(db,ctx,scan.id,{action:'verified',version:scan.version,evidence:''}),/evidence is required/);
  const verified=recordAction(db,ctx,scan.id,{action:'verified',version:scan.version,evidence:'Individual scan export accepted',reason:'Supervisor verified'});
  assert.equal(verified.status,'verified');
  assert.equal(getRecord(db,ctx,contract.id).data.served,40,'verification advances the contract served count once');
  const group=createRecord(db,ctx,'servings',serving(contract.id,{name:'Hall count',method:'group_count',quantity:10}));
  recordAction(db,ctx,group.id,{action:'verified',version:group.version,evidence:'Signed head count sheet'});
  assert.equal(getRecord(db,ctx,contract.id).data.served,50);
  const pending=createRecord(db,ctx,'servings',serving(contract.id,{name:'Evening',quantity:5}));
  assert.equal(pending.status,'recorded');assert.equal(getRecord(db,ctx,contract.id).data.served,50,'unverified evidence does not advance the served count');
  db.close();
});

test('serving must reference a contract with a matching meal type',()=>{
  const {db,ctx}=fixture();
  const contract=createRecord(db,ctx,'contracts',contractBase());
  assert.throws(()=>createRecord(db,ctx,'servings',serving('missing_contract')),/not found/);
  assert.throws(()=>createRecord(db,ctx,'servings',serving(contract.id,{mealType:'dinner'})),/must match the contract/);
  db.close();
});

test('catering roles are gated and reconciliation reports evidence by method',async t=>{
  const {db,ctx,owner,chef,cashier,call}=await server(t);
  const contract=await call(owner,'/api/records/contracts',{method:'POST',body:JSON.stringify(contractBase())});
  await call(owner,`/api/records/${contract.body.id}/action`,{method:'POST',body:JSON.stringify({action:'approved',version:contract.body.version,reason:'Client approved',evidence:'Signed terms'})});
  const scan=await call(owner,'/api/records/servings',{method:'POST',body:JSON.stringify(serving(contract.body.id,{quantity:40}))});
  assert.equal(scan.status,201);
  assert.equal((await call(chef,'/api/records/servings',{method:'POST',body:JSON.stringify(serving(contract.body.id,{name:'Kitchen',quantity:1}))})).status,403,'kitchen role cannot author serving evidence');
  assert.equal((await call(cashier,`/api/records/${scan.body.id}/action`,{method:'POST',body:JSON.stringify({action:'verified',version:1,evidence:'Cashier attempt',reason:'No authority'})})).status,403);
  const verified=await call(owner,`/api/records/${scan.body.id}/action`,{method:'POST',body:JSON.stringify({action:'verified',version:scan.body.version,evidence:'Scan export accepted',reason:'Supervisor verified'})});
  assert.equal(verified.status,200);
  const group=await call(owner,'/api/records/servings',{method:'POST',body:JSON.stringify(serving(contract.body.id,{name:'Hall count',method:'group_count',quantity:10}))});
  await call(owner,`/api/records/${group.body.id}/action`,{method:'POST',body:JSON.stringify({action:'verified',version:group.body.version,evidence:'Signed head count',reason:'Verified'})});
  await call(owner,'/api/records/servings',{method:'POST',body:JSON.stringify(serving(contract.body.id,{name:'Unverified line',quantity:5}))});
  const recon=await call(owner,`/api/catering/servings/reconciliation?contractId=${contract.body.id}`,{});
  assert.equal(recon.status,200);
  assert.equal(recon.body.accepted,100);assert.equal(recon.body.served,50);assert.equal(recon.body.remaining,50);assert.equal(recon.body.overServed,0);
  assert.equal(recon.body.verifiedEvidence,50);assert.equal(recon.body.unverifiedEvidence,5);assert.equal(recon.body.reconciled,false);
  assert.equal(recon.body.individualScans,45);assert.equal(recon.body.groupCounts,10);assert.equal(recon.body.evidenceCount,3);
});

test('a non-catering role cannot author serving evidence',()=>{
  const {db,ctx}=fixture();
  const contract=createRecord(db,ctx,'contracts',contractBase());
  assert.throws(()=>createRecord(db,role(ctx,'cashier'),'servings',serving(contract.id)),/permit/);
  db.close();
});
