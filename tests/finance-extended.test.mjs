import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createOrder,createRecord,recordAction,pay,orderDetail } from '../server/domain.mjs';
import { issueInvoice,issueCreditNote,listInvoices,ageingReport,giftCardLedger,recordChargeback,correctClosedTill,depositTerms,setDepositTerms,forfeitDeposit } from '../server/finance-ext.mjs';
import { redeemOrder } from '../server/customers-ext.mjs';
import { receiveDeposit } from '../server/hospitality.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const tomorrow=()=>new Date(Date.now()+86400000).toISOString().slice(0,10);
const burger=db=>createOrder(db,{user:{id:'user_owner',role:'owner',outlet_ids:['outlet_downtown']},tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'},{service:'dine_in',tableId:'table_outlet_downtown_1',idempotencyKey:`ord-${Math.random()}`,lines:[{itemId:'burger_outlet_downtown',quantity:1}]});
const ownerCtx=ctx=>ctx;

test('CORE-12 a legal tax invoice is numbered sequentially with a VAT breakdown and can be credited',()=>{
  const {db,ctx}=fixture();
  const order=burger(db);
  const inv=issueInvoice(db,ctx,{orderId:order.id,buyer:'Acme Events',buyerTaxNumber:'100123456700003',evidence:'Customer requested a tax invoice'});
  assert.match(inv.number,/^INV-\d{4}-\d{5}$/);
  assert.equal(inv.net+inv.tax,inv.total);assert.equal(inv.total,order.total);
  assert.equal(inv.payload.seller.name,'Fig & Pear Hospitality LLC');
  const second=issueInvoice(db,ctx,{orderId:burger(db).id,buyer:'Second Buyer',evidence:'Second invoice'});
  assert.notEqual(second.number,inv.number);
  assert.equal(listInvoices(db,ctx).length,2);
  const credit=issueCreditNote(db,ctx,{invoiceId:inv.id,amount:Math.round(inv.total/2),reason:'Goodwill on service delay',evidence:'Manager approved credit'});
  assert.match(credit.number,/^CN-\d{4}-\d{5}$/);
  assert.equal(credit.total,Math.round(inv.total/2));
  assert.throws(()=>issueCreditNote(db,ctx,{invoiceId:inv.id,amount:inv.total*10,reason:'Too much',evidence:'x'}),/cannot exceed the invoice total/);
  db.close();
});

test('CORE-12 accounts ageing buckets payables and receivables by due date',()=>{
  const {db,ctx}=fixture();
  const order=burger(db); // unpaid -> receivable today
  createRecord(db,ctx,'bills',{name:'INV-500',supplierId:'supplier_green',purchaseId:'purchase_demo',amount:1000,tax:0,dueDate:'2020-01-01',notes:'Old supplier bill'});
  const report=ageingReport(db,ctx);
  assert.equal(report.payables.buckets.over_90,1000);
  assert.equal(report.payables.total,1000);
  assert.equal(report.receivables.buckets.current,order.total);
  assert.equal(report.receivables.total,order.total);
  db.close();
});

test('CORE-12 the gift-card ledger reconciles issued, redeemed and outstanding liability',()=>{
  const {db,ctx}=fixture();
  createRecord(db,ctx,'gift_cards',{name:'Staff gift',code:'GC-100',initialValue:10000,expiresAt:tomorrow(),notes:'Sold at reception'});
  let ledger=giftCardLedger(db,ctx);
  assert.equal(ledger.totals.liability,10000);assert.equal(ledger.totals.redeemed,0);
  const order=burger(db);
  redeemOrder(db,ctx,order.id,{kind:'gift_card',code:'GC-100',reason:'Redeemed at the till',idempotencyKey:`redeem-${order.id}`});
  ledger=giftCardLedger(db,ctx);
  assert.equal(ledger.totals.redeemed,4200);assert.equal(ledger.totals.liability,5800);
  assert.equal(ledger.movements.length,1);assert.equal(ledger.movements[0].amount,4200);
  db.close();
});

test('CORE-12 a card chargeback posts a loss and reconciles to the original payment',()=>{
  const {db,ctx}=fixture();
  const order=burger(db);
  const paid=pay(db,ctx,order.id,{amount:order.total,method:'bank_recorded',reference:'BANK-777',idempotencyKey:`pay-${order.id}`});
  const paymentId=paid.payments[0].id;
  const cb=recordChargeback(db,ctx,{reference:'CB-01',paymentId,amount:order.total,reason:'Cardholder dispute',evidence:'Acquirer notice',idempotencyKey:'cbkey-01'});
  assert.equal(cb.status,'recorded');assert.equal(cb.amount,order.total);
  const again=recordChargeback(db,ctx,{reference:'CB-01',paymentId,amount:order.total,reason:'Retry',evidence:'Acquirer notice',idempotencyKey:'cbkey-01'});
  assert.equal(again.id,cb.id,'idempotent');
  const lines=db.prepare('SELECT account,debit,credit FROM journal_lines WHERE journal_id=(SELECT id FROM journals WHERE origin=?)').all(cb.id);
  assert.deepEqual(lines.map(l=>l.account).sort(),['Bank','Chargeback loss']);
  db.close();
});

test('CORE-12 a closed till accepts only a finance correction with evidence',()=>{
  const {db,ctx}=fixture();
  const till=createRecord(db,ctx,'tills',{name:'Morning float',opening:5000,notes:'Balanced'});
  recordAction(db,ctx,till.id,{action:'closed',version:till.version,counted:5000,reason:'Counted by cashier'});
  const correction=correctClosedTill(db,ctx,till.id,{type:'cash_over',amount:1000,reason:'Late cash found',evidence:'Reconciliation sheet',idempotencyKey:'tcorr-key-1'});
  assert.equal(correction.type,'cash_over');assert.equal(correction.amount,1000);
  const other=createRecord(db,ctx,'tills',{name:'Open float',opening:2000,notes:'Open'});
  assert.throws(()=>correctClosedTill(db,ctx,other.id,{type:'cash_short',amount:100,reason:'Not closed',evidence:'x',idempotencyKey:'tcorr-key-2'}),/closed till/);
  db.close();
});

test('CORE-12 deposit forfeiture is capped by configured no-show terms',()=>{
  const {db,ctx}=fixture();
  const booking=createRecord(db,ctx,'reservations',{name:'Rania',phone:'+971500000000',tableId:'table_outlet_downtown_1',partySize:2,startsAt:`${tomorrow()}T19:00`,endsAt:`${tomorrow()}T21:00`,notes:'Window seat'});
  receiveDeposit(db,ctx,booking.id,{amount:10000,method:'bank_recorded',reference:'BANK-DEP-1',reason:'Booking deposit',idempotencyKey:'depkey-001'});
  setDepositTerms(db,ctx,{noShowPercent:25,cancellationFee:0,evidence:'Owner approved deposit terms'});
  assert.equal(depositTerms(db,ctx).noShowPercent,25);
  assert.throws(()=>forfeitDeposit(db,ctx,booking.id,{amount:3000,reason:'No-show',evidence:'Front desk log',idempotencyKey:'forfeit-key-1'}),/limited to 2500/);
  const forfeited=forfeitDeposit(db,ctx,booking.id,{amount:2500,reason:'No-show',evidence:'Front desk log',idempotencyKey:'forfeit-key-1'});
  assert.equal(forfeited.amount,2500);assert.equal(forfeited.action,'forfeit');
  db.close();
});
