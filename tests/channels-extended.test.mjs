import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createOrder,createRecord } from '../server/domain.mjs';
import { publishMenu,listPublications,setStationCapacity,stationCapacityReport,matchChannelSettlement,settlementOrders } from '../server/channels.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const order=(ctx,channel,quantity,key,itemId='burger_outlet_downtown')=>({service:'takeaway',channel,customer:'Test',idempotencyKey:key,lines:[{itemId,quantity}]});

async function server(t){
  const {db,ctx}=fixture();
  const app=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');
  await new Promise(resolve=>app.once('listening',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const signIn=async r=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:r})});const session=await res.json();return {headers:{'cookie':res.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'x-outlet-id':'outlet_downtown'}};};
  const call=async(session,path,options={})=>{const res=await fetch(base+path,{...options,headers:{...session.headers,...(options.headers||{})}});return {status:res.status,body:await res.json()};};
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));db.close();});
  return {db,ctx,base,owner:await signIn('owner'),cashier:await signIn('cashier'),call};
}

test('ORD-14 multi-brand publishing reports the channels that failed without blocking the rest',()=>{
  const {db,ctx}=fixture();
  const result=publishMenu(db,ctx,{brand:'Fig & Pear',note:'Winter menu',channels:[{channel:'Talabat',itemIds:['burger_outlet_downtown','latte_outlet_downtown']},{channel:'Deliveroo',itemIds:['burger_outlet_downtown','missing_item_x']},{channel:'Careem',itemIds:['espresso_outlet_downtown']}]});
  assert.deepEqual(result.published,['Talabat','Careem']);
  assert.equal(result.failed.length,1);assert.equal(result.failed[0].channel,'Deliveroo');assert.match(result.failed[0].reason,/missing_item_x/);
  const publications=listPublications(db,ctx);
  assert.equal(publications.length,2);
  assert.equal(publications.find(p=>p.channel==='Talabat').item_count,2);
  assert.throws(()=>publishMenu(db,ctx,{brand:'Fig & Pear',channels:[{channel:'Talabat',itemIds:['burger_outlet_downtown']},{channel:'Talabat',itemIds:['latte_outlet_downtown']}]}),/once per publication/);
  db.close();
});

test('ORD-15 station capacity is shared between brands and throttles new orders',()=>{
  const {db,ctx}=fixture();
  setStationCapacity(db,ctx,{station:'grill',brand:'*',capacity:5});
  const report=stationCapacityReport(db,ctx);
  const grill=report.stations.find(s=>s.station==='grill');
  assert.equal(grill.capacity,5);assert.equal(grill.load,0);assert.equal(grill.shared,true);
  createOrder(db,ctx,order(ctx,'POS',5,'cap-key-0001'));
  assert.equal(stationCapacityReport(db,ctx).stations.find(s=>s.station==='grill').load,5);
  assert.throws(()=>createOrder(db,ctx,order(ctx,'Direct',1,'cap-key-0002')),/at capacity/);
  createOrder(db,ctx,order(ctx,'POS',2,'cap-key-0003','latte_outlet_downtown')); // different station, still permitted
  db.close();
});

test('ORD-16 a settlement is matched against the actual channel orders',()=>{
  const {db,ctx}=fixture();
  const first=createOrder(db,ctx,order(ctx,'Talabat',2,'set-key-0001'));
  const second=createOrder(db,ctx,order(ctx,'Talabat',1,'set-key-0002'));
  createOrder(db,ctx,order(ctx,'POS',3,'set-key-0003'));
  const gross=first.total+second.total;
  const settlement=createRecord(db,ctx,'settlements',{name:'Talabat weekly',channel:'Talabat',gross,refunds:0,discounts:0,commission:0,adjustments:0,payout:gross,notes:'Provider statement WS-1'});
  const matched=matchChannelSettlement(db,ctx,settlement.id,{date:businessDate(),evidence:'Statement WS-1 reconciled'});
  assert.equal(matched.actualGross,gross);assert.equal(matched.actualOrders,2);assert.equal(matched.variance,0);
  const rows=settlementOrders(db,ctx,settlement.id);
  assert.equal(rows.orders.length,2);assert.equal(rows.matchVariance,0);
  const wrong=createRecord(db,ctx,'settlements',{name:'Talabat weekly 2',channel:'Talabat',gross:gross+500,refunds:0,discounts:0,commission:0,adjustments:0,payout:gross+500,notes:'Provider statement WS-2'});
  const mismatched=matchChannelSettlement(db,ctx,wrong.id,{date:businessDate(),evidence:'Statement WS-2 checked'});
  assert.equal(mismatched.variance,-500);
  db.close();
});

test('ORD-14/15/16 endpoints enforce channel and finance permissions over HTTP',async t=>{
  const {owner,cashier,call}=await server(t);
  const published=await call(owner,'/api/channels/publications',{method:'POST',body:JSON.stringify({brand:'Fig & Pear',channels:[{channel:'Talabat',itemIds:['burger_outlet_downtown']}]})});
  assert.equal(published.status,201);assert.deepEqual(published.body.published,['Talabat']);
  assert.equal((await call(cashier,'/api/channels/publications',{})).status,403);
  const capacity=await call(owner,'/api/channels/capacity',{method:'POST',body:JSON.stringify({station:'grill',brand:'*',capacity:50})});
  assert.equal(capacity.status,200);assert.equal(capacity.body.capacity,50);
  const report=await call(owner,'/api/channels/capacity',{});
  assert.equal(report.status,200);assert.ok(report.body.stations.find(s=>s.station==='grill').capacity===50);
});
