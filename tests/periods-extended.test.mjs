import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createOrder,pay } from '../server/domain.mjs';
import { closeFiscalPeriod,fiscalPeriods } from '../server/finance-ext.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};

test('Closing an archived past period records the close without blocking current operations',()=>{
  const {db,ctx}=fixture();
  const archived=closeFiscalPeriod(db,ctx,{startDate:'2020-01-01',endDate:'2020-01-31',reason:'Archive older accounting dates',evidence:'Month-end archive by accountant'});
  assert.equal(archived.closed,31);
  assert.equal(archived.nextOpen,'2020-02-01');
  const report=fiscalPeriods(db,ctx);
  assert.equal(report.closedDates.length,31);
  assert.ok(report.closedDates.includes('2020-01-15'));
  // today's operations still post
  const order=createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_1',idempotencyKey:'period-keep-order',lines:[{itemId:'burger_outlet_downtown',quantity:1}]});
  pay(db,ctx,order.id,{amount:order.total,method:'bank_recorded',reference:'BANK-PERIOD-1',idempotencyKey:'pay-period-0001'});
  db.close();
});

test('Closing a period covering the business date freezes posting from then on',()=>{
  const {db,ctx}=fixture();
  const today=businessDate();
  const result=closeFiscalPeriod(db,ctx,{endDate:today,reason:'Final close at end of service',evidence:'Owner and accountant sign-off'});
  assert.equal(result.closed,1);
  assert.throws(()=>closeFiscalPeriod(db,ctx,{endDate:today,reason:'Repeat close',evidence:'repeat close evidence'}),/already closed/);
  assert.throws(()=>createOrder(db,ctx,{service:'dine_in',tableId:'table_outlet_downtown_1',idempotencyKey:'period-blocked-order',lines:[{itemId:'burger_outlet_downtown',quantity:1}]}),/financially closed/);
  const cashier={...ctx,user:{id:'user_demo_cashier',role:'cashier',outlet_ids:['outlet_downtown']}};
  assert.throws(()=>closeFiscalPeriod(db,cashier,{endDate:today,reason:'Cashier close attempt',evidence:'cashier evidence'}),/owner or accountant/);
  db.close();
});