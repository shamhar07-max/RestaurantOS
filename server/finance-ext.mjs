import { z } from 'zod';
import { id,now,businessDate,transaction,audit,journal } from './db.mjs';
import { assert,permit,getRecord,orderDetail,taxPolicy } from './domain.mjs';

// CORE-12 / finance completion — legal invoice & credit-note documents with
// sequential numbering and VAT breakdown, accounts ageing, a gift-card
// liability ledger, chargebacks, closed-till corrections and configurable
// deposit forfeiture terms. Documents never re-post revenue already recognised
// on the underlying sale; the ledger effect stays with the sale/refund journal.
const key=z.string().min(8).max(160);
const text=z.string().max(4000);
const dayMs=86400000;
const pad=n=>String(n).padStart(5,'0');
const sellerOf=(db,ctx)=>{const e=db.prepare('SELECT name,tax_number FROM entities WHERE id=?').get(ctx.entityId)||{};const o=db.prepare('SELECT name FROM outlets WHERE id=?').get(ctx.outletId)||{};return {name:e.name||'Entity',outlet:o.name||'',taxNumber:e.tax_number||''};};

export function listInvoices(db,ctx,query={}){
  permit(ctx,'finance','read');
  const where=["tenant_id=? AND outlet_id=?"],args=[ctx.tenantId,ctx.outletId];
  if(query.kind){where.push('kind=?');args.push(query.kind);}
  return db.prepare(`SELECT * FROM invoices WHERE ${where.join(' AND ')} ORDER BY issued_at DESC LIMIT 300`).all(...args).map(r=>({...r,payload:JSON.parse(r.payload)}));
}
export function issueInvoice(db,ctx,input){
  permit(ctx,'finance');assert(['owner','accountant'].includes(ctx.user.role),'Only finance can issue legal invoices.',403);
  const body=z.object({orderId:z.string().optional(),contractId:z.string().optional(),buyer:z.string().trim().max(200).optional(),buyerTaxNumber:z.string().trim().max(60).default(''),evidence:text.min(1)}).strict().parse(input);
  assert(!(body.orderId&&body.contractId),'Issue an invoice for an order or a contract period, not both.');
  assert(body.orderId||body.contractId,'Provide the order or contract period to invoice.');
  return transaction(db,()=>{
    const seller=sellerOf(db,ctx);let net,tax,total,buyer,orderId=null,contractId=null,lines;
    if(body.orderId){
      const order=orderDetail(db,ctx,body.orderId);assert(!['cancelled'].includes(order.status),'A cancelled order cannot be invoiced.',409);
      net=order.net;tax=order.tax;total=order.total;buyer=body.buyer||order.customer||'Walk-in guest';orderId=order.id;
      lines=order.lines.map(l=>({description:`${l.name} × ${l.quantity}`,quantity:l.quantity,unitPrice:l.unit_price,amount:l.unit_price*l.quantity}));
    } else {
      const contract=getRecord(db,ctx,body.contractId);assert(contract.module==='contracts','Contract not found.',404);
      assert(contract.status==='period_closed'&&contract.data.invoice,'Close the contract period before issuing its invoice.',409);
      const inv=contract.data.invoice;net=inv.net;tax=inv.tax;total=inv.total;buyer=body.buyer||contract.data.payer||'Payer';contractId=contract.id;
      lines=[{description:`${contract.data.name} · ${inv.units} units @ ${inv.rate||inv.rate||''}`,quantity:inv.units,amount:net}];
    }
    const taxPercent=net>0?Math.round(tax/net*100):0;assert(taxPercent>0||tax===0,'Invoice tax could not be derived.');
    const seq=db.prepare("SELECT COUNT(*) n FROM invoices WHERE tenant_id=? AND outlet_id=? AND kind='tax_invoice'").get(ctx.tenantId,ctx.outletId).n+1;
    const number=`INV-${businessDate().slice(0,4)}-${pad(seq)}`;
    const invoiceId=id('inv');
    const payload={seller,buyer:{name:buyer,taxNumber:body.buyerTaxNumber||''},lines,net,tax,total,taxPercent,currency:'AED',priceBasis:'VAT inclusive',evidence:body.evidence,issuedBy:ctx.user.name};
    db.prepare('INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(invoiceId,ctx.tenantId,ctx.outletId,'tax_invoice',number,businessDate(),orderId,contractId,buyer,body.buyerTaxNumber||'',seller.taxNumber,net,tax,total,'issued',now(),JSON.stringify(payload));
    audit(db,ctx,'invoice.issued',invoiceId,{number,orderId,contractId,total});
    return listInvoices(db,ctx).find(i=>i.id===invoiceId);
  });
}
export function issueCreditNote(db,ctx,input){
  permit(ctx,'finance');assert(['owner','accountant'].includes(ctx.user.role),'Only finance can issue credit notes.',403);
  const body=z.object({invoiceId:z.string().optional(),orderId:z.string().optional(),amount:z.number().int().positive().max(1_000_000_000),reason:text.min(3),buyerTaxNumber:z.string().trim().max(60).default(''),evidence:text.min(1)}).strict().parse(input);
  assert(body.invoiceId||body.orderId,'Reference the invoice or order being credited.');
  return transaction(db,()=>{
    const seller=sellerOf(db,ctx);let net,tax,total=body.amount,buyer='Buyer',orderId=body.orderId||null,contractId=null;
    if(body.invoiceId){
      const inv=db.prepare('SELECT * FROM invoices WHERE id=? AND tenant_id=? AND outlet_id=?').get(body.invoiceId,ctx.tenantId,ctx.outletId);assert(inv,'Invoice not found.',404);
      assert(body.amount<=inv.total,'A credit note cannot exceed the invoice total.',409);
      net=Math.round(body.amount*inv.net/inv.total);tax=body.amount-net;buyer=inv.buyer;orderId=inv.order_id;contractId=inv.contract_id;
    } else {
      const order=orderDetail(db,ctx,body.orderId);assert(body.amount<=order.total,'A credit note cannot exceed the order total.',409);
      net=Math.round(body.amount*order.net/order.total);tax=body.amount-net;buyer=order.customer||'Walk-in guest';
    }
    const seq=db.prepare("SELECT COUNT(*) n FROM invoices WHERE tenant_id=? AND outlet_id=? AND kind='credit_note'").get(ctx.tenantId,ctx.outletId).n+1;
    const number=`CN-${businessDate().slice(0,4)}-${pad(seq)}`;
    const creditId=id('cn');
    const payload={seller,buyer:{name:buyer,taxNumber:body.buyerTaxNumber||''},lines:[{description:body.reason,amount:body.amount}],net,tax,total,currency:'AED',evidence:body.evidence,issuedBy:ctx.user.name};
    db.prepare('INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(creditId,ctx.tenantId,ctx.outletId,'credit_note',number,businessDate(),orderId,contractId,buyer,body.buyerTaxNumber||'',seller.taxNumber,net,tax,total,'issued',now(),JSON.stringify(payload));
    audit(db,ctx,'credit_note.issued',creditId,{number,orderId,invoiceId:body.invoiceId||null,total});
    return listInvoices(db,ctx).find(i=>i.id===creditId);
  });
}

const bucketOf=(asOf,due)=>{if(!due)return 'current';const days=Math.floor((new Date(asOf)-new Date(due))/dayMs);if(days<=0)return 'current';if(days<=30)return '1_30';if(days<=60)return '31_60';if(days<=90)return '61_90';return 'over_90';};
export function ageingReport(db,ctx,asOf=businessDate()){
  permit(ctx,'finance','read');
  const empty=()=>({current:0,'1_30':0,'31_60':0,'61_90':0,'over_90':0});
  const payables=empty(),receivables=empty();let payableTotal=0,receivableTotal=0;
  for(const b of db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='bills' AND status IN ('draft','matched')").all(ctx.tenantId,ctx.outletId).map(r=>JSON.parse(r.data))){
    const bucket=bucketOf(asOf,b.dueDate);payables[bucket]+=b.amount;payableTotal+=b.amount;
  }
  for(const o of db.prepare("SELECT o.*,COALESCE(SUM(p.amount),0) paid FROM orders o LEFT JOIN payments p ON p.order_id=o.id AND p.status='recorded' WHERE o.tenant_id=? AND o.outlet_id=? AND o.status NOT IN ('cancelled','completed') GROUP BY o.id").all(ctx.tenantId,ctx.outletId)){
    const due=o.total-o.paid;if(due<=0)continue;const bucket=bucketOf(asOf,o.business_date);receivables[bucket]+=due;receivableTotal+=due;
  }
  return {asOf,payables:{buckets:payables,total:payableTotal},receivables:{buckets:receivables,total:receivableTotal}};
}

export function giftCardLedger(db,ctx){
  permit(ctx,'finance','read');
  const cards=db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='gift_cards'").all(ctx.tenantId,ctx.outletId).map(r=>({id:r.id,status:r.status,...JSON.parse(r.data)}));
  const movements=db.prepare("SELECT * FROM redemptions WHERE tenant_id=? AND outlet_id=? AND kind='gift_card' ORDER BY created_at DESC").all(ctx.tenantId,ctx.outletId);
  const liability=cards.filter(c=>c.status!=='void').reduce((s,c)=>s+(c.balance||0),0);
  const issued=cards.reduce((s,c)=>s+c.initialValue,0),redeemed=cards.reduce((s,c)=>s+(c.initialValue-(c.balance||0)),0);
  return {cards:cards.map(c=>({id:c.id,code:c.code,status:c.status,initialValue:c.initialValue,balance:c.balance||0,redeemed:c.initialValue-(c.balance||0)})),movements:movements.map(m=>({orderId:m.order_id,giftCardId:m.gift_card_id,amount:m.amount,at:m.created_at})),totals:{issued,redeemed,liability,vouchers:cards.length}};
}

export function recordChargeback(db,ctx,input){
  permit(ctx,'finance');assert(['owner','accountant'].includes(ctx.user.role),'Only finance can record a chargeback.',403);
  const body=z.object({reference:z.string().trim().min(1).max(200),settlementId:z.string().optional(),paymentId:z.string().optional(),amount:z.number().int().positive().max(1_000_000_000),reason:text.min(3),evidence:text.min(1),idempotencyKey:key}).strict().parse(input);
  return transaction(db,()=>{
    const prior=db.prepare('SELECT * FROM chargebacks WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);if(prior)return prior;
    assert(body.settlementId||body.paymentId,'Reference the settlement or payment being charged back.');
    if(body.paymentId)assert(db.prepare('SELECT id FROM payments WHERE id=? AND tenant_id=? AND outlet_id=?').get(body.paymentId,ctx.tenantId,ctx.outletId),'Payment not found.',404);
    if(body.settlementId)assert(getRecord(db,ctx,body.settlementId).module==='settlements','Settlement not found.',404);
    const cbId=id('cb');
    db.prepare('INSERT INTO chargebacks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(cbId,ctx.tenantId,ctx.outletId,body.reference,body.settlementId||null,body.paymentId||null,body.amount,body.reason,'recorded',body.evidence,ctx.user.id,body.idempotencyKey,now());
    journal(db,ctx,cbId,'chargeback',[{account:'Chargeback loss',debit:body.amount},{account:body.settlementId?'Channel receivable':'Bank',credit:body.amount}]);
    audit(db,ctx,'chargeback.recorded',cbId,{reference:body.reference,amount:body.amount});
    return db.prepare('SELECT * FROM chargebacks WHERE id=?').get(cbId);
  });
}

export function correctClosedTill(db,ctx,tillId,input){
  permit(ctx,'finance');assert(['owner','accountant'].includes(ctx.user.role),'Only finance can correct a closed till.',403);
  const body=z.object({type:z.enum(['cash_over','cash_short','bank_adjustment']),amount:z.number().int().positive().max(100_000_000),reason:text.min(3),evidence:text.min(1),idempotencyKey:key}).strict().parse(input);
  return transaction(db,()=>{
    const prior=db.prepare('SELECT * FROM till_corrections WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);if(prior)return prior;
    const till=getRecord(db,ctx,tillId);assert(till.module==='tills','Till not found.',404);assert(till.status==='closed','Only a closed till needs a finance correction.',409);
    const correctionId=id('tcorr');
    db.prepare('INSERT INTO till_corrections VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(correctionId,ctx.tenantId,ctx.outletId,till.id,body.type,body.amount,body.reason,body.evidence,ctx.user.id,body.idempotencyKey,now());
    const cash=body.type!=='bank_adjustment';
    const lines=body.type==='cash_over'?[{account:cash?'Cash':'Bank',debit:body.amount},{account:'Cash over / short',credit:body.amount}]
      :body.type==='cash_short'?[{account:'Cash over / short',debit:body.amount},{account:'Cash',credit:body.amount}]
      :[{account:'Bank',debit:body.amount},{account:'Bank adjustments',credit:body.amount}];
    journal(db,ctx,correctionId,'till_correction',lines);
    audit(db,ctx,'till.corrected',till.id,{correctionId,type:body.type,amount:body.amount,reason:body.reason});
    return db.prepare('SELECT * FROM till_corrections WHERE id=?').get(correctionId);
  });
}

export function depositTerms(db,ctx){
  const setting=db.prepare("SELECT value FROM settings WHERE tenant_id=? AND outlet_id=? AND key='depositTerms'").get(ctx.tenantId,ctx.outletId);
  const value=setting?JSON.parse(setting.value):{};
  return {noShowPercent:Number.isSafeInteger(value.noShowPercent)&&value.noShowPercent>=0&&value.noShowPercent<=100?value.noShowPercent:0,cancellationFee:Number.isSafeInteger(value.cancellationFee)&&value.cancellationFee>=0?value.cancellationFee:0,reviewed:!!value.reviewed};
}
export function setDepositTerms(db,ctx,input){
  permit(ctx,'settings');assert(ctx.user.role==='owner','Only an owner can set deposit terms.',403);
  const body=z.object({noShowPercent:z.number().int().nonnegative().max(100),cancellationFee:z.number().int().nonnegative().max(100_000_000),evidence:text.min(3)}).strict().parse(input);
  transaction(db,()=>{
    db.prepare("INSERT INTO settings(tenant_id,outlet_id,key,value) VALUES(?,?,?,?) ON CONFLICT(tenant_id,outlet_id,key) DO UPDATE SET value=excluded.value").run(ctx.tenantId,ctx.outletId,'depositTerms',JSON.stringify({...body,reviewed:true,changedAt:now()}));
    audit(db,ctx,'booking.deposit_terms_set',ctx.outletId,body);
    return depositTerms(db,ctx);
  });
}
export function forfeitDeposit(db,ctx,bookingId,input){
  permit(ctx,'tables');assert(['owner','manager'].includes(ctx.user.role),'Manager approval is required to forfeit a deposit.',403);
  const body=z.object({amount:z.number().int().positive().max(100_000_000),reason:text.min(3),evidence:text.min(1),idempotencyKey:key}).strict().parse(input);
  return transaction(db,()=>{
    const prior=db.prepare('SELECT * FROM deposit_movements WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);if(prior)return prior;
    assert(getRecord(db,ctx,bookingId).module==='reservations','Reservation not found.',404);
    const deposits=db.prepare('SELECT * FROM booking_deposits WHERE booking_id=?').all(bookingId);assert(deposits.length,'This booking has no deposit to forfeit.',409);
    const original=deposits.reduce((s,d)=>s+d.amount,0);
    const used=db.prepare("SELECT COALESCE(SUM(amount),0) n FROM deposit_movements WHERE deposit_id IN (SELECT id FROM booking_deposits WHERE booking_id=?) AND action IN ('apply','refund','forfeit')").get(bookingId).n;
    const unused=original-used;assert(unused>0,'The deposit has already been applied or refunded.',409);
    const terms=depositTerms(db,ctx);const maxForfeit=Math.max(Math.round(original*terms.noShowPercent/100),terms.cancellationFee);
    assert(maxForfeit>0,'Deposit terms do not permit a forfeiture. Configure the no-show percentage or cancellation fee.',409);
    assert(body.amount<=unused&&body.amount<=maxForfeit,`A forfeiture is limited to ${maxForfeit} fils by the configured terms.`,409);
    const mid=id('dmov');
    db.prepare('INSERT INTO deposit_movements VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(mid,ctx.tenantId,ctx.outletId,deposits[0].id,'forfeit',body.amount,null,null,body.reason,body.idempotencyKey,now());
    journal(db,ctx,mid,'deposit_forfeit',[{account:'Customer advances',debit:body.amount},{account:'Forfeited deposits',credit:body.amount}]);
    audit(db,ctx,'booking.deposit_forfeited',bookingId,{amount:body.amount,terms,evidence:body.evidence});
    return db.prepare('SELECT * FROM deposit_movements WHERE id=?').get(mid);
  });
}

// Fiscal period close — a manager/accountant finalises a contiguous date range
// (no later than the current business date). Posting for every closed date is
// blocked by the existing `journals` guard, exactly like an individually closed
// business date, so the accounting ledger can never change after the period.
const addDays=(date,days)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
export function closeFiscalPeriod(db,ctx,input){
  assert(['owner','accountant'].includes(ctx.user.role),'A period close requires the owner or accountant.',403);
  const body=z.object({startDate:z.iso.date().optional(),endDate:z.iso.date(),reason:text.min(3),evidence:text.min(3)}).strict().parse(input);
  return transaction(db,()=>{
    assert(body.endDate<=businessDate(),'Close accounting periods up to and including today only.',409);
    const currentMax=db.prepare("SELECT MAX(business_date) m FROM periods WHERE tenant_id=? AND outlet_id=? AND status='closed'").get(ctx.tenantId,ctx.outletId).m;
    assert(!currentMax||body.endDate>currentMax,'This period is already closed.',409);
    const from=body.startDate&&(!currentMax||body.startDate>currentMax)?body.startDate:(currentMax?addDays(currentMax,1):businessDate());
    assert(from<=body.endDate,'Choose a start date on or before the end date.',409);
    const openOrders=db.prepare("SELECT COUNT(*) n FROM orders WHERE tenant_id=? AND outlet_id=? AND business_date BETWEEN ? AND ? AND status NOT IN ('completed','cancelled')").get(ctx.tenantId,ctx.outletId,from,body.endDate).n;
    assert(!openOrders,'Complete or resolve all orders across the period before closing.',409);
    const openTills=db.prepare("SELECT COUNT(*) n FROM records WHERE tenant_id=? AND outlet_id=? AND module='tills' AND status='open'").get(ctx.tenantId,ctx.outletId).n;
    assert(!openTills,'Close all till sessions before closing the period.',409);
    let count=0;
    for(let d=from;d<=body.endDate;d=addDays(d,1)){
      const exists=db.prepare('SELECT 1 FROM periods WHERE tenant_id=? AND outlet_id=? AND business_date=?').get(ctx.tenantId,ctx.outletId,d);
      if(exists)continue;
      db.prepare('INSERT INTO periods VALUES(?,?,?,?,?,?,?)').run(ctx.tenantId,ctx.outletId,d,'closed',body.reason,ctx.user.id,now());
      count++;
    }
    assert(count>0,'The requested range was already closed.',409);
    audit(db,ctx,'finance.fiscal_period_closed',`${from}→${body.endDate}`,{dates:count,evidence:body.evidence});
    return {from,to:body.endDate,closed:count,nextOpen:addDays(body.endDate,1)};
  });
}
export function fiscalPeriods(db,ctx){
  permit(ctx,'finance','read');
  const rows=db.prepare("SELECT business_date date,reason,actor_id,closed_at FROM periods WHERE tenant_id=? AND outlet_id=? AND status='closed' ORDER BY business_date DESC").all(ctx.tenantId,ctx.outletId);
  return {closedDates:rows.map(r=>r.date),records:rows,lastClosed:rows[0]?.date||null};
}

export function mountFinanceExt(app,db){
  app.get('/api/finance/invoices',(req,res)=>res.json(listInvoices(db,req.ctx,req.query)));
  app.post('/api/finance/invoices',(req,res)=>res.status(201).json(issueInvoice(db,req.ctx,req.body)));
  app.post('/api/finance/credit-notes',(req,res)=>res.status(201).json(issueCreditNote(db,req.ctx,req.body)));
  app.get('/api/finance/ageing',(req,res)=>res.json(ageingReport(db,req.ctx,req.query.asOf||businessDate())));
  app.get('/api/finance/gift-card-ledger',(req,res)=>res.json(giftCardLedger(db,req.ctx)));
  app.post('/api/finance/chargebacks',(req,res)=>res.status(201).json(recordChargeback(db,req.ctx,req.body)));
  app.post('/api/finance/tills/:id/corrections',(req,res)=>res.status(201).json(correctClosedTill(db,req.ctx,req.params.id,req.body)));
  app.get('/api/finance/deposit-terms',(req,res)=>{permit(req.ctx,'finance','read');res.json(depositTerms(db,req.ctx));});
  app.post('/api/finance/deposit-terms',(req,res)=>res.json(setDepositTerms(db,req.ctx,req.body)));
  app.post('/api/tables/bookings/:id/forfeit',(req,res)=>res.status(201).json(forfeitDeposit(db,req.ctx,req.params.id,req.body)));
  app.get('/api/finance/periods',(req,res)=>res.json(fiscalPeriods(db,req.ctx)));
  app.post('/api/finance/periods/close',(req,res)=>res.status(201).json(closeFiscalPeriod(db,req.ctx,req.body)));
}
