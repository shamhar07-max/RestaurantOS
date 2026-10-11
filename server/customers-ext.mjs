import { z } from 'zod';
import { id,now,businessDate,transaction,audit,journal } from './db.mjs';
import { assert,permit,getRecord,orderDetail,refund,taxPolicy,taxFromGross,parseRecord } from './domain.mjs';

// ORD-17 — structured service recovery. A complaint is linked to an explicit
// corrective outcome (refund through the controlled refund path, a replacement
// order, or a recorded goodwill gesture) with evidence, then resolved.
const suggestionKey=z.string().trim().min(8).max(200);
export function recoverComplaint(db,ctx,complaintId,input){
  permit(ctx,'customers');assert(['owner','manager'].includes(ctx.user.role),'Service recovery requires a manager or owner.',403);
  const body=z.object({resolution:z.enum(['refund','replacement','goodwill']),orderId:z.string().max(200).optional(),paymentId:z.string().max(200).optional(),amount:z.number().int().positive().max(100_000_000).optional(),replacementOrderId:z.string().max(200).optional(),points:z.number().int().min(0).max(1_000_000).optional(),evidence:z.string().trim().min(3).max(1000),idempotencyKey:suggestionKey.optional()}).strict().parse(input);
  return transaction(db,()=>{
    const complaint=getRecord(db,ctx,complaintId);assert(complaint.module==='complaints','Complaint not found.',404);assert(['open','investigating'].includes(complaint.status),'This complaint is already resolved.',409);
    let linkage;
    if(body.resolution==='refund'){
      assert(body.orderId&&body.paymentId&&body.amount,'A refund recovery needs the order, payment and amount.');
      refund(db,ctx,body.orderId,{paymentId:body.paymentId,amount:body.amount,reason:`Complaint recovery · ${complaint.data.name} · ${body.evidence}`,idempotencyKey:body.idempotencyKey||`complaint:${complaintId}`});
      linkage={refund:{orderId:body.orderId,paymentId:body.paymentId,amount:body.amount}};
    } else if(body.resolution==='replacement'){
      assert(body.replacementOrderId,'Link the replacement order that was issued.');
      const replacement=orderDetail(db,ctx,body.replacementOrderId);
      linkage={replacement:{orderId:body.replacementOrderId,number:replacement.number,total:replacement.total},originalOrderId:body.orderId||complaint.data.orderId||null};
    } else {
      assert((body.points||0)>0||(body.amount||0)>0,'Record the goodwill gesture as points or an amount.');
      linkage={goodwill:{points:body.points||0,amount:body.amount||0}};
    }
    const recovery={at:now(),resolution:body.resolution,evidence:body.evidence,by:ctx.user.name,...linkage};
    const data={...complaint.data,recoveries:[...(complaint.data.recoveries||[]),recovery],resolution:body.resolution,resolvedAt:now()};
    db.prepare('UPDATE records SET status=?,data=?,version=version+1,updated_at=? WHERE id=?').run('resolved',JSON.stringify(data),now(),complaint.id);
    audit(db,ctx,'complaint.recovery',complaint.id,{resolution:body.resolution,...linkage});
    return getRecord(db,ctx,complaint.id);
  });
}

// ORD-18 — coupon and gift-card redemption against an order, before payment.
export function redeemOrder(db,ctx,orderId,input){
  permit(ctx,'orders');
  const body=z.object({kind:z.enum(['coupon','gift_card']),code:z.string().trim().min(1).max(80),reason:z.string().trim().min(3).max(500),idempotencyKey:suggestionKey}).strict().parse(input);
  return transaction(db,()=>{
    const prior=db.prepare('SELECT * FROM redemptions WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);
    if(prior){assert(prior.order_id===orderId,'This redemption key belongs to another order.',409);return orderDetail(db,ctx,orderId);}
    const order=orderDetail(db,ctx,orderId);
    assert(order.status!=='cancelled','Cannot redeem against a cancelled order.',409);
    assert(order.paid===0&&order.refunds.length===0,'Apply coupons and gift cards before the first payment.',409);
    assert(order.splits.length===0,'Redemptions are unavailable after the bill has been split.',409);
    const recordFor=(module)=>db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module=? AND lower(json_extract(data,'$.code'))=lower(?)").get(ctx.tenantId,ctx.outletId,module,body.code);
    if(body.kind==='coupon'){
      const coupon=recordFor('coupons');assert(coupon&&coupon.status==='active','That coupon code is not active.',404);
      const data=JSON.parse(coupon.data);
      assert(!data.expiresAt||data.expiresAt>=businessDate(),'This coupon has expired.',409);
      assert(!data.minSpend||order.total>=data.minSpend,'The order does not meet this coupon\'s minimum spend.',409);
      assert(!data.maxRedemptions||(data.redeemed||0)<data.maxRedemptions,'This coupon has reached its redemption limit.',409);
      const discount=data.type==='percent'?Math.round(order.total*data.value/100):data.value;
      assert(discount>0&&discount<=order.total,'This coupon discount does not apply to the order total.',409);
      const newTotal=order.total-discount,{net,tax}=taxFromGross(newTotal,taxPolicy(db,ctx).ratePercent),netDelta=net-order.net,taxDelta=tax-order.tax,delta=newTotal-order.total;
      const posting=(account,change)=>({account,debit:Math.max(change,0),credit:Math.max(-change,0)});
      db.prepare('UPDATE orders SET total=?,net=?,tax=?,version=version+1,updated_at=? WHERE id=?').run(newTotal,net,tax,now(),orderId);
      db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify({...data,redeemed:(data.redeemed||0)+1}),now(),coupon.id);
      journal(db,ctx,id('redemption'),'coupon_redemption',[posting('Receivables',delta),posting('Sales',-netDelta),posting('Output VAT',-taxDelta)]);
      db.prepare('INSERT INTO redemptions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id('redemption'),ctx.tenantId,ctx.outletId,orderId,'coupon',coupon.id,null,discount,0,ctx.user.id,body.idempotencyKey,now());
      audit(db,ctx,'order.coupon_redeemed',orderId,{couponId:coupon.id,code:data.code,discount,reason:body.reason});
      return orderDetail(db,ctx,orderId);
    }
    const card=recordFor('gift_cards');assert(card&&card.status==='active','That gift card is not active.',404);
    const cardData=JSON.parse(card.data);
    assert(!cardData.expiresAt||cardData.expiresAt>=businessDate(),'This gift card has expired.',409);
    const remaining=order.total-order.paid;
    assert(remaining>0,'Nothing is due on this order.',409);
    const amount=Math.min(cardData.balance||0,remaining);
    assert(amount>0,'This gift card has no remaining balance.',409);
    const paymentId=id('payment');
    db.prepare('INSERT INTO payments VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(paymentId,ctx.tenantId,ctx.outletId,orderId,amount,'gift_card',`Gift card ${cardData.code}`,'recorded',null,body.idempotencyKey,now());
    journal(db,ctx,paymentId,'gift_card_redemption',[{account:'Gift card liability',debit:amount},{account:'Receivables',credit:amount}]);
    const balance=cardData.balance-amount;
    db.prepare('UPDATE records SET status=?,data=?,version=version+1,updated_at=? WHERE id=?').run(balance>0?'active':'depleted',JSON.stringify({...cardData,balance}),now(),card.id);
    db.prepare('INSERT INTO redemptions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id('redemption'),ctx.tenantId,ctx.outletId,orderId,'gift_card',null,card.id,amount,0,ctx.user.id,body.idempotencyKey,now());
    audit(db,ctx,'order.gift_card_redeemed',orderId,{giftCardId:card.id,code:cardData.code,amount,balance,reason:body.reason});
    return orderDetail(db,ctx,orderId);
  });
}

export function orderRedemptions(db,ctx,orderId){
  permit(ctx,'orders','read');
  orderDetail(db,ctx,orderId);
  return db.prepare('SELECT id,kind,amount,points,created_at FROM redemptions WHERE tenant_id=? AND outlet_id=? AND order_id=? ORDER BY created_at').all(ctx.tenantId,ctx.outletId,orderId);
}

// CORE-14 — consent-filtered campaign messaging. An approved campaign can be
// sent only to customers whose marketing consent is granted; withdrawn or
// ungranted customers are recorded as blocked with the reason, so the consent
// decision is auditable rather than silently skipped.
export function sendCampaign(db,ctx,campaignId,input){
  permit(ctx,'customers');assert(['owner','manager'].includes(ctx.user.role),'Campaign sending requires a manager or owner.',403);
  const body=z.object({channel:z.enum(['whatsapp_business','sms_gateway','email_relay']),evidence:z.string().trim().min(3).max(1000),idempotencyKey:suggestionKey}).strict().parse(input);
  return transaction(db,()=>{
    const campaign=getRecord(db,ctx,campaignId);assert(campaign.module==='campaigns','Campaign not found.',404);assert(campaign.status==='approved','Approve the campaign before sending.',409);
    const customers=db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='customers' AND status='active'").all(ctx.tenantId,ctx.outletId).map(parseRecord);
    const results={sent:0,blocked:0,no_contact:0};
    for(const c of customers){
      const k=`campaign:${campaignId}:${c.id}`;
      if(db.prepare('SELECT id FROM message_log WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,k))continue;
      const recipient=(c.data.phone||'').trim()||(c.data.email||'').trim();
      let status='queued',reason=null;
      if(c.data.consent!=='granted'){status='blocked';reason='No marketing consent';results.blocked++;}
      else if(!recipient){status='blocked';reason='No contact address on file';results.no_contact++;}
      else results.sent++;
      db.prepare('INSERT INTO message_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id('msg'),ctx.tenantId,ctx.outletId,campaign.id,body.channel,recipient||'',c.id,status,reason,ctx.user.id,k,now());
    }
    audit(db,ctx,'campaign.sent',campaign.id,{channel:body.channel,evidence:body.evidence,...results});
    return {campaignId,channel:body.channel,...results,audience:customers.length};
  });
}
export function messageReport(db,ctx){
  permit(ctx,'customers','read');
  const rows=db.prepare('SELECT * FROM message_log WHERE tenant_id=? AND outlet_id=? ORDER BY created_at DESC LIMIT 500').all(ctx.tenantId,ctx.outletId);
  return {messages:rows,counts:rows.reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1;return a;},{})};
}

export function mountCustomersExt(app,db){
  app.post('/api/customers/complaints/:id/recover',(req,res)=>res.json(recoverComplaint(db,req.ctx,req.params.id,req.body)));
  app.get('/api/orders/:id/redemptions',(req,res)=>res.json(orderRedemptions(db,req.ctx,req.params.id)));
  app.post('/api/orders/:id/redemptions',(req,res)=>res.json(redeemOrder(db,req.ctx,req.params.id,req.body)));
  app.post('/api/customers/campaigns/:id/send',(req,res)=>res.json(sendCampaign(db,req.ctx,req.params.id,req.body)));
  app.get('/api/customers/messages',(req,res)=>res.json(messageReport(db,req.ctx)));
}
