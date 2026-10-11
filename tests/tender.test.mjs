import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { createOrder,pay,createRecord,recordAction } from '../server/domain.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const input=()=>({service:'takeaway',channel:'POS',idempotencyKey:randomUUID(),lines:[{itemId:'burger_outlet_downtown',quantity:1}]});

test('cash movements and tips are reconciled into the expected till balance',()=>{
  const {db,ctx}=fixture();let till=createRecord(db,ctx,'tills',{name:'TILL-TENDER',opening:10000});
  const o=createOrder(db,ctx,input());pay(db,ctx,o.id,{amount:4200,method:'cash',tillId:till.id,idempotencyKey:randomUUID()});
  for(const [idKey,type,amount] of [['tm1','paid_in',5000],['tm2','paid_out',2000],['tm3','tip',1500]])db.prepare('INSERT INTO till_movements VALUES(?,?,?,?,?,?,?,?,?,?)').run(idKey,ctx.tenantId,ctx.outletId,till.id,type,amount,'Test movement','user_owner',randomUUID(),new Date().toISOString());
  // opening 10000 + cash 4200 + paid_in 5000 + tip 1500 - paid_out 2000 = 18700
  till=recordAction(db,ctx,till.id,{action:'closed',version:till.version,counted:18700,reason:'Counted drawer cash'});
  assert.equal(till.data.expected,18700);assert.equal(till.data.variance,0);assert.equal(till.data.tips,1500);assert.equal(till.data.reconciled,true);
  assert.equal(till.data.cash.paidIn,5000);assert.equal(till.data.cash.paidOut,2000);db.close();
});

test('an unexplained cash or card difference blocks the close',()=>{
  const {db,ctx}=fixture();let till=createRecord(db,ctx,'tills',{name:'TILL-BLOCK',opening:0});const o=createOrder(db,ctx,input());pay(db,ctx,o.id,{amount:4200,method:'cash',tillId:till.id,idempotencyKey:randomUUID()});
  assert.throws(()=>recordAction(db,ctx,till.id,{action:'closed',version:till.version,counted:4000}),/Explain the cash or card difference/);
  till=recordAction(db,ctx,till.id,{action:'closed',version:till.version,counted:4100,reason:'Short by AED 1.00 · receipt attached'});
  assert.equal(till.data.variance,-100);assert.equal(till.data.reconciled,false);db.close();
});

test('declared card takings are reconciled separately from cash',()=>{
  const {db,ctx}=fixture();let till=createRecord(db,ctx,'tills',{name:'TILL-CARD',opening:1000});
  const a=createOrder(db,ctx,input()),b=createOrder(db,ctx,input());
  pay(db,ctx,a.id,{amount:4200,method:'bank_recorded',reference:'CARD-1',tillId:till.id,idempotencyKey:randomUUID()});
  pay(db,ctx,b.id,{amount:4200,method:'bank_recorded',reference:'CARD-2',tillId:till.id,idempotencyKey:randomUUID()});
  assert.throws(()=>recordAction(db,ctx,till.id,{action:'closed',version:till.version,counted:1000,declared:8000}),/Explain the cash or card difference/);
  till=recordAction(db,ctx,till.id,{action:'closed',version:till.version,counted:1000,declared:8400,reason:'Terminal total matches two card sales'});
  assert.equal(till.data.bank.expected,8400);assert.equal(till.data.bank.variance,0);assert.equal(till.data.reconciled,true);db.close();
});

test('cash movements are idempotent, locked after close and permission-scoped over HTTP',async t=>{
  const {db,ctx}=fixture();
  const app=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');await new Promise(resolve=>app.once('listening',resolve));const base=`http://127.0.0.1:${app.address().port}`;
  const signIn=async role=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})});const session=await res.json();return {cookie:res.headers.get('set-cookie').split(';')[0],headers:{'cookie':res.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'x-outlet-id':'outlet_downtown'}};};
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));db.close();});
  const till=createRecord(db,ctx,'tills',{name:'TILL-HTTP',opening:0});const cashier=await signIn('cashier');const key=randomUUID();
  const body={type:'paid_in',amount:2500,reason:'Petty cash top-up',idempotencyKey:key};
  assert.equal((await fetch(`${base}/api/tills/${till.id}/movements`,{method:'POST',headers:cashier.headers,body:JSON.stringify(body)})).status,201);
  assert.equal((await fetch(`${base}/api/tills/${till.id}/movements`,{method:'POST',headers:cashier.headers,body:JSON.stringify(body)})).status,201);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM till_movements WHERE till_id=?').get(till.id).n,1,'idempotent replay must not double-post');
  const listed=await (await fetch(`${base}/api/tills/${till.id}/movements`,{headers:cashier.headers})).json();assert.equal(listed.length,1);assert.equal(listed[0].actor,'Sara · Cashier');
  recordAction(db,ctx,till.id,{action:'closed',version:till.version,counted:2500,reason:'Counted drawer cash'});
  assert.equal((await fetch(`${base}/api/tills/${till.id}/movements`,{method:'POST',headers:cashier.headers,body:JSON.stringify({...body,idempotencyKey:randomUUID()})})).status,409,'till movements must be locked after close');
});
