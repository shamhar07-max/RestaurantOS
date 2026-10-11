import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createOrder,orderDetail } from '../server/domain.mjs';
import { shareLineAcrossSeats,lineSeatShares,splitBySeat } from '../server/service.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};

test('ORD-13 a shared item is apportioned per unit across seats before a by-seat split',()=>{
  const {db,ctx}=fixture();
  const order=createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_2',customer:'Party of three',idempotencyKey:'seat-order-1',lines:[
    {itemId:'burger_outlet_downtown',quantity:2,seat:1},
    {itemId:'latte_outlet_downtown',quantity:2,seat:2},
    {itemId:'bowl_outlet_downtown',quantity:2,seat:0},
  ]});
  const shared=order.lines.find(l=>l.item_id==='bowl_outlet_downtown');
  assert.throws(()=>shareLineAcrossSeats(db,ctx,order.id,{lineId:shared.id,shares:[{seat:1,quantity:1},{seat:2,quantity:2}],reason:'Bad split'}),/sum to the line quantity/);
  shareLineAcrossSeats(db,ctx,order.id,{lineId:shared.id,shares:[{seat:1,quantity:1},{seat:2,quantity:1}],reason:'Starter shared between the diners'});
  const shares=lineSeatShares(db,ctx,order.id);
  assert.deepEqual(shares.map(s=>[s.seat,s.quantity]),[[1,1],[2,1]]);
  const parts=splitBySeat(db,ctx,order.id,{reason:'Split by seat including the shared starter'});
  assert.equal(parts.length,2);
  assert.equal(parts.reduce((s,p)=>s+p.amount,0),order.total);
  assert.ok(parts.every(p=>p.amount>0));
  assert.ok(parts.find(p=>p.name==='Seat 1').amount>parts.find(p=>p.name==='Seat 2').amount);
  assert.equal(orderDetail(db,ctx,order.id).splits.length,2);
  db.close();
});

test('ORD-13 seat shares cannot be added after payment or splitting',()=>{
  const {db,ctx}=fixture();
  const order=createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_3',idempotencyKey:'seat-order-2',lines:[{itemId:'burger_outlet_downtown',quantity:2,seat:1},{itemId:'latte_outlet_downtown',quantity:1,seat:2}]});
  const line=order.lines[0];
  assert.throws(()=>shareLineAcrossSeats(db,ctx,order.id,{lineId:line.id,shares:[{seat:1,quantity:1},{seat:2,quantity:2}],reason:'Shared burger'}),/sum to the line quantity/);
  shareLineAcrossSeats(db,ctx,order.id,{lineId:line.id,shares:[{seat:1,quantity:1},{seat:2,quantity:1}],reason:'Shared burger'});
  splitBySeat(db,ctx,order.id,{reason:'Seat split'});
  assert.throws(()=>shareLineAcrossSeats(db,ctx,order.id,{lineId:line.id,shares:[{seat:1,quantity:1},{seat:2,quantity:1}],reason:'Too late'}),/before payment or bill splitting/);
  db.close();
});
