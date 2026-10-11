import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};

async function server(t){
  const {db,ctx}=fixture();
  const app=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');
  await new Promise(resolve=>app.once('listening',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const signIn=async role=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})});const session=await res.json();return {cookie:res.headers.get('set-cookie').split(';')[0],headers:{'cookie':res.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'x-outlet-id':'outlet_downtown'}};};
  const call=async(session,path,options={})=>{const res=await fetch(base+path,{...options,headers:{...session.headers,...(options.headers||{})}});return {status:res.status,body:await res.json()};};
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));db.close();});
  return {db,ctx,base,owner:await signIn('owner'),cashier:await signIn('cashier'),call};
}

test('an unmapped channel menu reference is rejected atomically and queued for action',async t=>{
  const {db,owner,call}=await server(t);
  const before=db.prepare('SELECT COUNT(*) n FROM orders').get().n;
  const result=await call(owner,'/api/channels/import',{method:'POST',body:JSON.stringify({channel:'Talabat',externalOrderId:'TLB-1001',service:'delivery',lines:[{externalItemId:'TLB-BURGER-01',externalName:'House burger',quantity:1}]})});
  assert.equal(result.status,409);
  assert.match(result.body.error,/not mapped/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,before,'no part of the import may apply');
  const exceptions=db.prepare("SELECT * FROM records WHERE module='mapping_exceptions' AND status='open'").all();
  assert.equal(exceptions.length,1);
  const data=JSON.parse(exceptions[0].data);
  assert.equal(data.externalOrderId,'TLB-1001');
  assert.deepEqual(data.unresolved,['TLB-BURGER-01']);
});

test('mapping the reference resolves the queue and retry imports exactly once',async t=>{
  const {db,owner,call}=await server(t);
  await call(owner,'/api/channels/import',{method:'POST',body:JSON.stringify({channel:'Talabat',externalOrderId:'TLB-1002',service:'takeaway',lines:[{externalItemId:'TLB-LATTE',quantity:2}]})});
  const exception=db.prepare("SELECT * FROM records WHERE module='mapping_exceptions' AND status='open'").get();
  const mapping=await call(owner,'/api/channels/mappings',{method:'POST',body:JSON.stringify({channel:'Talabat',externalItemId:'TLB-LATTE',itemId:'latte_outlet_downtown'})});
  assert.equal(mapping.status,201);
  assert.equal(mapping.body.itemName,'Flat white');
  const retried=await call(owner,`/api/channels/exceptions/${exception.id}/retry`,{method:'POST',body:JSON.stringify({version:exception.version})});
  assert.equal(retried.status,200);
  assert.equal(retried.body.status,'imported');
  assert.equal(retried.body.order.lines.length,1);
  assert.equal(retried.body.order.lines[0].quantity,2);
  assert.equal(db.prepare("SELECT status FROM records WHERE id=?").get(exception.id).status,'resolved');
  const orders=db.prepare("SELECT COUNT(*) n FROM orders WHERE idempotency_key='channel:Talabat:TLB-1002'").get().n;
  assert.equal(orders,1);
  const again=await call(owner,'/api/channels/import',{method:'POST',body:JSON.stringify({channel:'Talabat',externalOrderId:'TLB-1002',service:'takeaway',lines:[{externalItemId:'TLB-LATTE',quantity:2}]})});
  assert.equal(again.status,201);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE idempotency_key='channel:Talabat:TLB-1002'").get().n,1,'replaying an import must not duplicate the order');
});

test('retry stays blocked until every external reference is mapped',async t=>{
  const {db,owner,call}=await server(t);
  await call(owner,'/api/channels/import',{method:'POST',body:JSON.stringify({channel:'Deliveroo',externalOrderId:'DR-2001',service:'delivery',lines:[{externalItemId:'DR-A',quantity:1},{externalItemId:'DR-B',quantity:1}]})});
  const exception=db.prepare("SELECT * FROM records WHERE module='mapping_exceptions' AND status='open'").get();
  await call(owner,'/api/channels/mappings',{method:'POST',body:JSON.stringify({channel:'Deliveroo',externalItemId:'DR-A',itemId:'bowl_outlet_downtown'})});
  const partial=await call(owner,`/api/channels/exceptions/${exception.id}/retry`,{method:'POST',body:JSON.stringify({version:1})});
  assert.equal(partial.status,409);
  assert.match(partial.body.error,/DR-B/);
  assert.equal(db.prepare("SELECT status FROM records WHERE id=?").get(exception.id).status,'open');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
});

test('unknown and cross-channel mappings are rejected; permission boundaries hold',async t=>{
  const {owner,cashier,call}=await server(t);
  assert.equal((await call(owner,'/api/channels/mappings',{method:'POST',body:JSON.stringify({channel:'Talabat',externalItemId:'X',itemId:'missing_item'})})).status,404);
  assert.equal((await call(owner,'/api/channels/mappings',{method:'POST',body:JSON.stringify({channel:'Talabat',externalItemId:'X',itemId:'latte_outlet_marina'})})).status,404,'cross-outlet menu item must not map');
  assert.equal((await call(cashier,'/api/channels/mappings',{method:'POST',body:JSON.stringify({channel:'Talabat',externalItemId:'Y',itemId:'latte_outlet_downtown'})})).status,403);
  assert.equal((await call(cashier,'/api/channels/exceptions',{})).status,403);
  assert.equal((await call(owner,'/api/channels/import',{method:'POST',body:JSON.stringify({channel:'Unknown',externalOrderId:'Z',service:'takeaway',lines:[{externalItemId:'a',quantity:1}]})})).status,400);
});
