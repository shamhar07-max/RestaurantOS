import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { createOrder,createRecord,recordAction,pay,orderDetail } from '../server/domain.mjs';
import { recoverComplaint,redeemOrder,orderRedemptions } from '../server/customers-ext.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const order=(ctx,key,itemId='burger_outlet_downtown',quantity=1)=>({service:'takeaway',channel:'POS',customer:'Test',idempotencyKey:key,lines:[{itemId,quantity}]});

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

test('ORD-17 recovery links a replacement order and resolves the complaint',()=>{
  const {db,ctx}=fixture();
  const original=createOrder(db,ctx,order(ctx,'rec-key-0001'));
  const replacement=createOrder(db,ctx,order(ctx,'rec-key-0002','latte_outlet_downtown'));
  const complaint=createRecord(db,ctx,'complaints',{name:'Cold meal',customer:'Nadia',orderId:original.id,notes:'Guest reported a cold main course'});
  const resolved=recoverComplaint(db,ctx,complaint.id,{resolution:'replacement',orderId:original.id,replacementOrderId:replacement.id,evidence:'Replacement flat white issued free of charge'});
  assert.equal(resolved.status,'resolved');
  assert.equal(resolved.data.recoveries.length,1);
  assert.equal(resolved.data.recoveries[0].replacement.orderId,replacement.id);
  assert.equal(resolved.data.recoveries[0].originalOrderId,original.id);
  assert.throws(()=>recoverComplaint(db,ctx,complaint.id,{resolution:'goodwill',points:50,evidence:'Again'}),/already resolved/);
  db.close();
});

test('ORD-17 a refund recovery runs through the controlled refund path',()=>{
  const {db,ctx}=fixture();
  const placed=createOrder(db,ctx,order(ctx,'rec-key-0003'));
  const paid=pay(db,ctx,placed.id,{amount:placed.total,method:'cash',idempotencyKey:'pay-key-0003'});
  const complaint=createRecord(db,ctx,'complaints',{name:'Wrong dish',customer:'Omar',orderId:placed.id,notes:'Wrong dish delivered'});
  const resolved=recoverComplaint(db,ctx,complaint.id,{resolution:'refund',orderId:placed.id,paymentId:paid.payments[0].id,amount:paid.total,evidence:'Full refund agreed with the guest'});
  assert.equal(resolved.data.recoveries[0].refund.amount,placed.total);
  assert.equal(orderDetail(db,ctx,placed.id).refunded,placed.total);
  db.close();
});

test('ORD-18 a coupon discounts the order once and honours its redemption limit',()=>{
  const {db,ctx}=fixture();
  const coupon=createRecord(db,ctx,'coupons',{name:'Welcome',code:'welcome10',type:'percent',value:10,minSpend:0,maxRedemptions:1,expiresAt:'2099-01-01',notes:'Launch promotion'});
  assert.equal(coupon.data.code,'WELCOME10');
  recordAction(db,ctx,coupon.id,{action:'active',version:coupon.version,reason:'Launch'});
  const placed=createOrder(db,ctx,order(ctx,'coupon-key-0001',undefined,2));
  const discounted=redeemOrder(db,ctx,placed.id,{kind:'coupon',code:'welcome10',reason:'Guest applied promo',idempotencyKey:'red-coupon-0001'});
  const expected=placed.total-Math.round(placed.total*10/100);
  assert.equal(discounted.total,expected);
  const replay=redeemOrder(db,ctx,placed.id,{kind:'coupon',code:'WELCOME10',reason:'Guest applied promo',idempotencyKey:'red-coupon-0001'});
  assert.equal(replay.total,expected,'a replay of the same key is idempotent');
  assert.equal(orderRedemptions(db,ctx,placed.id).length,1);
  const other=createOrder(db,ctx,order(ctx,'coupon-key-0002'));
  assert.throws(()=>redeemOrder(db,ctx,other.id,{kind:'coupon',code:'WELCOME10',reason:'Second use',idempotencyKey:'red-coupon-0002'}),/redemption limit/);
  db.close();
});

test('ORD-18 gift-card redemption is a tender that depletes the balance',()=>{
  const {db,ctx}=fixture();
  const card=createRecord(db,ctx,'gift_cards',{name:'Gift for Sara',code:'gc-100',initialValue:100,expiresAt:'2099-01-01',notes:'Sold at reception'});
  assert.equal(card.data.code,'GC-100');assert.equal(card.data.balance,100);
  assert.throws(()=>createRecord(db,ctx,'gift_cards',{name:'Dup',code:'GC-100',initialValue:50,expiresAt:'2099-01-01',notes:'x'}),/already exists/);
  const placed=createOrder(db,ctx,order(ctx,'gc-key-0001',undefined,2));
  const redeemed=redeemOrder(db,ctx,placed.id,{kind:'gift_card',code:'GC-100',reason:'Gift card presented',idempotencyKey:'red-gc-0001'});
  assert.equal(redeemed.paid,100);
  assert.equal(redeemed.due,redeemed.total-100);
  const depleted=db.prepare("SELECT * FROM records WHERE id=?").get(card.id);
  assert.equal(depleted.status,'depleted');assert.equal(JSON.parse(depleted.data).balance,0);
  const fresh=createOrder(db,ctx,order(ctx,'gc-key-0002'));
  assert.throws(()=>redeemOrder(db,ctx,fresh.id,{kind:'gift_card',code:'GC-100',reason:'Again',idempotencyKey:'red-gc-0002'}),/not active/);
  db.close();
});

test('ORD-17/18 endpoints enforce recovery, coupon and redemption permissions',async t=>{
  const {owner,cashier,call}=await server(t);
  const coupon=await call(owner,'/api/records/coupons',{method:'POST',body:JSON.stringify({name:'Welcome',code:'WELCOME10',type:'percent',value:10,minSpend:0,maxRedemptions:0,expiresAt:'2099-01-01',notes:'x'})});
  assert.equal(coupon.status,201);
  const activated=await call(owner,`/api/records/${coupon.body.id}/action`,{method:'POST',body:JSON.stringify({action:'active',version:coupon.body.version,reason:'Launch'})});
  assert.equal(activated.status,200);
  assert.equal((await call(cashier,'/api/records/coupons',{method:'POST',body:JSON.stringify({name:'x',code:'cashier',type:'amount',value:100,minSpend:0,maxRedemptions:0,expiresAt:'2099-01-01',notes:'x'})})).status,403);
  const placed=await call(owner,'/api/orders',{method:'POST',body:JSON.stringify({service:'takeaway',channel:'POS',customer:'Test',idempotencyKey:'http-key-0001',lines:[{itemId:'burger_outlet_downtown',quantity:1}]})});
  assert.equal(placed.status,201);
  const redeemed=await call(cashier,`/api/orders/${placed.body.id}/redemptions`,{method:'POST',body:JSON.stringify({kind:'coupon',code:'WELCOME10',reason:'Promo',idempotencyKey:'http-red-0001'})});
  assert.equal(redeemed.status,200);assert.ok(redeemed.body.total<placed.body.total);
  const complaint=await call(owner,'/api/records/complaints',{method:'POST',body:JSON.stringify({name:'Service',customer:'Guest',orderId:placed.body.id,notes:'x'})});
  assert.equal(complaint.status,201);
  const recovered=await call(owner,`/api/customers/complaints/${complaint.body.id}/recover`,{method:'POST',body:JSON.stringify({resolution:'goodwill',points:100,evidence:'Loyalty points as goodwill'})});
  assert.equal(recovered.status,200);assert.equal(recovered.body.status,'resolved');
});
