import {z} from 'zod';
import {seatingGroup} from './seating.mjs';
import {id,now,transaction,audit,journal} from './db.mjs';
import {assert,permit,orderDetail,getRecord,refund} from './domain.mjs';
export function splitBill(db,ctx,orderId,input){
  permit(ctx,'orders');const b=z.object({parts:z.array(z.object({name:z.string().min(1).max(100),amount:z.number().int().safe().positive(),lineIds:z.array(z.string()).default([])})).min(2).max(30),reason:z.string().min(3).max(1000)}).parse(input);
  return transaction(db,()=>{const order=orderDetail(db,ctx,orderId);assert(order.status!=='cancelled','Cancelled bills cannot be split.');assert(order.paid===0,'Create splits before recording the first payment.');assert(b.parts.reduce((s,p)=>s+p.amount,0)===order.total,'Bill parts must sum to the exact original total, including VAT and rounding.');const used=b.parts.flatMap(p=>p.lineIds);assert(new Set(used).size===used.length,'An item cannot belong to more than one bill part.');assert(used.every(lid=>order.lines.some(l=>l.id===lid)),'Bill split contains an unknown line.');assert(!db.prepare('SELECT id FROM bill_splits WHERE order_id=?').get(orderId),'This order already has immutable bill parts. Create a correction through finance.');const splits=b.parts.map(part=>{const sid=id('split');db.prepare('INSERT INTO bill_splits VALUES(?,?,?,?,?,?,?,?)').run(sid,ctx.tenantId,ctx.outletId,orderId,part.name,part.amount,JSON.stringify(part.lineIds),now());return {id:sid,...part};});audit(db,ctx,'bill.split',orderId,{reason:b.reason,parts:splits});return splits;});
}
export function transferTable(db,ctx,orderId,input){
  permit(ctx,'tables');const b=z.object({tableId:z.string(),reason:z.string().min(3).max(500)}).parse(input);
  return transaction(db,()=>{const o=orderDetail(db,ctx,orderId);assert(o.service==='dine_in','Only table orders can transfer.');assert(!['completed','cancelled'].includes(o.status),'Order is closed.');assert(db.prepare('SELECT id FROM dining_tables WHERE id=? AND tenant_id=? AND outlet_id=?').get(b.tableId,ctx.tenantId,ctx.outletId),'Destination table not found.',404);b.tableId=seatingGroup(db,ctx,b.tableId).rootId;assert(o.table_id!==b.tableId,'Select another table.');db.prepare('UPDATE orders SET table_id=?,updated_at=?,version=version+1 WHERE id=?').run(b.tableId,now(),orderId);audit(db,ctx,'table.order_transferred',orderId,{from:o.table_id,to:b.tableId,reason:b.reason});return orderDetail(db,ctx,orderId);});
}
export function disposeLot(db,ctx,lotId,input){
  permit(ctx,'inventory','hold');assert(['owner','manager','safety'].includes(ctx.user.role),'Management or safety approval is required.',403);const b=z.object({quantity:z.number().int().positive(),reason:z.string().min(3).max(1000)}).parse(input);
  return transaction(db,()=>{const l=db.prepare('SELECT * FROM lots WHERE id=? AND tenant_id=? AND outlet_id=?').get(lotId,ctx.tenantId,ctx.outletId);assert(l,'Lot not found.',404);const reserved=db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM reservations WHERE lot_id=? AND status='reserved'").get(lotId).n;assert(!reserved,'Resolve reserved orders before disposing this lot.');assert(b.quantity<=l.quantity,'Disposal quantity exceeds the lot balance.');db.prepare('UPDATE lots SET quantity=quantity-? WHERE id=?').run(b.quantity,lotId);db.prepare('INSERT INTO movements VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id('mov'),ctx.tenantId,ctx.outletId,l.ingredient_id,lotId,-b.quantity,'disposal',lotId,ctx.user.id,b.reason,now());audit(db,ctx,'lot.disposed',lotId,{quantity:b.quantity,reason:b.reason,previousStatus:l.status});return {ok:true,cost:b.quantity*l.unit_cost};});
}

export function packLine(db,ctx,orderId,input){
  permit(ctx,'orders');const b=z.object({lineId:z.string(),quantity:z.number().int().nonnegative(),reason:z.string().min(3).max(500)}).parse(input);
  return transaction(db,()=>{const order=orderDetail(db,ctx,orderId);assert(['takeaway','pickup','delivery'].includes(order.service),'This service does not require packing.');assert(order.status==='ready','All stations must be ready before packing.',409);const line=order.lines.find(l=>l.id===b.lineId);assert(line,'Order line not found.',404);assert(b.quantity<=line.quantity,'Packing quantity exceeds the item quantity.');if(line.packed===b.quantity)return order;db.prepare('INSERT INTO line_service(line_id,packed) VALUES(?,?) ON CONFLICT(line_id) DO UPDATE SET packed=excluded.packed').run(line.id,b.quantity);audit(db,ctx,'order.packing_checked',orderId,{lineId:line.id,previous:line.packed,packed:b.quantity,reason:b.reason});return orderDetail(db,ctx,orderId);});
}

export function controlOrder(db,ctx,orderId,input){
  permit(ctx,'orders','create');const b=z.object({action:z.enum(['hold','resume','assign']),userId:z.string().optional(),reason:z.string().min(3).max(500)}).parse(input);
  return transaction(db,()=>{const o=orderDetail(db,ctx,orderId);assert(!['cancelled','completed','handed_over'].includes(o.status),'Order is closed or handed over.',409);db.prepare('INSERT OR IGNORE INTO order_controls(order_id) VALUES(?)').run(o.id);if(b.action==='assign'){const u=db.prepare('SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1').get(b.userId,ctx.tenantId);assert(u&&JSON.parse(u.outlet_ids).includes(ctx.outletId),'Select an active operator assigned to this outlet.');assert(['owner','manager','cashier','waiter'].includes(u.role),'The assigned user must be a service operator.');db.prepare('UPDATE order_controls SET assigned_user_id=? WHERE order_id=?').run(u.id,o.id);}
    if(b.action==='hold'){assert(o.status==='accepted'&&o.lines.every(l=>!l.consumed),'Only an unprepared accepted order can be held.',409);const tasks=o.tasks.filter(t=>t.status==='queued').map(t=>t.id);db.prepare('UPDATE order_controls SET held_tasks=? WHERE order_id=?').run(JSON.stringify(tasks),o.id);db.prepare("UPDATE tasks SET status='held' WHERE order_id=? AND status='queued'").run(o.id);db.prepare("UPDATE orders SET status='held',version=version+1,updated_at=? WHERE id=?").run(now(),o.id);}
    if(b.action==='resume'){assert(o.status==='held','This order is not held.',409);const tasks=JSON.parse(db.prepare('SELECT held_tasks FROM order_controls WHERE order_id=?').get(o.id).held_tasks);for(const tid of tasks)db.prepare("UPDATE tasks SET status='queued' WHERE id=? AND order_id=? AND status='held'").run(tid,o.id);db.prepare("UPDATE orders SET status='accepted',version=version+1,updated_at=? WHERE id=?").run(now(),o.id);db.prepare("UPDATE order_controls SET held_tasks='[]' WHERE order_id=?").run(o.id);}
    audit(db,ctx,`order.${b.action}`,o.id,{reason:b.reason,fromUser:o.assignedUserId,toUser:b.userId});return orderDetail(db,ctx,o.id);});
}

export function splitBySeat(db,ctx,orderId,input){
  permit(ctx,'orders');const b=z.object({reason:z.string().min(3).max(1000)}).parse(input);const order=orderDetail(db,ctx,orderId);assert(order.service==='dine_in','Seat splitting is for table service.');
  const shareRows=db.prepare('SELECT s.line_id lineId,s.seat,s.quantity FROM line_seat_units s JOIN order_lines l ON l.id=s.line_id WHERE l.order_id=?').all(orderId);
  const sharesByLine=new Map();for(const r of shareRows){if(!sharesByLine.has(r.lineId))sharesByLine.set(r.lineId,[]);sharesByLine.get(r.lineId).push(r);}
  const grossBySeat=new Map(),lineIds=new Map();
  for(const l of order.lines){const lineGross=l.quantity*l.unit_price,shares=sharesByLine.get(l.id);
    if(shares&&shares.length)for(const s of shares)grossBySeat.set(s.seat,(grossBySeat.get(s.seat)||0)+Math.round(lineGross*s.quantity/l.quantity));
    else{const seat=l.seat||0;grossBySeat.set(seat,(grossBySeat.get(seat)||0)+lineGross);if(!lineIds.has(seat))lineIds.set(seat,[]);lineIds.get(seat).push(l.id);}
  }
  const entries=[...grossBySeat].sort((a,b)=>a[0]-b[0]);assert(entries.length>=2,'Assign at least two seats or share a line across seats before splitting.');
  const gross=entries.reduce((s,[,g])=>s+g,0);assert(gross>0,'Order total is not splittable.');
  let allocated=0;const parts=entries.map(([seat,seatGross],index)=>{const amount=index===entries.length-1?order.total-allocated:Math.round(seatGross/gross*order.total);allocated+=amount;return {name:seat?`Seat ${seat}`:'Unassigned / shared',amount,lineIds:lineIds.get(seat)||[]};});
  return splitBill(db,ctx,orderId,{parts,reason:b.reason});
}

// ORD-13 — a shared item (for example a starter) consumed by several diners at
// one table is apportioned per unit across seats, so a by-seat split charges
// each diner for their share rather than all of it to one seat.
export function shareLineAcrossSeats(db,ctx,orderId,input){
  permit(ctx,'orders');const b=z.object({lineId:z.string(),shares:z.array(z.object({seat:z.number().int().min(1).max(100),quantity:z.number().int().positive().max(1000)}).strict()).min(2).max(30),reason:z.string().min(3).max(1000)}).strict().parse(input);
  return transaction(db,()=>{
    const order=orderDetail(db,ctx,orderId);assert(order.service==='dine_in','Seat sharing is for table service.');assert(order.paid===0&&order.splits.length===0,'Share lines across seats before payment or bill splitting.');
    const line=order.lines.find(l=>l.id===b.lineId);assert(line,'Order line not found.',404);
    assert(new Set(b.shares.map(s=>s.seat)).size===b.shares.length,'A seat can appear only once.');
    assert(b.shares.reduce((s,x)=>s+x.quantity,0)===line.quantity,'Shared quantities must sum to the line quantity.');
    db.prepare('DELETE FROM line_seat_units WHERE line_id=?').run(line.id);
    for(const s of b.shares)db.prepare('INSERT INTO line_seat_units VALUES(?,?,?)').run(line.id,s.seat,s.quantity);
    audit(db,ctx,'order.line_seat_shared',orderId,{lineId:line.id,shares:b.shares,reason:b.reason});
    return {lineId:line.id,quantity:line.quantity,shares:b.shares};
  });
}
export function lineSeatShares(db,ctx,orderId){permit(ctx,'orders','read');orderDetail(db,ctx,orderId);return db.prepare('SELECT s.line_id lineId,s.seat,s.quantity FROM line_seat_units s JOIN order_lines l ON l.id=s.line_id WHERE l.order_id=? ORDER BY s.seat').all(orderId);}

// Stage 2 gate — corrections after a prepared item has been settled. A prepared
// (already consumed) line can only be reduced through this controlled workflow:
// a manager/owner/accountant records evidence, the unsent portion is written off
// as an inventory loss (never silently restored to stock), and the overpaid
// difference is returned through the controlled refund path.
export function correctPreparedItem(db,ctx,orderId,input){
  permit(ctx,'orders');assert(['owner','manager','accountant'].includes(ctx.user.role),'A manager, accountant or owner may correct a prepared item.',403);
  const body=z.object({lineId:z.string().min(1).max(200),reducedTo:z.number().int().positive().max(1000),reason:z.string().trim().min(3).max(1000),evidence:z.string().trim().min(3).max(1000),idempotencyKey:z.string().min(8).max(160)}).strict().parse(input);
  return transaction(db,()=>{
    const prior=db.prepare('SELECT * FROM line_corrections WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);
    if(prior){assert(prior.order_id===orderId,'This correction key belongs to another order.',409);return orderLineCorrections(db,ctx,orderId);}
    const order=orderDetail(db,ctx,orderId);assert(order.status!=='cancelled','A cancelled order cannot be corrected.',409);
    const line=order.lines.find(l=>l.id===body.lineId);assert(line,'Order line not found.',404);
    assert(line.consumed,'This line was not prepared. Remove it through an amendment instead.',409);
    assert(body.reducedTo<line.quantity,'The corrected quantity must be lower than the prepared quantity.',409);
    assert(order.paymentStatus!=='unpaid','Settle or split the bill before correcting a prepared item; open-bill changes use amendments.',409);
    const payment=order.payments.filter(p=>p.status==='recorded').sort((a,b)=>b.created_at.localeCompare(a.created_at)).find(p=>order.refunds.filter(r=>r.payment_id===p.id).reduce((s,r)=>s+r.amount,0)<p.amount);
    assert(payment,'No refundable payment balance remains for this correction; record a manager goodwill adjustment instead.',409);
    const removed=line.quantity-body.reducedTo;
    const discountScale=(order.total+order.discount)>0?(order.total+order.discount):line.quantity*line.unit_price;
    const amount=Math.round(removed*line.unit_price*order.total/discountScale);
    assert(amount>0&&amount<=order.total,'Calculated correction amount is out of range.',409);
    const reservations=db.prepare("SELECT r.*,l.unit_cost FROM reservations r JOIN lots l ON l.id=r.lot_id WHERE r.line_id=? AND r.status='consumed'").all(line.id);
    const consumedCost=reservations.reduce((s,r)=>s+r.quantity*r.unit_cost,0);
    const lossCost=Math.round(consumedCost*removed/line.quantity);
    const cid=id('corr');
    db.prepare('INSERT INTO line_corrections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(cid,ctx.tenantId,ctx.outletId,orderId,line.id,line.quantity,body.reducedTo,amount,body.reason,body.evidence,ctx.user.id,body.idempotencyKey,now());
    if(lossCost>0)journal(db,ctx,cid,'correction',[{account:'Inventory loss',debit:lossCost},{account:'Food cost',credit:lossCost}]);
    refund(db,ctx,orderId,{paymentId:payment.id,amount,reason:`Prepared-item correction · ${body.reason}`,idempotencyKey:`corr-refund-${cid}`});
    audit(db,ctx,'order.prepared_corrected',cid,{orderId,lineId:line.id,oldQuantity:line.quantity,newQuantity:body.reducedTo,amount,lossCost,evidence:body.evidence});
    const corrections=orderLineCorrections(db,ctx,orderId);
    return {correction:corrections[0],refunded:amount,line:{id:line.id,name:line.name,oldQuantity:line.quantity,newQuantity:body.reducedTo}};
  });
}
export function orderLineCorrections(db,ctx,orderId){
  permit(ctx,'orders','read');
  return db.prepare('SELECT c.*,l.name line_name FROM line_corrections c JOIN order_lines l ON l.id=c.line_id WHERE c.order_id=? AND c.tenant_id=? AND c.outlet_id=? ORDER BY c.created_at').all(orderId,ctx.tenantId,ctx.outletId);
}
