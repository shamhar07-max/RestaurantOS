import { z } from 'zod';
import {seatingGroup,bookingConflict,arrivalTime,seatAvailable} from './seating.mjs';
import {enforceApproval,approvalAuthority} from './approvals.mjs';
import { id,now,businessDate,transaction,audit,journal } from './db.mjs';
import { modules,allowed } from '../shared/modules.mjs';
export class AppError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export const assert=(condition,message,status=400)=>{if(!condition)throw new AppError(message,status);};
export function permit(ctx,workspace,action='write') { assert(allowed(ctx.user.role,workspace,action),'Your role does not permit this action.',403); }
const integer=z.number().int().safe().nonnegative();
const positive=integer.min(1);
const key=z.string().min(8).max(160);
const text=z.string().max(4000);
const scoped=(db,table,ctx,recordId)=>db.prepare(`SELECT * FROM ${table} WHERE id=? AND tenant_id=? AND outlet_id=?`).get(recordId,ctx.tenantId,ctx.outletId);
export const parseRecord=r=>r?{...r,data:JSON.parse(r.data)}:null;
export function getRecord(db,ctx,recordId) { const r=parseRecord(scoped(db,'records',ctx,recordId));assert(r,'Record not found in this outlet.',404);return r; }
function updateRecord(db,ctx,r,status,data=r.data) {db.prepare('UPDATE records SET status=?,data=?,version=version+1,updated_at=? WHERE id=?').run(status,JSON.stringify(data),now(),r.id);audit(db,ctx,`${r.module}.${status}`,r.id,{from:r.status,version:r.version+1});return getRecord(db,ctx,r.id);}
function movement(db,ctx,ingredientId,lotId,quantity,type,origin,reason) {db.prepare('INSERT INTO movements VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id('mov'),ctx.tenantId,ctx.outletId,ingredientId,lotId,quantity,type,origin,ctx.user.id,reason,now());}
export function inventory(db,ctx) {
  const rows=db.prepare(`SELECT i.*, COALESCE(SUM(CASE WHEN l.status='available' AND l.expiry>=? THEN l.quantity ELSE 0 END),0) on_hand,
    COALESCE(SUM(CASE WHEN l.status='quarantined' THEN l.quantity ELSE 0 END),0) quarantined,
    COALESCE(SUM(CASE WHEN l.expiry<? THEN l.quantity ELSE 0 END),0) expired
    FROM ingredients i LEFT JOIN lots l ON l.ingredient_id=i.id AND l.outlet_id=? AND l.tenant_id=i.tenant_id
    WHERE i.tenant_id=? GROUP BY i.id`).all(businessDate(),businessDate(),ctx.outletId,ctx.tenantId);
  return rows.map(row=>{const reserved=db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM reservations WHERE ingredient_id=? AND tenant_id=? AND outlet_id=? AND status='reserved'").get(row.id,ctx.tenantId,ctx.outletId).n;return {...row,allergens:JSON.parse(row.allergens),reserved,available:row.on_hand-reserved};});
}
function freeLots(db,ctx,ingredientId) {
  return db.prepare(`SELECT l.*,l.quantity-COALESCE((SELECT SUM(r.quantity) FROM reservations r WHERE r.lot_id=l.id AND r.status='reserved'),0) free
    FROM lots l WHERE l.tenant_id=? AND l.outlet_id=? AND l.ingredient_id=? AND l.status='available' AND l.expiry>=? ORDER BY l.expiry,l.id`).all(ctx.tenantId,ctx.outletId,ingredientId,businessDate());
}
function allocate(db,ctx,ingredientId,quantity,origin,{orderId,lineId,reserve=false,type='issue',reason='Approved consumption',lotsUsed}={}) {
  let left=quantity,cost=0;
  const lots=freeLots(db,ctx,ingredientId);
  assert(lots.reduce((s,l)=>s+l.free,0)>=quantity,`Insufficient usable stock for ${db.prepare('SELECT name FROM ingredients WHERE id=?').get(ingredientId)?.name||ingredientId}. Expired and held stock cannot be used.`,409);
  for(const lot of lots){if(!left)break;const take=Math.min(lot.free,left);if(!take)continue;
    if(reserve)db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?)').run(id('res'),ctx.tenantId,ctx.outletId,orderId,lineId,lot.id,ingredientId,take,'reserved');
    else {db.prepare('UPDATE lots SET quantity=quantity-? WHERE id=?').run(take,lot.id);movement(db,ctx,ingredientId,lot.id,-take,type,origin,reason);}
    if(lotsUsed)lotsUsed.push({lotId:lot.id,code:lot.code,expiry:lot.expiry,quantity:take,unitCost:lot.unit_cost});cost+=take*lot.unit_cost;left-=take;
  }
  return cost;
}
function consumeLine(db,ctx,line,origin,type='sale') {
  if(line.consumed)return 0;
  const reservations=db.prepare("SELECT r.*,l.status lot_status,l.expiry,l.quantity stock,l.unit_cost FROM reservations r JOIN lots l ON l.id=r.lot_id WHERE r.line_id=? AND r.status='reserved'").all(line.id);
  let cost=0;
  for(const r of reservations){assert(r.lot_status==='available'&&r.expiry>=businessDate()&&r.stock>=r.quantity,'Reserved stock is held, expired, or insufficient. Ask a manager to resolve the order.',409);
    db.prepare('UPDATE lots SET quantity=quantity-? WHERE id=?').run(r.quantity,r.lot_id);db.prepare("UPDATE reservations SET status='consumed' WHERE id=?").run(r.id);
    movement(db,ctx,r.ingredient_id,r.lot_id,-r.quantity,type,origin,'Preparation started');cost+=r.quantity*r.unit_cost;
  }
  db.prepare('UPDATE order_lines SET consumed=1 WHERE id=?').run(line.id);
  if(cost)journal(db,ctx,line.id,type,[{account:'Food cost',debit:cost},{account:'Inventory',credit:cost}]);
  return cost;
}
export function menu(db,ctx) {
  const stock=new Map(inventory(db,ctx).map(i=>[i.id,i]));
  return db.prepare('SELECT * FROM menu WHERE tenant_id=? AND outlet_id=? ORDER BY category,name').all(ctx.tenantId,ctx.outletId).map(r=>{
    const recipe=JSON.parse(r.recipe),modifiers=JSON.parse(r.modifiers);
    return {...r,recipe,modifiers,allergens:JSON.parse(r.allergens),estimatedCost:recipe.reduce((s,l)=>s+l.quantity*(stock.get(l.ingredientId)?.unit_cost||0),0),stockAvailable:recipe.every(l=>(stock.get(l.ingredientId)?.available||0)>=l.quantity)};
  });
}
export function orderDetail(db,ctx,orderId) {
  const order=scoped(db,'orders',ctx,orderId);assert(order,'Order not found in this outlet.',404);
  const payments=db.prepare('SELECT * FROM payments WHERE order_id=?').all(orderId),refunds=db.prepare('SELECT * FROM refunds WHERE order_id=?').all(orderId);
  const paid=payments.filter(p=>p.status==='recorded').reduce((s,p)=>s+p.amount,0),refunded=refunds.reduce((s,r)=>s+r.amount,0);
  const splits=db.prepare('SELECT * FROM bill_splits WHERE order_id=?').all(orderId).map(r=>({...r,lines:JSON.parse(r.lines),paid:db.prepare('SELECT COALESCE(SUM(amount),0) n FROM split_payments WHERE split_id=?').get(r.id).n,due:r.amount-db.prepare('SELECT COALESCE(SUM(amount),0) n FROM split_payments WHERE split_id=?').get(r.id).n}));
  return {...order,assignedUserId:db.prepare('SELECT assigned_user_id FROM order_controls WHERE order_id=?').get(orderId)?.assigned_user_id||null,amendments:db.prepare('SELECT * FROM order_amendments WHERE order_id=? ORDER BY created_at').all(orderId).map(a=>({...a,details:JSON.parse(a.details)})),lines:db.prepare('SELECT l.* FROM order_lines l LEFT JOIN voided_lines v ON v.line_id=l.id WHERE l.order_id=? AND v.line_id IS NULL').all(orderId).map(l=>({...l,recipe:JSON.parse(l.recipe),modifiers:JSON.parse(l.modifiers),allergens:JSON.parse(l.allergens),...(db.prepare('SELECT task_id,seat,course,packed FROM line_service WHERE line_id=?').get(l.id)||{task_id:null,seat:0,course:1,packed:0})})),tasks:db.prepare('SELECT * FROM tasks WHERE order_id=?').all(orderId),payments,refunds,splits,paid,refunded,due:order.status==='cancelled'?0:Math.max(0,order.total-paid),paymentStatus:order.status==='cancelled'?paid>refunded?'refund_due':'cancelled':paid>=order.total?'paid':paid?'part_paid':'unpaid'};
}
export function orders(db,ctx) {return db.prepare('SELECT id FROM orders WHERE tenant_id=? AND outlet_id=? ORDER BY created_at DESC LIMIT 300').all(ctx.tenantId,ctx.outletId).map(o=>orderDetail(db,ctx,o.id));}
function snapshotLines(db,ctx,lines){
  return lines.map(l=>{
      const item=scoped(db,'menu',ctx,l.itemId);assert(item,'Menu item is not mapped to this outlet. Import rejected; correct channel mapping.',404);assert(item.available,'This menu item is sold out.',409);
      const modifierOptions=JSON.parse(item.modifiers);assert(new Set(l.modifierIds).size===l.modifierIds.length,'A modifier cannot be selected twice.');
      const selected=l.modifierIds.map(mid=>{const m=modifierOptions.find(m=>m.id===mid);assert(m,'Invalid modifier selection.');return m;});
      const groups=new Map(modifierOptions.filter(m=>m.group).map(m=>[m.group.id,m.group]));
      for(const [groupId,group] of groups){const count=selected.filter(m=>m.group?.id===groupId).length;assert(count>=(group.min||0)&&count<=group.max,`${group.name}: choose ${group.min||0} to ${group.max} options.`);}
      let recipe=JSON.parse(item.recipe);
      for(const m of selected){if(m.replace)recipe=recipe.filter(r=>r.ingredientId!==m.replace);recipe.push(...(m.ingredients||[]));}
      const aggregate=new Map();for(const r of recipe)aggregate.set(r.ingredientId,(aggregate.get(r.ingredientId)||0)+r.quantity);
      recipe=[...aggregate].map(([ingredientId,quantity])=>({ingredientId,quantity}));
      const allergens=[...new Set(recipe.flatMap(r=>JSON.parse(db.prepare('SELECT allergens FROM ingredients WHERE id=? AND tenant_id=?').get(r.ingredientId,ctx.tenantId)?.allergens||'[]')))];
      return {...l,item,recipe,allergens,selected,unitPrice:item.price+selected.reduce((s,m)=>s+m.price,0)};
    });
}
export function createOrder(db,ctx,input) {
  permit(ctx,'orders','create');
  const body=z.object({service:z.enum(['dine_in','takeaway','pickup','delivery','preorder','catering']),channel:z.enum(['POS','Direct','Talabat','Deliveroo','Careem']).default('POS'),tableId:z.string().optional(),customer:text.default(''),notes:text.default(''),idempotencyKey:key,discount:integer.default(0),lines:z.array(z.object({itemId:z.string(),quantity:positive.max(100),modifierIds:z.array(z.string()).max(20).default([]),notes:text.default(''),seat:integer.max(100).default(0),course:positive.max(20).default(1),hold:z.boolean().default(false)})).min(1).max(100)}).parse(input);
  return transaction(db,()=>{
    const previous=db.prepare('SELECT id FROM orders WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);if(previous)return orderDetail(db,ctx,previous.id);
    if(body.service==='dine_in'){assert(body.tableId,'Select a table.');assert(scoped(db,'dining_tables',ctx,body.tableId),'Table not found.',404);body.tableId=seatingGroup(db,ctx,body.tableId).rootId;}
    const snapshots=snapshotLines(db,ctx,body.lines);
    const gross=snapshots.reduce((s,l)=>s+l.unitPrice*l.quantity,0);assert(Number.isSafeInteger(gross)&&gross<=100_000_000,'Order total exceeds the supported limit.');assert(body.discount<gross,'Discount must be less than the sale total.');
    const approval=body.discount?enforceApproval(db,ctx,'discount',body.discount,gross):null;
    const total=gross-body.discount,net=Math.round(total/1.05),tax=total-net,oid=id('ord');
    const number=db.prepare('SELECT COALESCE(MAX(number),1000)+1 n FROM orders WHERE tenant_id=? AND outlet_id=?').get(ctx.tenantId,ctx.outletId).n;
    db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(oid,ctx.tenantId,ctx.entityId,ctx.outletId,businessDate(),number,body.service,body.channel,body.tableId||null,body.customer,body.notes,'accepted',total,net,tax,body.discount,body.idempotencyKey,now(),now(),1);
    db.prepare('INSERT INTO order_controls(order_id,assigned_user_id) VALUES(?,?)').run(oid,db.prepare('SELECT id FROM users WHERE id=? AND tenant_id=?').get(ctx.user.id,ctx.tenantId)?ctx.user.id:null);
    const stationTasks=new Map();
    for(const l of snapshots){const group=JSON.stringify([l.item.station,l.course,l.hold]);if(!stationTasks.has(group)){const tid=id('task');db.prepare('INSERT INTO tasks(id,tenant_id,outlet_id,order_id,station,status) VALUES(?,?,?,?,?,?)').run(tid,ctx.tenantId,ctx.outletId,oid,l.item.station,l.hold?'held':'queued');stationTasks.set(group,tid);}const lid=id('line');db.prepare('INSERT INTO order_lines VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(lid,oid,l.itemId,l.item.name,l.quantity,l.unitPrice,l.item.station,l.item.version,JSON.stringify(l.recipe),JSON.stringify(l.selected),JSON.stringify(l.allergens),l.notes,0);
      db.prepare('INSERT INTO line_service VALUES(?,?,?,?,0)').run(lid,stationTasks.get(group),l.seat,l.course);
      for(const r of l.recipe)allocate(db,ctx,r.ingredientId,r.quantity*l.quantity,oid,{orderId:oid,lineId:lid,reserve:true});
    }
    journal(db,ctx,oid,'sale',[{account:'Receivables',debit:total},{account:'Sales',credit:net},{account:'Output VAT',credit:tax}]);
    audit(db,ctx,'order.accepted',oid,{number,total,channel:body.channel,discount:body.discount,approval});return orderDetail(db,ctx,oid);
  });
}
export function taskAction(db,ctx,taskId,input) {
  const body=z.object({action:z.enum(['start','ready','delay','fire','hold']),reason:text.optional()}).parse(input);
  if(['fire','hold'].includes(body.action)&&allowed(ctx.user.role,'orders','create'))permit(ctx,'orders','create');else permit(ctx,'kitchen');
  return transaction(db,()=>{const task=scoped(db,'tasks',ctx,taskId);assert(task,'Kitchen task not found.',404);const order=orderDetail(db,ctx,task.order_id);assert(!['cancelled','completed','handed_over'].includes(order.status),'This order is closed or handed over.',409);if(order.status==='held'&&['fire','start'].includes(body.action))assert(false,'Resume the held order before firing or preparing courses.',409);
    if(body.action==='fire'){assert(task.status==='held','Only a held course can fire.',409);db.prepare("UPDATE tasks SET status='queued' WHERE id=?").run(taskId);}
    if(body.action==='hold'){assert(task.status==='queued','Only an unstarted course can be held.',409);assert(body.reason?.trim(),'Enter the hold reason.');db.prepare("UPDATE tasks SET status='held',delay_reason=? WHERE id=?").run(body.reason,taskId);}
    if(body.action==='start'){assert(task.status==='queued','Only queued tasks can start.',409);for(const l of order.lines.filter(l=>l.task_id?l.task_id===taskId:l.station===task.station))consumeLine(db,ctx,l,order.id);db.prepare("UPDATE tasks SET status='preparing',started_at=? WHERE id=?").run(now(),taskId);db.prepare("UPDATE orders SET status='preparing',version=version+1,updated_at=? WHERE id=?").run(now(),order.id);}
    if(body.action==='ready'){assert(task.status==='preparing','Start preparation before marking ready.',409);db.prepare("UPDATE tasks SET status='ready',ready_at=? WHERE id=?").run(now(),taskId);const pending=db.prepare("SELECT COUNT(*) n FROM tasks WHERE order_id=? AND status NOT IN ('ready','cancelled')").get(order.id).n;if(!pending)db.prepare("UPDATE orders SET status='ready',version=version+1,updated_at=? WHERE id=?").run(now(),order.id);}
    if(body.action==='delay'){assert(body.reason?.trim(),'Enter a delay reason.');db.prepare('UPDATE tasks SET delay_reason=? WHERE id=?').run(body.reason,taskId);}
    audit(db,ctx,`kitchen.${body.action}`,taskId,{order:order.id,station:task.station});return orderDetail(db,ctx,order.id);
  });
}
export function orderAction(db,ctx,orderId,input) {
  permit(ctx,'orders');const body=z.object({action:z.enum(['handover','complete','cancel','remake']),reason:text.optional(),lineId:z.string().optional()}).parse(input);
  return transaction(db,()=>{const order=orderDetail(db,ctx,orderId);
    if(body.action==='cancel'){assert(['owner','manager'].includes(ctx.user.role),'Manager approval is required for cancellation.',403);assert(!['cancelled','completed'].includes(order.status),'Closed orders cannot be cancelled.',409);assert(body.reason?.trim(),'A cancellation reason is required.');
      db.prepare("UPDATE reservations SET status='released' WHERE order_id=? AND status='reserved'").run(orderId);
      db.prepare("UPDATE tasks SET status='cancelled' WHERE order_id=?").run(orderId);
      for(const l of order.lines.filter(l=>l.consumed))audit(db,ctx,'wastage.prepared_cancellation',l.id,{orderId,recipe:l.recipe,quantity:l.quantity,reason:body.reason});
      const originalFoodCost=order.lines.filter(l=>l.consumed).reduce((sum,l)=>sum+db.prepare("SELECT COALESCE(SUM(jl.debit-jl.credit),0) cost FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE j.origin=? AND j.type='sale' AND jl.account='Food cost'").get(l.id).cost,0);
      if(originalFoodCost)journal(db,ctx,orderId,'prepared_cancellation_loss',[{account:'Wastage',debit:originalFoodCost},{account:'Food cost',credit:originalFoodCost}]);
      journal(db,ctx,orderId,'cancellation',[{account:'Sales',debit:order.net},{account:'Output VAT',debit:order.tax},{account:'Receivables',credit:order.total}]);
      db.prepare("UPDATE orders SET status='cancelled',version=version+1,updated_at=? WHERE id=?").run(now(),orderId);
    }
    if(body.action==='handover'){assert(order.status==='ready','All kitchen stations must be ready before handover.',409);if(['takeaway','pickup','delivery'].includes(order.service))assert(order.lines.every(l=>l.packed===l.quantity),'Complete the packing checklist before handover.',409);db.prepare("UPDATE orders SET status='handed_over',version=version+1,updated_at=? WHERE id=?").run(now(),orderId);}
    if(body.action==='complete'){assert(order.status==='handed_over','Record handover before completing the order.',409);assert(order.due===0,'Settle the remaining balance before completion.',409);db.prepare("UPDATE orders SET status='completed',version=version+1,updated_at=? WHERE id=?").run(now(),orderId);}
    if(body.action==='remake'){assert(['owner','manager'].includes(ctx.user.role),'A manager must approve a remake.',403);assert(body.reason?.trim(),'Enter the remake reason.');assert(!['cancelled','completed'].includes(order.status),'Closed orders cannot be remade.',409);const l=order.lines.find(l=>l.id===body.lineId);assert(l?.consumed,'Only a prepared item can be remade.');let cost=0;for(const r of l.recipe)cost+=allocate(db,ctx,r.ingredientId,r.quantity*l.quantity,orderId,{type:'remake',reason:body.reason});journal(db,ctx,id('remake'),'remake',[{account:'Food cost',debit:cost},{account:'Inventory',credit:cost}]);if(l.task_id)db.prepare("UPDATE tasks SET status='preparing',ready_at=NULL WHERE id=?").run(l.task_id);else db.prepare("UPDATE tasks SET status='preparing',ready_at=NULL WHERE order_id=? AND station=?").run(orderId,l.station);db.prepare('UPDATE line_service SET packed=0 WHERE line_id=?').run(l.id);db.prepare("UPDATE orders SET status='preparing',version=version+1,updated_at=? WHERE id=?").run(now(),orderId);}
    audit(db,ctx,`order.${body.action}`,orderId,{reason:body.reason||'',lineId:body.lineId});return orderDetail(db,ctx,orderId);
  });
}
export function pay(db,ctx,orderId,input) {
  permit(ctx,'orders');assert(['owner','manager','cashier','accountant'].includes(ctx.user.role),'Your role cannot record payments.',403);
  const body=z.object({amount:positive,method:z.enum(['cash','bank_recorded']),reference:text.default(''),tillId:z.string().optional(),splitId:z.string().optional(),idempotencyKey:key}).parse(input);
  return transaction(db,()=>{const prior=db.prepare('SELECT * FROM payments WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);if(prior){assert(prior.order_id===orderId,'Payment key is already used for another order.',409);return orderDetail(db,ctx,orderId);}
    const order=orderDetail(db,ctx,orderId);assert(order.status!=='cancelled','Cannot pay a cancelled order.',409);assert(body.amount<=order.due,'Payment exceeds the unpaid balance.',409);
    if(order.splits.length){const split=order.splits.find(s=>s.id===body.splitId);assert(split,'Select the bill part receiving this payment.');assert(body.amount<=split.due,'Payment exceeds this bill part’s remaining balance.',409);}else assert(!body.splitId,'Bill part is not in this order.');
    if(body.method==='bank_recorded'){assert(['owner','accountant'].includes(ctx.user.role),'Finance must record bank evidence.',403);assert(body.reference.trim(),'A bank evidence reference is required.');}
    if(body.tillId){const till=getRecord(db,ctx,body.tillId);assert(till.module==='tills'&&till.status==='open','Select an open till session.');}
    const pid=id('payment');db.prepare('INSERT INTO payments VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(pid,ctx.tenantId,ctx.outletId,orderId,body.amount,body.method,body.reference,'recorded',body.tillId||null,body.idempotencyKey,now());
    if(body.splitId)db.prepare('INSERT INTO split_payments VALUES(?,?,?)').run(pid,body.splitId,body.amount);
    journal(db,ctx,pid,'payment',[{account:body.method==='cash'?'Cash':'Bank',debit:body.amount},{account:'Receivables',credit:body.amount}]);audit(db,ctx,'payment.recorded',pid,{orderId,amount:body.amount,method:body.method,splitId:body.splitId});return orderDetail(db,ctx,orderId);
  });
}
export function refund(db,ctx,orderId,input) {
  assert(approvalAuthority(db,ctx,'refund').some(r=>r.amount>0),'Refund approval is outside your authority.',403);
  const body=z.object({paymentId:z.string(),amount:positive,reason:text.min(3),idempotencyKey:key}).parse(input);
  return transaction(db,()=>{const prior=db.prepare('SELECT * FROM refunds WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);if(prior){assert(prior.order_id===orderId,'Refund key belongs to another order.',409);return orderDetail(db,ctx,orderId);}
    const order=orderDetail(db,ctx,orderId),payment=order.payments.find(p=>p.id===body.paymentId);assert(payment,'Payment not found for this order.',404);const refunded=order.refunds.filter(r=>r.payment_id===payment.id).reduce((s,r)=>s+r.amount,0);assert(body.amount<=payment.amount-refunded,'Refund exceeds the remaining refundable payment.',409);
    if(payment.method==='deposit_cash'&&payment.till_id){assert(getRecord(db,ctx,payment.till_id).status==='open','The original deposit till is closed. Finance must handle a documented correction.',409);}
    let bookingApproval=null;
    if(['deposit_cash','deposit_bank'].includes(payment.method)){const deposit=db.prepare('SELECT d.* FROM booking_deposits d JOIN deposit_movements m ON m.deposit_id=d.id WHERE m.payment_id=?').get(payment.id);assert(deposit,'Original booking deposit evidence is missing.',409);const original=db.prepare('SELECT SUM(amount) n FROM booking_deposits WHERE booking_id=?').get(deposit.booking_id).n;const unusedRefunds=db.prepare("SELECT COALESCE(SUM(m.amount),0) n FROM deposit_movements m JOIN booking_deposits d ON d.id=m.deposit_id WHERE d.booking_id=? AND m.action='refund'").get(deposit.booking_id).n;const usedRefunds=db.prepare('SELECT COALESCE(SUM(r.amount),0) n FROM refunds r JOIN deposit_movements m ON m.payment_id=r.payment_id JOIN booking_deposits d ON d.id=m.deposit_id WHERE d.booking_id=?').get(deposit.booking_id).n;bookingApproval=enforceApproval(db,ctx,'refund',unusedRefunds+usedRefunds+body.amount,original);}
    const approval=enforceApproval(db,ctx,'refund',order.refunded+body.amount,order.total);
    const rid=id('refund');db.prepare('INSERT INTO refunds VALUES(?,?,?,?,?,?,?,?,?,?)').run(rid,ctx.tenantId,ctx.outletId,orderId,payment.id,body.amount,body.reason,ctx.user.id,body.idempotencyKey,now());
    const net=Math.round((order.refunded+body.amount)*order.net/order.total)-Math.round(order.refunded*order.net/order.total),tax=body.amount-net;
    journal(db,ctx,rid,'refund',order.status==='cancelled'?[{account:'Receivables',debit:body.amount},{account:['cash','deposit_cash'].includes(payment.method)?'Cash':'Bank',credit:body.amount}]:[{account:'Sales returns',debit:net},{account:'Output VAT',debit:tax},{account:['cash','deposit_cash'].includes(payment.method)?'Cash':'Bank',credit:body.amount}]);
    audit(db,ctx,'refund.approved',rid,{orderId,amount:body.amount,reason:body.reason,inventoryEffect:'none',approval,bookingApproval});return orderDetail(db,ctx,orderId);
  });
}
export function createRecord(db,ctx,module,input) {
  const config=modules[module];assert(config,'Unknown workspace record.',404);permit(ctx,config.workspace,module==='payroll'?'payroll':module==='tills'?'till':'write');
  const fields={};for(const f of config.fields){let schema=f.type==='number'?integer:f.type==='select'?z.enum(f.options):z.string().max(f.type==='textarea'?4000:300);if(f.type==='email')schema=z.email().or(z.literal(''));if(f.required&&f.type!=='number'&&f.type!=='select')schema=schema.refine(v=>v.trim().length>0,`${f.label} is required`);fields[f.key]=f.required?schema:schema.optional();}
  const data=z.object(fields).strict().parse(input);
  return transaction(db,()=>{
    for(const f of config.fields.filter(f=>['ingredient','supplier','staff','table','outlet'].includes(f.type))){if(!data[f.key])continue;
      if(f.type==='ingredient')assert(db.prepare('SELECT id FROM ingredients WHERE id=? AND tenant_id=?').get(data[f.key],ctx.tenantId),'Ingredient not found.',404);
      if(f.type==='supplier'||f.type==='staff'){const ref=getRecord(db,ctx,data[f.key]);assert(ref.module===(f.type==='supplier'?'suppliers':'staff'),'Invalid record reference.');}
      if(f.type==='table')assert(scoped(db,'dining_tables',ctx,data[f.key]),'Table not found.',404);
      if(f.type==='outlet')assert(db.prepare('SELECT id FROM outlets WHERE id=? AND tenant_id=?').get(data[f.key],ctx.tenantId),'Destination outlet not found.',404);
    }
    if(module==='reservations'){
      const group=seatingGroup(db,ctx,data.tableId);assert(data.partySize>0&&data.partySize<=group.capacity,'Party exceeds table capacity.');data.startsAt=arrivalTime(data.startsAt);data.endsAt=arrivalTime(data.endsAt);assert(data.startsAt<data.endsAt,'Departure must follow arrival.');assert(!bookingConflict(db,ctx,group.ids,data.startsAt,data.endsAt),'This table is already reserved for that time.',409);data.tableId=group.rootId;
    }
    if(['purchases','transfers','wastage'].includes(module))assert(data.quantity>0,'Quantity must be positive.');
    if(module==='purchases'){assert(getRecord(db,ctx,data.supplierId).status==='approved','Supplier must be approved.');data.received=0;}
    if(module==='batches'){assert(data.inputQuantity>0&&data.outputQuantity>0,'Batch quantities must be positive.');assert(data.inputId!==data.outputId,'Input and output must be different ingredients.');assert(data.expiry>=businessDate(),'Output expiry must not be in the past.');}
    if(module==='contracts'){assert(data.rate>0,'Contract rate must be positive.');assert(data.startDate<=data.endDate,'Contract dates are invalid.');data.rateVersion=1;}
    if(module==='subscriptions'){assert(data.entitlements>0,'A subscription needs funded entitlements.');data.used=0;}
    if(module==='shifts'){assert(new Date(data.startsAt)<new Date(data.endsAt),'Shift end must follow start.');}
    if(module==='deliveries'){const order=orderDetail(db,ctx,data.orderId);assert(order.service==='delivery','Only delivery orders can be assigned.');assert(!['cancelled','completed'].includes(order.status),'Order is closed.');}
    if(module==='settlements')data.variance=data.payout-(data.gross-(data.refunds||0)-(data.discounts||0)-(data.commission||0)-(data.adjustments||0));
    if(module==='bills'){const po=getRecord(db,ctx,data.purchaseId);assert(po.module==='purchases'&&po.data.supplierId===data.supplierId,'Supplier bill must match its purchase order.');assert(!db.prepare("SELECT id FROM records WHERE tenant_id=? AND module='bills' AND json_extract(data,'$.name')=? AND json_extract(data,'$.supplierId')=?").get(ctx.tenantId,data.name,data.supplierId),'Duplicate supplier invoice.',409);}
    const rid=id(module),stamp=now();
    if(module==='safety'&&data.result==='deviation'){
      const incidentId=id('incidents');data.incidentId=incidentId;
      db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?)').run(incidentId,ctx.tenantId,ctx.entityId,ctx.outletId,'incidents','open',JSON.stringify({name:`Deviation: ${data.name}`,severity:'medium',affected:data.name,responsible:data.responsible,notes:`Check ${rid}; ${data.reading}; criterion ${data.criterion}. ${data.notes||''}`}),1,stamp,stamp);
      audit(db,ctx,'safety.deviation_task',incidentId,{checkId:rid,responsible:data.responsible});
    }
    db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?)').run(rid,ctx.tenantId,ctx.entityId,ctx.outletId,module,config.states[0],JSON.stringify(data),1,stamp,stamp);audit(db,ctx,`${module}.created`,rid,{data});return getRecord(db,ctx,rid);
  });
}
const approvalModules=new Set(['purchases','batches','transfers','counts','wastage','catering','contracts','campaigns','leave','bills','settlements','payroll','suppliers']);
export function recordAction(db,ctx,recordId,input) {
  const body=z.object({action:z.string().max(50),reason:text.default(''),version:positive,quantity:integer.optional(),expiry:z.string().optional(),lotCode:z.string().max(100).optional(),evidence:text.optional(),counted:integer.optional(),payment:integer.optional()}).strict().parse(input);
  return transaction(db,()=>{
    const r=getRecord(db,ctx,recordId),cfg=modules[r.module];assert(cfg,'Unknown record.');permit(ctx,cfg.workspace,r.module==='payroll'?'payroll':r.module==='tills'?'till':body.action==='receive'&&r.module==='purchases'?'receive':r.module==='batches'&&['released','rejected'].includes(body.action)?'release':'write');assert(r.version===body.version,'This record changed. Refresh it before acting.',409);
    const sensitive=body.action==='approved'||body.action==='matched'||body.action==='reconciled'||body.action==='period_closed';
    if(sensitive&&approvalModules.has(r.module))assert(['owner','manager','accountant','purchasing','hr'].includes(ctx.user.role),'An authorised approver is required.',403);
    if(r.module==='purchases'&&body.action==='receive'){
      assert(['approved','part_received'].includes(r.status),'Approve the purchase before receiving.',409);assert(body.quantity>0&&body.quantity<=r.data.quantity-r.data.received,'Receipt quantity exceeds the outstanding purchase balance.');assert(body.expiry&&body.expiry>=businessDate(),'Enter a usable expiry date.');assert(body.lotCode?.trim(),'Supplier lot code is required.');assert(body.evidence?.trim(),'Receiving / inspection evidence is required.');
      const lid=id('lot');db.prepare('INSERT INTO lots VALUES(?,?,?,?,?,?,?,?,?,?)').run(lid,ctx.tenantId,ctx.outletId,r.data.ingredientId,body.lotCode,body.expiry,'available',r.data.unitCost,body.quantity,r.id);movement(db,ctx,r.data.ingredientId,lid,body.quantity,'receipt',r.id,body.evidence);
      const cost=body.quantity*r.data.unitCost;journal(db,ctx,lid,'receipt',[{account:'Inventory',debit:cost},{account:'Goods received not invoiced',credit:cost}]);const received=r.data.received+body.quantity;return updateRecord(db,ctx,r,received===r.data.quantity?'received':'part_received',{...r.data,received});
    }
    if(r.module==='batches'){
      if(body.action==='executing'){assert(r.status==='planned','Batch has already started.',409);const cost=allocate(db,ctx,r.data.inputId,r.data.inputQuantity,r.id,{type:'production_issue',reason:'Production input'});return updateRecord(db,ctx,r,'executing',{...r.data,inputCost:cost});}
      if(body.action==='quality_hold'){assert(r.status==='executing','Only executing batches can be held.');return updateRecord(db,ctx,r,'quality_hold');}
      if(body.action==='released'){assert(['owner','safety'].includes(ctx.user.role),'Food-safety release permission is required.',403);assert(r.status==='quality_hold','Review the quality hold before release.');assert(body.quantity>0,'Record actual output quantity.');assert(body.evidence?.trim(),'Release evidence is required.');const lid=id('lot'),unitCost=Math.round(r.data.inputCost/body.quantity);db.prepare('INSERT INTO lots VALUES(?,?,?,?,?,?,?,?,?,?)').run(lid,ctx.tenantId,ctx.outletId,r.data.outputId,r.data.name,r.data.expiry,'available',unitCost,body.quantity,r.id);movement(db,ctx,r.data.outputId,lid,body.quantity,'production_output',r.id,body.evidence);return updateRecord(db,ctx,r,'released',{...r.data,actualOutput:body.quantity,yieldPercent:Math.round(body.quantity/r.data.inputQuantity*10000)/100,outputLot:lid,releaseEvidence:body.evidence});}
      if(body.action==='rejected'){assert(['owner','safety'].includes(ctx.user.role),'Food-safety rejection permission is required.',403);assert(['executing','quality_hold'].includes(r.status),'Only an active batch can be rejected.');assert(body.reason.trim(),'Rejection reason is required.');journal(db,ctx,r.id,'production_waste',[{account:'Wastage',debit:r.data.inputCost},{account:'Inventory',credit:r.data.inputCost}]);return updateRecord(db,ctx,r,'rejected',{...r.data,rejectionReason:body.reason});}
    }
    if(r.module==='transfers'){
      if(body.action==='in_transit'){assert(r.status==='planned','Transfer is already dispatched.');assert(r.data.destinationId!==ctx.outletId,'Select a different destination.');const destination=db.prepare('SELECT * FROM outlets WHERE id=? AND tenant_id=?').get(r.data.destinationId,ctx.tenantId);assert(destination.entity_id===ctx.entityId,'Intercompany transfers require a separate commercial workflow.');const lotsUsed=[];const cost=allocate(db,ctx,r.data.ingredientId,r.data.quantity,r.id,{type:'transfer_dispatch',reason:body.reason||'Branch dispatch',lotsUsed});journal(db,ctx,r.id,'transfer_dispatch',[{account:'In-transit stock',debit:cost},{account:'Inventory',credit:cost}]);return updateRecord(db,ctx,r,'in_transit',{...r.data,cost,lotsUsed,dispatchedAt:now()});}
      if(body.action==='received'){assert(r.status==='in_transit','Only in-transit stock can be received.');assert(ctx.user.outlet_ids.includes(r.data.destinationId),'You do not have access to the receiving outlet.',403);assert(body.evidence?.trim(),'Receiving evidence is required.');const destinationCtx={...ctx,outletId:r.data.destinationId};for(const source of r.data.lotsUsed){const lid=id('lot');db.prepare('INSERT INTO lots VALUES(?,?,?,?,?,?,?,?,?,?)').run(lid,ctx.tenantId,r.data.destinationId,r.data.ingredientId,`${r.data.name}/${source.code}`,source.expiry,'available',source.unitCost,source.quantity,r.id);movement(db,destinationCtx,r.data.ingredientId,lid,source.quantity,'transfer_receive',r.id,body.evidence);}journal(db,ctx,r.id,'transfer_receive',[{account:'Inventory transferred out',debit:r.data.cost},{account:'In-transit stock',credit:r.data.cost}]);journal(db,destinationCtx,r.id,'transfer_receive_destination',[{account:'Inventory',debit:r.data.cost},{account:'Inventory transferred in',credit:r.data.cost}]);return updateRecord(db,ctx,r,'received',{...r.data,receivedAt:now(),evidence:body.evidence});}
    }
    if(r.module==='wastage'&&body.action==='approved'){assert(r.status==='draft','Wastage is already posted.');const cost=allocate(db,ctx,r.data.ingredientId,r.data.quantity,r.id,{type:'waste',reason:r.data.notes});journal(db,ctx,r.id,'waste',[{account:'Wastage',debit:cost},{account:'Inventory',credit:cost}]);return updateRecord(db,ctx,r,'approved',{...r.data,cost});}
    if(r.module==='counts'&&body.action==='approved'){
      assert(r.status==='draft','Count is already posted.');const stock=inventory(db,ctx).find(i=>i.id===r.data.ingredientId);assert(stock.reserved===0,'Resolve reservations before posting a count.');const variance=r.data.counted-stock.on_hand;
      if(variance<0)allocate(db,ctx,r.data.ingredientId,-variance,r.id,{type:'count_adjustment',reason:r.data.notes});
      if(variance>0){const lid=id('lot');db.prepare('INSERT INTO lots VALUES(?,?,?,?,?,?,?,?,?,?)').run(lid,ctx.tenantId,ctx.outletId,r.data.ingredientId,r.data.name,body.expiry||businessDate(),'available',stock.unit_cost,variance,r.id);movement(db,ctx,r.data.ingredientId,lid,variance,'count_adjustment',r.id,r.data.notes);}
      const cost=Math.abs(variance)*stock.unit_cost;if(cost)journal(db,ctx,r.id,'count',variance<0?[{account:'Stock variance',debit:cost},{account:'Inventory',credit:cost}]:[{account:'Inventory',debit:cost},{account:'Stock variance',credit:cost}]);return updateRecord(db,ctx,r,'approved',{...r.data,expected:stock.on_hand,variance});
    }
    if(r.module==='contracts'&&body.action==='period_closed'){
      assert(r.status==='approved','Approve contract terms before closing the period.');assert(body.evidence?.trim(),'Client acceptance / authorised extras evidence is required.');const units=r.data.billingBasis==='fixed_person'?r.data.eligible:r.data.billingBasis==='fixed_site'?1:r.data.billingBasis==='guaranteed_minimum'?Math.max(r.data.minimum||0,r.data.accepted):r.data.accepted;
      const net=units*r.data.rate,tax=Math.round(net*.05),total=net+tax;journal(db,ctx,r.id,'contract_invoice',[{account:'Receivables',debit:total},{account:'Contract sales',credit:net},{account:'Output VAT',credit:tax}]);return updateRecord(db,ctx,r,'period_closed',{...r.data,invoice:{units,net,tax,total,basis:r.data.billingBasis,rateVersion:r.data.rateVersion,issuedAt:now(),evidence:body.evidence}});
    }
    if(r.module==='subscriptions'&&body.action==='fulfil'){
      assert(r.status==='active','Only active subscriptions can be fulfilled.');assert(r.data.used<r.data.entitlements,'No funded entitlement remains.');assert(body.evidence?.trim(),'Delivery evidence is required.');audit(db,ctx,'subscription.meal_delivered',r.id,{number:r.data.used+1,evidence:body.evidence});return updateRecord(db,ctx,r,r.status,{...r.data,used:r.data.used+1});
    }
    if(r.module==='tills'&&body.action==='closed'){
      assert(r.status==='open','Till is already closed.');assert(body.counted!==undefined,'Enter the closing cash count.');const collected=db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE till_id=? AND method='cash'").get(r.id).n;const refunded=db.prepare("SELECT COALESCE(SUM(r.amount),0) n FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.till_id=? AND p.method IN ('cash','deposit_cash')").get(r.id).n;const deposits=db.prepare("SELECT COALESCE(SUM(amount),0) n FROM booking_deposits WHERE till_id=? AND method='cash'").get(r.id).n;const depositRefunds=db.prepare("SELECT COALESCE(SUM(m.amount),0) n FROM deposit_movements m JOIN booking_deposits d ON d.id=m.deposit_id WHERE d.till_id=? AND d.method='cash' AND m.action='refund'").get(r.id).n;const expected=r.data.opening+collected+deposits-refunded-depositRefunds;return updateRecord(db,ctx,r,'closed',{...r.data,expected,counted:body.counted,variance:body.counted-expected,closedAt:now()});
    }
    if(r.module==='settlements'&&body.action==='reconciled'){assert(r.status==='unmatched','Settlement is already reconciled.');assert(r.data.variance===0,'Resolve the payout variance before reconciliation.',409);assert(body.evidence?.trim(),'Statement evidence is required.');return updateRecord(db,ctx,r,'reconciled',{...r.data,evidence:body.evidence});}
    if(r.module==='bills'){
      if(body.action==='matched'){assert(r.status==='draft','Bill is not a draft.');const po=getRecord(db,ctx,r.data.purchaseId);const receivedCost=po.data.received*po.data.unitCost;assert(r.data.amount-(r.data.tax||0)===receivedCost,'Invoice net does not match received goods. Resolve the discrepancy.',409);assert(body.evidence?.trim(),'Matching evidence is required.');journal(db,ctx,r.id,'supplier_bill',[{account:'Goods received not invoiced',debit:receivedCost},{account:'Input VAT',debit:r.data.tax||0},{account:'Payables',credit:r.data.amount}]);return updateRecord(db,ctx,r,'matched',{...r.data,evidence:body.evidence});}
      if(body.action==='paid'){assert(r.status==='matched','Match bill before payment.');assert(body.evidence?.trim(),'Bank payment evidence is required.');journal(db,ctx,r.id,'supplier_payment',[{account:'Payables',debit:r.data.amount},{account:'Bank',credit:r.data.amount}]);return updateRecord(db,ctx,r,'paid',{...r.data,paymentEvidence:body.evidence});}
    }
    if(['safety','incidents'].includes(r.module)&&['reviewed','resolved'].includes(body.action)){assert(['owner','safety'].includes(ctx.user.role),'The food-safety responsible person must approve this action.',403);assert(body.evidence?.trim(),'Verification evidence is required.');}
    if(r.module==='documents'&&body.action==='confirmed'){assert(['owner'].includes(ctx.user.role),'Owner review is required.',403);assert(body.evidence?.trim(),'Authority approval evidence is required.');}
    if(r.module==='deliveries'&&body.action==='dispatched'){const order=orderDetail(db,ctx,r.data.orderId);assert(order.status==='ready','All kitchen stations must be ready before dispatch.');assert(order.lines.every(l=>l.packed===l.quantity),'Complete the packing checklist before dispatch.',409);db.prepare("UPDATE orders SET status='handed_over',version=version+1,updated_at=? WHERE id=?").run(now(),order.id);}
    if(r.module==='deliveries'&&body.action==='delivered')assert(body.evidence?.trim(),'Delivery acceptance evidence is required.');
    const index=cfg.states.indexOf(r.status),target=cfg.states.indexOf(body.action);
    if(r.module==='reservations'&&body.action==='seated'){assert(r.status==='confirmed','Only confirmed reservations can be seated.',409);const group=seatingGroup(db,ctx,r.data.tableId);assert(r.data.partySize<=group.capacity,'Party exceeds current table capacity.');const end=arrivalTime(r.data.endsAt);assert(end>now(),'The booked departure has passed. Create a new booking window.',409);seatAvailable(db,ctx,group,now(),end,r.id);}
    if(r.module==='reservations'){assert((r.status==='confirmed'&&['seated','cancelled','no_show'].includes(body.action))||(r.status==='seated'&&['completed','cancelled'].includes(body.action)),'This reservation transition is not allowed.',409);}
    const special=(r.module==='subscriptions'&&((r.status==='active'&&body.action==='paused')||(r.status==='paused'&&body.action==='active')||body.action==='cancelled'))||(r.module==='reservations'&&((body.action==='cancelled'&&['confirmed','seated'].includes(r.status))||(body.action==='no_show'&&r.status==='confirmed')))||(r.module==='leave'&&body.action==='rejected')||(r.module==='deliveries'&&body.action==='failed');
    assert(target>=0&&(target===index+1||special),`Cannot change ${r.status.replaceAll('_',' ')} to ${body.action.replaceAll('_',' ')}.`,409);
    return updateRecord(db,ctx,r,body.action,{...r.data,...(body.evidence?{evidence:body.evidence}:{}),...(body.reason?{actionReason:body.reason}:{}),...(r.module==='shifts'?{[body.action==='clocked_in'?'clockIn':'clockOut']:now()}: {})});
  });
}
export function holdLot(db,ctx,lotId,input) {
  permit(ctx,'inventory','hold');assert(['owner','safety'].includes(ctx.user.role),'Only the food-safety responsible person can change a hold.',403);const body=z.object({status:z.enum(['quarantined','available']),reason:text.min(3)}).parse(input);
  return transaction(db,()=>{const lot=scoped(db,'lots',ctx,lotId);assert(lot,'Lot not found.',404);if(body.status==='available')assert(lot.expiry>=businessDate(),'Expired stock cannot be released.');db.prepare('UPDATE lots SET status=? WHERE id=?').run(body.status,lotId);audit(db,ctx,`lot.${body.status}`,lotId,{reason:body.reason});return scoped(db,'lots',ctx,lotId);});
}
export function summary(db,ctx) {
  const all=orders(db,ctx),today=all.filter(o=>o.business_date===businessDate()),valid=today.filter(o=>o.status!=='cancelled');
  const net=valid.reduce((s,o)=>s+o.net-Math.round(o.refunded*o.net/o.total),0);
  const collected=today.reduce((s,o)=>s+o.paid-o.refunded,0),completed=valid.filter(o=>o.status==='completed').length;
  const stock=inventory(db,ctx),low=stock.filter(i=>i.available<i.reorder_level),records=db.prepare('SELECT * FROM records WHERE tenant_id=? AND outlet_id=? ORDER BY created_at DESC').all(ctx.tenantId,ctx.outletId).map(parseRecord);
  const actions=[...records.filter(r=>r.module==='purchases'&&r.status==='requested').map(r=>({title:`Approve ${r.data.name}`,description:r.data.notes,workspace:'purchasing',recordId:r.id,kind:'approval'})),...low.map(i=>({title:`Replenish ${i.name}`,description:`${i.available.toLocaleString()} ${i.unit} available · reorder at ${i.reorder_level.toLocaleString()}`,workspace:'inventory',recordId:i.id,kind:'stock'})),...records.filter(r=>r.module==='incidents'&&r.status!=='resolved').map(r=>({title:r.data.name,description:`${r.data.responsible} · ${r.data.severity} priority`,workspace:'safety',recordId:r.id,kind:'safety'}))].filter(a=>allowed(ctx.user.role,a.workspace,'read'));
  const foodCost=db.prepare(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) n FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE j.tenant_id=? AND j.outlet_id=? AND j.business_date=? AND jl.account='Food cost'`).get(ctx.tenantId,ctx.outletId,businessDate()).n;
  const byChannel=Object.entries(valid.reduce((a,o)=>{a[o.channel]=(a[o.channel]||0)+o.net-Math.round(o.refunded*o.net/o.total);return a;},{})).map(([name,amount])=>({name,amount}));
  return {businessDate:businessDate(),netSales:net,collected,orderCount:valid.length,completed,average:valid.length?Math.round(net/valid.length):0,openOrders:valid.filter(o=>!['completed','cancelled'].includes(o.status)).length,foodCost,contribution:net-foodCost,lowStock:low.length,actions:actions.slice(0,10),byChannel,liveOrders:allowed(ctx.user.role,'orders','read')?valid.filter(o=>!['completed','cancelled'].includes(o.status)).slice(0,6):[],definition:'Net sales: accepted orders for this business date, excluding VAT, cancelled sales and approved refunds. Collected: recorded tenders less refunds. Contribution: net sales less posted recipe consumption; excludes labour, rent, commissions and overhead.'};
}

export function amendOrder(db,ctx,orderId,input){
  permit(ctx,'orders','create');
  const line=z.object({itemId:z.string(),quantity:positive.max(100),modifierIds:z.array(z.string()).max(20).default([]),notes:text.default(''),seat:integer.max(100).default(0),course:positive.max(20).default(1),hold:z.boolean().default(false)});
  const b=z.object({version:positive,idempotencyKey:key,reason:text.min(3),removeLineIds:z.array(z.string()).max(100).default([]),addLines:z.array(line).max(100).default([])}).parse(input);
  return transaction(db,()=>{const prior=db.prepare('SELECT order_id FROM order_amendments WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,b.idempotencyKey);if(prior){assert(prior.order_id===orderId,'Amendment key belongs to another order.',409);return orderDetail(db,ctx,orderId);}
    const order=orderDetail(db,ctx,orderId);assert(['accepted','preparing','ready'].includes(order.status),'Only an open, resumed order can be amended.',409);assert(order.version===b.version,'Order changed. Refresh before amending.',409);assert(!order.refunded,'An order with refunds requires a financial correction.',409);assert(!order.splits.length,'Immutable bill parts require a financial correction, not an amendment.',409);assert(b.addLines.length||b.removeLineIds.length,'Select an addition or removal.');assert(new Set(b.removeLineIds).size===b.removeLineIds.length,'A line can be removed only once.');
    const removed=b.removeLineIds.map(lid=>{const l=order.lines.find(l=>l.id===lid);assert(l,'Removal item is not in this order.',404);assert(!l.consumed,'A prepared item cannot be removed. Use approved cancellation or remake.',409);return l;});
    const added=snapshotLines(db,ctx,b.addLines),remaining=order.lines.filter(l=>!b.removeLineIds.includes(l.id));assert(remaining.length+added.length>0&&remaining.length+added.length<=100,'Keep between 1 and 100 active item lines.');const gross=remaining.reduce((s,l)=>s+l.quantity*l.unit_price,0)+added.reduce((s,l)=>s+l.quantity*l.unitPrice,0);assert(Number.isSafeInteger(gross)&&gross<=100_000_000&&order.discount<gross,'Amended total is outside the supported range.');if(order.discount)enforceApproval(db,ctx,'discount',order.discount,gross);const total=gross-order.discount;assert(total>=order.paid,'Amendment would reduce the bill below recorded payments. Refund/correct it through finance.',409);const net=Math.round(total/1.05),tax=total-net,aid=id('amendment'),addedIds=[];
    for(const l of order.lines.filter(l=>!l.task_id)){const task=order.tasks.find(t=>t.station===l.station);if(task)db.prepare('INSERT OR IGNORE INTO line_service VALUES(?,?,?,?,?)').run(l.id,task.id,l.seat,l.course,l.packed);}
    for(const l of removed){db.prepare('INSERT INTO voided_lines VALUES(?,?,?)').run(l.id,aid,b.reason);db.prepare("UPDATE reservations SET status='released' WHERE line_id=? AND status='reserved'").run(l.id);}
    for(const l of added){let task=db.prepare("SELECT t.id FROM tasks t JOIN line_service s ON s.task_id=t.id JOIN order_lines l ON l.id=s.line_id LEFT JOIN voided_lines v ON v.line_id=l.id WHERE t.order_id=? AND t.station=? AND t.status=? AND s.course=? AND v.line_id IS NULL LIMIT 1").get(order.id,l.item.station,l.hold?'held':'queued',l.course);if(!task){task={id:id('task')};db.prepare('INSERT INTO tasks(id,tenant_id,outlet_id,order_id,station,status) VALUES(?,?,?,?,?,?)').run(task.id,ctx.tenantId,ctx.outletId,order.id,l.item.station,l.hold?'held':'queued');}const lid=id('line');addedIds.push(lid);db.prepare('INSERT INTO order_lines VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(lid,order.id,l.itemId,l.item.name,l.quantity,l.unitPrice,l.item.station,l.item.version,JSON.stringify(l.recipe),JSON.stringify(l.selected),JSON.stringify(l.allergens),l.notes,0);db.prepare('INSERT INTO line_service VALUES(?,?,?,?,0)').run(lid,task.id,l.seat,l.course);for(const r of l.recipe)allocate(db,ctx,r.ingredientId,r.quantity*l.quantity,order.id,{orderId:order.id,lineId:lid,reserve:true});}
    db.prepare("UPDATE tasks SET status='cancelled' WHERE order_id=? AND status IN ('queued','held') AND NOT EXISTS(SELECT 1 FROM line_service s JOIN order_lines l ON l.id=s.line_id LEFT JOIN voided_lines v ON v.line_id=l.id WHERE s.task_id=tasks.id AND v.line_id IS NULL)").run(order.id);
    const pending=db.prepare("SELECT COUNT(*) n FROM tasks WHERE order_id=? AND status NOT IN ('ready','cancelled')").get(order.id).n;const consumed=remaining.some(l=>l.consumed);db.prepare('UPDATE orders SET total=?,net=?,tax=?,status=?,version=version+1,updated_at=? WHERE id=?').run(total,net,tax,!pending?'ready':consumed?'preparing':'accepted',now(),order.id);
    const details={reason:b.reason,removed:removed.map(l=>({id:l.id,name:l.name,quantity:l.quantity,unitPrice:l.unit_price})),added:addedIds,previousVersion:order.version};db.prepare('INSERT INTO order_amendments VALUES(?,?,?,?,?,?,?,?,?,?)').run(aid,ctx.tenantId,ctx.outletId,order.id,b.idempotencyKey,order.total,total,JSON.stringify(details),ctx.user.id,now());
    const delta=total-order.total,netDelta=net-order.net,taxDelta=tax-order.tax;const posting=(account,change)=>({account,debit:Math.max(change,0),credit:Math.max(-change,0)});if(delta||netDelta||taxDelta)journal(db,ctx,aid,'sale_amendment',[posting('Receivables',delta),posting('Sales',-netDelta),posting('Output VAT',-taxDelta)]);audit(db,ctx,'order.amended',order.id,{...details,amendmentId:aid,previousTotal:order.total,total});return orderDetail(db,ctx,order.id);
  });
}
