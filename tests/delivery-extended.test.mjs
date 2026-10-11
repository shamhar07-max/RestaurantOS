import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createOrder,createRecord } from '../server/domain.mjs';
import { planRoute,routePlans,routeAction,routeBoard } from '../server/delivery-ext.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const tomorrow=()=>new Date(Date.now()+86400000).toISOString().slice(0,10);

test('ROUTE a route plan sequences a delivery by promised time and runs its lifecycle',()=>{
  const {db,ctx}=fixture();
  const order=createOrder(db,ctx,{service:'delivery',channel:'Direct',customer:'Maya',notes:'Ring bell',idempotencyKey:'delivery-order-1',lines:[{itemId:'burger_outlet_downtown',quantity:1}]});
  createRecord(db,ctx,'deliveries',{name:'Dispatch 1',orderId:order.id,driver:'Unassigned',address:'Marina Walk 12',zone:'Marina',promisedAt:`${tomorrow()}T12:00`,notes:'Gate code 44'});
  const route=planRoute(db,ctx,{name:'Route A',driver:'Bilal',zone:'Marina',date:tomorrow(),orderIds:[order.id]});
  assert.equal(route.status,'planned');assert.equal(route.stops.length,1);assert.equal(route.stops[0].sequence,1);
  assert.throws(()=>routeAction(db,ctx,route.id,{action:'dispatched',evidence:''}),/evidence is required/);
  const dispatched=routeAction(db,ctx,route.id,{action:'dispatched',evidence:'Left the kitchen'});
  assert.equal(dispatched.status,'dispatched');
  assert.throws(()=>routeAction(db,ctx,route.id,{action:'completed',evidence:''}),/evidence is required/);
  const done=routeAction(db,ctx,route.id,{action:'completed',evidence:'All dropped'});
  assert.equal(done.status,'completed');
  assert.equal(routePlans(db,ctx,tomorrow()).length,1);
  db.close();
});

test('ROUTE the board separates routed from unrouted deliveries',()=>{
  const {db,ctx}=fixture();
  const routed=createOrder(db,ctx,{service:'delivery',customer:'A',idempotencyKey:'delivery-order-2',lines:[{itemId:'latte_outlet_downtown',quantity:1}]});
  const unrouted=createOrder(db,ctx,{service:'delivery',customer:'B',idempotencyKey:'delivery-order-3',lines:[{itemId:'latte_outlet_downtown',quantity:1}]});
  createRecord(db,ctx,'deliveries',{name:'D1',orderId:routed.id,driver:'X',address:'One',zone:'Z',promisedAt:`${businessDate()}T10:00`,notes:'x'});
  createRecord(db,ctx,'deliveries',{name:'D2',orderId:unrouted.id,driver:'Y',address:'Two',zone:'Z',promisedAt:`${businessDate()}T11:00`,notes:'y'});
  planRoute(db,ctx,{name:'Route today',driver:'X',zone:'Z',date:businessDate(),orderIds:[routed.id]});
  const board=routeBoard(db,ctx,businessDate());
  assert.equal(board.counts.routes,1);assert.equal(board.counts.stops,1);assert.equal(board.counts.unrouted,1);
  assert.equal(board.unrouted[0].orderId,unrouted.id);
  db.close();
});

test('ROUTE non-delivery orders cannot be routed',()=>{
  const {db,ctx}=fixture();
  const order=createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_1',idempotencyKey:'dine-order-1',lines:[{itemId:'burger_outlet_downtown',quantity:1}]});
  assert.throws(()=>planRoute(db,ctx,{name:'Bad',driver:'X',zone:'Z',date:businessDate(),orderIds:[order.id]}),/delivery assignment before|delivery orders can be routed/);
  db.close();
});
