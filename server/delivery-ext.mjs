import { z } from 'zod';
import { id,now,businessDate,transaction,audit } from './db.mjs';
import { assert,permit,getRecord,orderDetail } from './domain.mjs';

// Delivery completion — route plans that sequence assigned deliveries by
// promised time, with dispatch/complete lifecycle and a daily board.
const text=z.string().max(4000);
const parsed=r=>r?{...r,stops:JSON.parse(r.stops)}:null;
const routeRow=(db,ctx,routeId)=>parsed(db.prepare('SELECT * FROM route_plans WHERE id=? AND tenant_id=? AND outlet_id=?').get(routeId,ctx.tenantId,ctx.outletId));
const deliveriesFor=(db,ctx,orderIds)=>orderIds.map(orderId=>{
  const d=db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='deliveries' AND json_extract(data,'$.orderId')=? ORDER BY created_at DESC LIMIT 1").get(ctx.tenantId,ctx.outletId,orderId);
  assert(d,'Create the delivery assignment before adding the order to a route.',404);
  const order=orderDetail(db,ctx,orderId);assert(order.service==='delivery','Only delivery orders can be routed.',409);
  return {deliveryId:d.id,record:JSON.parse(d.data),order};
});

export function planRoute(db,ctx,input){
  permit(ctx,'delivery');
  const body=z.object({name:z.string().trim().min(1).max(200),driver:z.string().trim().min(1).max(120),zone:z.string().trim().max(120).default(''),date:z.iso.date(),orderIds:z.array(z.string().min(1)).min(1).max(50)}).strict().parse(input);
  assert(new Set(body.orderIds).size===body.orderIds.length,'An order can appear only once on a route.');
  return transaction(db,()=>{
    const resolved=deliveriesFor(db,ctx,body.orderIds);
    const stops=resolved.map(({deliveryId,record,order})=>({deliveryId,orderId:order.id,number:order.number,address:record.address||'',zone:record.zone||body.zone,promisedAt:record.promisedAt||'',status:'assigned'})).sort((a,b)=>(a.promisedAt||'').localeCompare(b.promisedAt||''));
    stops.forEach((s,i)=>{s.sequence=i+1;});
    const rid=id('route');
    db.prepare('INSERT INTO route_plans VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(rid,ctx.tenantId,ctx.outletId,body.name,body.driver,body.zone||stops[0]?.zone||'',body.date,'planned',JSON.stringify(stops),now(),now());
    audit(db,ctx,'delivery.route_planned',rid,{driver:body.driver,stops:stops.length});
    return routeRow(db,ctx,rid);
  });
}
export function routePlans(db,ctx,date){
  permit(ctx,'delivery','read');
  const rows=db.prepare('SELECT * FROM route_plans WHERE tenant_id=? AND outlet_id=? ORDER BY date DESC,created_at DESC LIMIT 200').all(ctx.tenantId,ctx.outletId).map(parsed);
  return date?rows.filter(r=>r.date===date):rows;
}
export function routeAction(db,ctx,routeId,input){
  permit(ctx,'delivery');
  const body=z.object({action:z.enum(['dispatched','completed','cancelled']),evidence:text.default('')}).strict().parse(input);
  return transaction(db,()=>{
    const route=db.prepare('SELECT * FROM route_plans WHERE id=? AND tenant_id=? AND outlet_id=?').get(routeId,ctx.tenantId,ctx.outletId);assert(route,'Route plan not found.',404);
    if(body.action==='dispatched'){assert(route.status==='planned','Only a planned route can be dispatched.',409);assert(body.evidence.trim(),'Dispatch evidence is required.');}
    if(body.action==='completed'){assert(route.status==='dispatched','Dispatch the route before completing it.',409);assert(body.evidence.trim(),'Completion evidence is required.');}
    if(body.action==='cancelled'){assert(['planned','dispatched'].includes(route.status),'This route is already closed.',409);assert(body.evidence.trim(),'A cancellation reason is required.');}
    db.prepare('UPDATE route_plans SET status=?,updated_at=? WHERE id=?').run(body.action,now(),routeId);
    audit(db,ctx,`delivery.route_${body.action}`,routeId,{stops:JSON.parse(route.stops).length,evidence:body.evidence});
    return routeRow(db,ctx,routeId);
  });
}
export function routeBoard(db,ctx,date=businessDate()){
  permit(ctx,'delivery','read');
  const routes=routePlans(db,ctx,date),unrouted=[];
  const planned=new Set(routes.flatMap(r=>r.stops.map(s=>s.orderId)));
  for(const d of db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='deliveries' AND status IN ('assigned','dispatched')").all(ctx.tenantId,ctx.outletId)){
    const data=JSON.parse(d.data);if(!planned.has(data.orderId))unrouted.push({deliveryId:d.id,orderId:data.orderId,driver:data.driver,zone:data.zone,promisedAt:data.promisedAt,status:d.status});
  }
  return {date,routes,unrouted,counts:{routes:routes.length,stops:routes.reduce((s,r)=>s+r.stops.length,0),unrouted:unrouted.length}};
}

export function mountDeliveryExt(app,db){
  app.post('/api/delivery/routes',(req,res)=>res.status(201).json(planRoute(db,req.ctx,req.body)));
  app.get('/api/delivery/routes',(req,res)=>res.json(routePlans(db,req.ctx,req.query.date)));
  app.get('/api/delivery/board',(req,res)=>res.json(routeBoard(db,req.ctx,req.query.date||businessDate())));
  app.post('/api/delivery/routes/:id/action',(req,res)=>res.json(routeAction(db,req.ctx,req.params.id,req.body)));
}
