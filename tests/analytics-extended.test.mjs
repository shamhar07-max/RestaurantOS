import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createOrder } from '../server/domain.mjs';
import { backtestForecast,forecastDemand,operationalVariance } from '../server/analytics-ext.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const dayOffset=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);

test('ANALYTICS a moving-average forecast backtest measures its own error',()=>{
  const {db,ctx}=fixture();
  const series=Array.from({length:20},(_,i)=>({date:dayOffset(i-19),quantity:10+(i%3)}));
  const backtest=backtestForecast(db,ctx,{window:7,horizon:1,series});
  assert.equal(backtest.samples,13);assert.equal(backtest.predictions.length,13);
  assert.equal(typeof backtest.mape,'number');assert.ok(backtest.mape>=0);
  assert.throws(()=>backtestForecast(db,ctx,{window:30,horizon:5,series}),/periods of history/);
  db.close();
});

test('ANALYTICS demand forecast derives a baseline from recorded sales history',()=>{
  const {db,ctx}=fixture();
  for(let i=0;i<3;i++){const o=createOrder(db,ctx,{service:'takeaway',customer:'x',idempotencyKey:`fc-order-${i}`,lines:[{itemId:'burger_outlet_downtown',quantity:i+1}]});db.prepare('UPDATE orders SET business_date=? WHERE id=?').run(dayOffset(-(i+1)),o.id);}
  const forecast=forecastDemand(db,ctx,{itemId:'burger_outlet_downtown',window:3,horizon:2});
  assert.equal(forecast.base,2);assert.equal(forecast.predictions.length,2);
  assert.equal(forecast.predictions[0].date,dayOffset(0));
  db.close();
});

test('ANALYTICS operational variance separates contribution, waste, labour and delays',()=>{
  const {db,ctx}=fixture();
  const order=createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_1',idempotencyKey:'var-order-1',lines:[{itemId:'burger_outlet_downtown',quantity:1}]});
  const variance=operationalVariance(db,ctx,{from:businessDate(),to:businessDate()});
  assert.equal(variance.netSales,order.net);
  assert.equal(variance.foodCost,0);
  assert.equal(variance.contribution,order.net);
  assert.equal(variance.labourHours,8,'seed shift is 14:00 to 22:00 today');
  assert.equal(variance.delayCount,0);
  assert.equal(variance.contributionMargin,100);
  db.close();
});
