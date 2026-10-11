import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { createOrder } from '../server/domain.mjs';
import { queuePrint,acknowledgePrint,retryPrint,printJobs,printSummary } from '../server/printers.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const order=(ctx,key)=>({service:'takeaway',channel:'POS',customer:'Guest',idempotencyKey:key,lines:[{itemId:'burger_outlet_downtown',quantity:1}]});

async function server(t){
  const {db,ctx}=fixture();
  const app=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');
  await new Promise(resolve=>app.once('listening',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const signIn=async r=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:r})});const session=await res.json();return {headers:{'cookie':res.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'x-outlet-id':'outlet_downtown'}};};
  const call=async(session,path,options={})=>{const res=await fetch(base+path,{...options,headers:{...session.headers,...(options.headers||{})}});return {status:res.status,body:await res.json()};};
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));db.close();});
  return {db,ctx,base,owner:await signIn('owner'),cashier:await signIn('cashier'),chef:await signIn('chef'),call};
}

test('ORD-11 a printed ticket is queued idempotently and confirmed',()=>{
  const {db,ctx}=fixture();
  const placed=createOrder(db,ctx,order(ctx,'print-key-0001'));
  const job=queuePrint(db,ctx,placed.id,{station:'grill',printer:'Grill printer',idempotencyKey:'pj-key-0001'});
  assert.equal(job.status,'queued');assert.equal(job.attempts,0);
  assert.equal(job.ticket.orderNumber,placed.number);
  assert.equal(job.ticket.lines[0].name,'The house burger');
  const replay=queuePrint(db,ctx,placed.id,{station:'grill',printer:'Grill printer',idempotencyKey:'pj-key-0001'});
  assert.equal(replay.id,job.id);
  const confirmed=acknowledgePrint(db,ctx,job.id,{ok:true});
  assert.equal(confirmed.status,'printed');assert.equal(confirmed.attempts,1);
  assert.throws(()=>acknowledgePrint(db,ctx,job.id,{ok:true}),/already resolved/);
  assert.deepEqual(printSummary(db,ctx),{queued:0,printed:1,failed:0,needsReprint:0});
  db.close();
});

test('ORD-11 an interrupted print is retained and can be retried',()=>{
  const {db,ctx}=fixture();
  const placed=createOrder(db,ctx,order(ctx,'print-key-0002'));
  const job=queuePrint(db,ctx,placed.id,{station:'grill',printer:'',idempotencyKey:'pj-key-0002'});
  const failed=acknowledgePrint(db,ctx,job.id,{ok:false,error:'Paper jam'});
  assert.equal(failed.status,'failed');assert.equal(failed.last_error,'Paper jam');assert.equal(failed.attempts,1);
  assert.equal(printSummary(db,ctx).needsReprint,1);
  assert.throws(()=>retryPrint(db,ctx,job.id,{reason:'x'}),/at least 3|too_small|Too small|reason/i);
  const retried=retryPrint(db,ctx,job.id,{reason:'Paper replaced'});
  assert.equal(retried.status,'queued');
  assert.equal(printJobs(db,ctx,{status:'queued'}).length,1);
  const confirmed=acknowledgePrint(db,ctx,job.id,{ok:true});
  assert.equal(confirmed.status,'printed');assert.equal(confirmed.attempts,2);
  db.close();
});

test('ORD-11 print endpoints enforce order permission and expose the queue',async t=>{
  const {owner,chef,cashier,call}=await server(t);
  const placed=await call(cashier,'/api/orders',{method:'POST',body:JSON.stringify({service:'takeaway',channel:'POS',customer:'Guest',idempotencyKey:'http-print-0001',lines:[{itemId:'burger_outlet_downtown',quantity:1}]})});
  assert.equal(placed.status,201);
  const job=await call(cashier,`/api/orders/${placed.body.id}/print-jobs`,{method:'POST',body:JSON.stringify({station:'grill',printer:'Grill',idempotencyKey:'http-pj-0001'})});
  assert.equal(job.status,201);assert.equal(job.body.status,'queued');
  assert.equal((await call(chef,`/api/orders/${placed.body.id}/print-jobs`,{method:'POST',body:JSON.stringify({station:'grill',printer:'',idempotencyKey:'http-pj-0002'})})).status,403,'chef cannot queue tickets');
  assert.equal((await call(cashier,`/api/print-jobs/${job.body.id}/acknowledge`,{method:'POST',body:JSON.stringify({ok:false,error:'Offline printer'})})).status,200);
  const summary=await call(owner,'/api/print-jobs/summary',{});
  assert.equal(summary.status,200);assert.equal(summary.body.failed,1);assert.equal(summary.body.needsReprint,1);
  const queue=await call(owner,'/api/print-jobs?status=failed',{});
  assert.equal(queue.body.length,1);
});
