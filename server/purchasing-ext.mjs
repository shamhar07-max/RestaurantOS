import { z } from 'zod';
import { id,now,businessDate,transaction,audit,journal } from './db.mjs';
import { assert,permit,getRecord,purchaseMatchPolicy } from './domain.mjs';

// CORE-02/CORE-03 — multi-line purchase orders with per-line receiving and
// configurable receipt-quality rules. A header record holds the commercial
// terms; each line is received independently so partial deliveries, separate
// inspections and expiry/lot capture are recorded without rewriting the order.
const key=z.string().min(8).max(160);
const text=z.string().max(4000);
const insertRecord=(db,ctx,module,status,data)=>{const rid=id(module),stamp=now();db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?)').run(rid,ctx.tenantId,ctx.entityId,ctx.outletId,module,status,JSON.stringify(data),1,stamp,stamp);return rid;};
const lineOf=(db,ctx,lineId)=>db.prepare('SELECT * FROM po_lines WHERE line_id=? AND tenant_id=? AND outlet_id=?').get(lineId,ctx.tenantId,ctx.outletId);

export function receiptQuality(db,ctx){
  const setting=db.prepare("SELECT value FROM settings WHERE tenant_id=? AND outlet_id=? AND key='receiptQuality'").get(ctx.tenantId,ctx.outletId);
  const value=setting?JSON.parse(setting.value):{};
  return {required:Array.isArray(value.required)?value.required.filter(r=>typeof r==='string'):[],reviewed:!!value.reviewed};
}
export function setReceiptQuality(db,ctx,input){
  permit(ctx,'settings');assert(ctx.user.role==='owner','Only an owner can change receiving quality rules.',403);
  const body=z.object({required:z.array(z.string().trim().min(1).max(60)).max(20),evidence:text.min(3)}).strict().parse(input);
  transaction(db,()=>{
    db.prepare("INSERT INTO settings(tenant_id,outlet_id,key,value) VALUES(?,?,?,?) ON CONFLICT(tenant_id,outlet_id,key) DO UPDATE SET value=excluded.value").run(ctx.tenantId,ctx.outletId,'receiptQuality',JSON.stringify({required:[...new Set(body.required)],reviewed:true,changedBy:ctx.user.id,changedAt:now()}));
    audit(db,ctx,'purchase.receipt_quality_set',ctx.outletId,{required:body.required});
    return receiptQuality(db,ctx);
  });
}

export function createPurchaseOrder(db,ctx,input){
  permit(ctx,'purchasing');
  const body=z.object({name:z.string().trim().min(1).max(200),supplierId:z.string().min(1).max(200),deliveryDate:z.iso.date(),notes:text,lines:z.array(z.object({ingredientId:z.string().min(1).max(200),quantity:z.number().int().positive().max(100_000_000),unitCost:z.number().int().positive().max(100_000_000)}).strict()).min(1).max(50)}).strict().parse(input);
  return transaction(db,()=>{
    const supplier=getRecord(db,ctx,body.supplierId);assert(supplier.module==='suppliers'&&supplier.status==='approved','Supplier must be approved.',409);
    assert(new Set(body.lines.map(l=>l.ingredientId)).size===body.lines.length,'Each line must reference a different ingredient.');
    for(const l of body.lines)assert(db.prepare('SELECT id FROM ingredients WHERE id=? AND tenant_id=?').get(l.ingredientId,ctx.tenantId),'Ingredient not found.',404);
    assert(body.deliveryDate>=businessDate(),'Expected delivery must not be in the past.');
    const total=body.lines.reduce((s,l)=>s+l.quantity*l.unitCost,0);assert(Number.isSafeInteger(total),'Order value exceeds the supported range.');
    const rid=insertRecord(db,ctx,'purchase_orders','requested',{name:body.name,supplierId:body.supplierId,deliveryDate:body.deliveryDate,notes:body.notes,lineCount:body.lines.length,orderedValue:total,received:0,rejected:0});
    body.lines.forEach((l,i)=>db.prepare('INSERT INTO po_lines VALUES(?,?,?,?,?,?,?,?,?,?)').run(id('pol'),rid,ctx.tenantId,ctx.outletId,i+1,l.ingredientId,l.quantity,l.unitCost,0,0));
    audit(db,ctx,'purchase_order.created',rid,{supplierId:body.supplierId,lines:body.lines.length});
    return purchaseOrder(db,ctx,rid);
  });
}
export function purchaseOrder(db,ctx,poId){
  const r=getRecord(db,ctx,poId);assert(r.module==='purchase_orders','Purchase order not found.',404);
  const lines=db.prepare('SELECT * FROM po_lines WHERE po_id=? ORDER BY line_no').all(r.id).map(l=>({...l,id:l.line_id,outstanding:l.quantity-l.received-l.rejected,ingredient:(db.prepare('SELECT name,unit FROM ingredients WHERE id=?').get(l.ingredient_id)||{})}));
  return {...r,lines,orderedValue:lines.reduce((s,l)=>s+l.quantity*l.unit_cost,0),receivedValue:lines.reduce((s,l)=>s+l.received*l.unit_cost,0)};
}
export function purchaseOrders(db,ctx){
  permit(ctx,'purchasing','read');
  return db.prepare("SELECT id FROM records WHERE tenant_id=? AND outlet_id=? AND module='purchase_orders' ORDER BY created_at DESC").all(ctx.tenantId,ctx.outletId).map(r=>purchaseOrder(db,ctx,r.id));
}
export function receivePurchaseOrder(db,ctx,poId,input){
  permit(ctx,'purchasing','receive');
  const body=z.object({version:z.number().int().positive(),evidence:text.min(1),lines:z.array(z.object({lineId:z.string(),accepted:z.number().int().nonnegative().max(100_000_000),rejected:z.number().int().nonnegative().max(100_000_000),inspection:z.enum(['pass','conditional','fail']),expiry:z.iso.date().optional(),lotCode:z.string().max(100).optional(),checks:z.record(z.string(),z.enum(['pass','fail'])).optional()}).strict()).min(1).max(50)}).strict().parse(input);
  const rules=receiptQuality(db,ctx);
  return transaction(db,()=>{
    const r=getRecord(db,ctx,poId);assert(r.module==='purchase_orders','Purchase order not found.',404);
    assert(['approved','part_received'].includes(r.status),'Approve the purchase order before receiving.',409);assert(r.version===body.version,'This order changed. Refresh it before receiving.',409);
    for(const receipt of body.lines){
      const line=lineOf(db,ctx,receipt.lineId);assert(line&&line.po_id===r.id,'Receipt line not found on this order.',404);
      const accepted=receipt.accepted,rejected=receipt.rejected;assert(accepted+rejected>0,'Record an accepted or a rejected quantity.');
      assert(accepted+rejected<=line.quantity-line.received-line.rejected,'Receipt quantity exceeds the outstanding line balance.',409);
      assert(rejected===0||receipt.inspection!=='pass','A rejected quantity must record a conditional or failed inspection.');
      if(rules.required.length){
        const checks=receipt.checks||{};
        const missing=rules.required.filter(name=>!checks[name]);assert(!missing.length,`Record the required receipt checks: ${missing.join(', ')}.`);
        assert(!rules.required.some(name=>checks[name]==='fail')||receipt.inspection!=='pass','A failed quality check must not be recorded as a pass.');
      }
      if(accepted>0){assert(receipt.expiry&&receipt.expiry>=businessDate(),'Enter a usable expiry for accepted stock.');assert(receipt.lotCode?.trim(),'Supplier lot code is required for accepted stock.');}
      if(rejected>0)db.prepare('INSERT INTO movements VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id('mov'),ctx.tenantId,ctx.outletId,line.ingredient_id,null,rejected,'receipt_rejected',r.id,ctx.user.id,body.evidence,now());
      if(accepted>0){const lid=id('lot');db.prepare('INSERT INTO lots VALUES(?,?,?,?,?,?,?,?,?,?)').run(lid,ctx.tenantId,ctx.outletId,line.ingredient_id,receipt.lotCode,receipt.expiry,'available',line.unit_cost,accepted,r.id);db.prepare('INSERT INTO movements VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id('mov'),ctx.tenantId,ctx.outletId,line.ingredient_id,lid,accepted,'receipt',r.id,ctx.user.id,body.evidence,now());const cost=accepted*line.unit_cost;journal(db,ctx,lid,'receipt',[{account:'Inventory',debit:cost},{account:'Goods received not invoiced',credit:cost}]);}
      db.prepare('UPDATE po_lines SET received=received+?,rejected=rejected+? WHERE line_id=?').run(accepted,rejected,line.line_id);
    }
    const lines=db.prepare('SELECT * FROM po_lines WHERE po_id=?').all(r.id);
    const received=lines.reduce((s,l)=>s+l.received,0),rejected=lines.reduce((s,l)=>s+l.rejected,0);
    const complete=lines.every(l=>l.received+l.rejected>=l.quantity);
    return updateRecordData(db,ctx,r,complete?'received':'part_received',{...r.data,received,rejected,lastReceipt:{at:now(),evidence:body.evidence,lines:body.lines.length}});
  });
}
export function purchaseOrderMatch(db,ctx,poId,input){
  permit(ctx,'purchasing');assert(['owner','accountant','purchasing'].includes(ctx.user.role),'An authorised reviewer must match the invoice.',403);
  const body=z.object({version:z.number().int().positive(),invoiceReference:z.string().trim().min(1).max(200),amount:z.number().int().positive().max(1_000_000_000),tax:z.number().int().nonnegative().max(1_000_000_000),evidence:text.min(1)}).strict().parse(input);
  return transaction(db,()=>{
    const r=getRecord(db,ctx,poId);assert(r.module==='purchase_orders','Purchase order not found.',404);assert(r.version===body.version,'This order changed. Refresh before matching.',409);
    const po=purchaseOrder(db,ctx,poId);assert(po.status==='received','Receive the full order before matching its invoice.',409);
    const receivedCost=po.receivedValue,invoicedNet=body.amount-body.tax,variance=invoicedNet-receivedCost;
    const policy=purchaseMatchPolicy(db,ctx),tolerance=policy.toleranceFils+Math.round(receivedCost*policy.tolerancePercent/100);
    assert(Math.abs(variance)<=tolerance,`Invoice net differs from received goods by ${variance} fils, outside the ${tolerance}-fils purchase tolerance.`,409);
    if(variance!==0)assert(['owner','accountant'].includes(ctx.user.role),'A purchase price variance requires an owner or accountant.',403);
    const journalLines=[{account:'Goods received not invoiced',debit:receivedCost},{account:'Input VAT',debit:body.tax},...(variance>0?[{account:'Purchase price variance',debit:variance}]:variance<0?[{account:'Purchase price variance',credit:-variance}]:[]),{account:'Payables',credit:body.amount}];
    journal(db,ctx,r.id,'supplier_bill',journalLines);
    audit(db,ctx,'purchase_order.matched',r.id,{invoiceReference:body.invoiceReference,variance,tolerance});
    return updateRecordData(db,ctx,r,r.status,{...r.data,bill:{invoiceReference:body.invoiceReference,amount:body.amount,tax:body.tax,receivedCost,variance,tolerance,matchedAt:now(),evidence:body.evidence}});
  });
}
function updateRecordData(db,ctx,r,status,data){db.prepare('UPDATE records SET status=?,data=?,version=version+1,updated_at=? WHERE id=?').run(status,JSON.stringify(data),now(),r.id);audit(db,ctx,`purchase_orders.${status}`,r.id,{status});return purchaseOrder(db,ctx,r.id);}

export function mountPurchasingExt(app,db){
  app.post('/api/purchasing/orders',(req,res)=>res.status(201).json(createPurchaseOrder(db,req.ctx,req.body)));
  app.get('/api/purchasing/orders',(req,res)=>res.json(purchaseOrders(db,req.ctx)));
  app.get('/api/purchasing/orders/:id',(req,res)=>res.json(purchaseOrder(db,req.ctx,req.params.id)));
  app.post('/api/purchasing/orders/:id/receive',(req,res)=>res.json(receivePurchaseOrder(db,req.ctx,req.params.id,req.body)));
  app.post('/api/purchasing/orders/:id/match',(req,res)=>res.json(purchaseOrderMatch(db,req.ctx,req.params.id,req.body)));
  app.get('/api/purchasing/receipt-quality',(req,res)=>{permit(req.ctx,'purchasing','read');res.json(receiptQuality(db,req.ctx));});
  app.post('/api/purchasing/receipt-quality',(req,res)=>res.json(setReceiptQuality(db,req.ctx,req.body)));
}
