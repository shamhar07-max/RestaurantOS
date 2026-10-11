import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createOrder,orderDetail } from '../server/domain.mjs';
import { createBundleConfig,updateBundleConfig,suspendBundleConfig,bundleConfigs,bundleConfig } from '../server/bundles-ext.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const grillGroup=()=>({label:'Choose 2 mains',min:2,max:2,choices:[{itemId:'burger_outlet_downtown'},{itemId:'bowl_outlet_downtown'}]});

test('A mix-and-match bundle resolves a pick-2 set into priced component lines with stock and station handling',()=>{
  const {db,ctx}=fixture();
  const cfg=createBundleConfig(db,ctx,{name:'Pick Your Grill',price:9000,groups:[grillGroup()],evidence:'Launch bundle for grill counter'});
  assert.equal(cfg.version,1);
  assert.equal(cfg.groups[0].min,2);
  assert.equal(bundleConfigs(db,ctx).length,1);
  const order=createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_1',idempotencyKey:'bundle-order-1',lines:[{bundleId:cfg.id,selection:['burger_outlet_downtown','bowl_outlet_downtown'],quantity:1}]});
  assert.equal(order.total,9000);
  assert.equal(order.lines.length,2);
  assert.equal(order.lines.reduce((s,l)=>s+l.unit_price,0),9000);
  assert.ok(order.lines.every(l=>l.bundle&&l.bundle.name==='Pick Your Grill'&&l.bundle.item_id===cfg.id));
  assert.ok(order.lines.every(l=>l.name.startsWith('Pick Your Grill · ')));
  assert.equal(order.tasks.length,1,'Both grill picks share one kitchen task.');
  assert.ok(db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM reservations WHERE line_id=?').get(order.lines[0].id).n>0,'Component stock is reserved.');
  const detail=orderDetail(db,ctx,order.id);
  assert.ok(detail.lines.every(l=>l.bundle));
  db.close();
});

test('Bundle config validation blocks bad selections, stale edits and non-menu options',()=>{
  const {db,ctx}=fixture();
  const cfg=createBundleConfig(db,ctx,{name:'Pick Two',price:9000,groups:[grillGroup()],evidence:'Authorised launch'});
  assert.throws(()=>createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_2',idempotencyKey:'bundle-order-2',lines:[{bundleId:cfg.id,selection:['burger_outlet_downtown'],quantity:1}]}),/choose 2/);
  assert.throws(()=>createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_2',idempotencyKey:'bundle-order-3',lines:[{bundleId:cfg.id,selection:['burger_outlet_downtown','burger_outlet_downtown'],quantity:1}]}),/picked twice/);
  assert.throws(()=>createBundleConfig(db,ctx,{name:'Bad',price:1000,groups:[{label:'G',min:1,max:1,choices:[{itemId:'nope_outlet_downtown'}]}],evidence:'invalid option test'}),/not a menu item/);
  const updated=updateBundleConfig(db,ctx,cfg.id,{version:1,price:8500,evidence:'Price review'});
  assert.equal(updated.version,2);
  assert.equal(updated.price,8500);
  assert.throws(()=>updateBundleConfig(db,ctx,cfg.id,{version:1,price:8000,evidence:'Stale edit'}),/changed on another screen/);
  const suspended=suspendBundleConfig(db,ctx,cfg.id,{version:2,evidence:'End of promo'});
  assert.equal(suspended.status,'suspended');
  assert.throws(()=>createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_2',idempotencyKey:'bundle-order-4',lines:[{bundleId:cfg.id,selection:['burger_outlet_downtown','bowl_outlet_downtown'],quantity:1}]}),/suspended/);
  assert.throws(()=>updateBundleConfig(db,ctx,cfg.id,{version:2,name:'Nope',evidence:'suspended edit test'}),/re-activated/);
  const cashier={...ctx,user:{id:'user_demo_cashier',role:'cashier',outlet_ids:['outlet_downtown']}};
  assert.throws(()=>createBundleConfig(db,cashier,{name:'Rogue',price:1000,groups:[grillGroup()],evidence:'rogue config test'}),/manager or owner/);
  db.close();
});