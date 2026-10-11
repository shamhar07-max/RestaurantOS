import { z } from 'zod';
import { id,now,transaction,audit } from './db.mjs';
import { assert,permit,createOrder,parseRecord,getRecord } from './domain.mjs';

// Channel menu-ID mapping and import exception queue (ORD-08).
// An unknown external menu reference never partially applies: the whole import is
// rejected and a durable, actionable exception record is queued for an operator.
const channels=z.enum(['Talabat','Deliveroo','Careem','Direct']);
const services=z.enum(['dine_in','takeaway','pickup','delivery','preorder','catering']);
const importBody=z.object({
  channel:channels,
  externalOrderId:z.string().min(1).max(160),
  service:services,
  customer:z.string().max(300).default(''),
  notes:z.string().max(1000).default(''),
  lines:z.array(z.object({externalItemId:z.string().min(1).max(160),externalName:z.string().max(300).default(''),quantity:z.number().int().min(1).max(100)})).min(1).max(100),
}).strict();

const importKey=(channel,externalOrderId)=>`channel:${channel}:${externalOrderId}`;
function mapping(db,ctx,channel,externalId){return db.prepare('SELECT * FROM channel_items WHERE tenant_id=? AND outlet_id=? AND channel=? AND external_id=?').get(ctx.tenantId,ctx.outletId,channel,externalId);}
function openException(db,ctx,channel,externalOrderId){return parseRecord(db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='mapping_exceptions' AND status='open' AND json_extract(data,'$.channel')=? AND json_extract(data,'$.externalOrderId')=?").get(ctx.tenantId,ctx.outletId,channel,externalOrderId));}
function resolveLines(db,ctx,body){
  const mapped=[],unresolved=[];
  for(const l of body.lines){const m=mapping(db,ctx,body.channel,l.externalItemId);if(m)mapped.push({itemId:m.item_id,quantity:l.quantity});else unresolved.push(l);}
  return {mapped,unresolved};
}
function queueException(db,ctx,body,unresolved){
  const prior=openException(db,ctx,body.channel,body.externalOrderId),stamp=now();
  const ids=[...new Set(unresolved.map(u=>u.externalItemId))];
  const data={name:`${body.channel} · ${body.externalOrderId}`,channel:body.channel,externalId:ids.join(', '),externalOrderId:body.externalOrderId,reason:`Map ${ids.length} unknown menu reference${ids.length===1?'':'s'} for this channel order, then retry the import.`,payload:body,unresolved:ids,attempts:(prior?.data.attempts||0)+1,lastSeenAt:stamp};
  if(prior)db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(data),stamp,prior.id);
  else db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?)').run(id('mapping_exceptions'),ctx.tenantId,ctx.entityId,ctx.outletId,'mapping_exceptions','open',JSON.stringify(data),1,stamp,stamp);
  audit(db,ctx,'channel.mapping_exception_queued',prior?.id||data.externalOrderId,{channel:body.channel,externalOrderId:body.externalOrderId,unresolved:ids});
  return prior?.id||db.prepare("SELECT id FROM records WHERE tenant_id=? AND outlet_id=? AND module='mapping_exceptions' AND status='open' AND json_extract(data,'$.channel')=? AND json_extract(data,'$.externalOrderId')=?").get(ctx.tenantId,ctx.outletId,body.channel,body.externalOrderId).id;
}
function applyImport(db,ctx,body){
  const {mapped,unresolved}=resolveLines(db,ctx,body);
  if(unresolved.length){const exceptionId=transaction(db,()=>queueException(db,ctx,body,unresolved));const error=new Error(`Import rejected: ${unresolved.length} channel menu reference${unresolved.length===1?'':'s'} are not mapped (${[...new Set(unresolved.map(u=>u.externalItemId))].join(', ')}). Correct the mapping and retry; no part of the order was applied.`);error.status=409;error.exceptionId=exceptionId;throw error;}
  return transaction(db,()=>{const order=createOrder(db,ctx,{service:body.service,channel:body.channel,customer:body.customer,notes:body.notes,idempotencyKey:importKey(body.channel,body.externalOrderId),lines:mapped});
    const open=openException(db,ctx,body.channel,body.externalOrderId);
    if(open)db.prepare("UPDATE records SET status='resolved',data=?,version=version+1,updated_at=? WHERE id=?").run(JSON.stringify({...open.data,unresolved:[],resolvedOrderId:order.id,resolvedAt:now()}),now(),open.id);
    audit(db,ctx,'channel.order_imported',order.id,{channel:body.channel,externalOrderId:body.externalOrderId});
    return {order,status:'imported'};});
}

// ORD-14 — publish a brand menu to several channels; a failing channel does not
// block the others and the response identifies exactly which channels failed.
const publicationBody=z.object({brand:z.string().trim().min(1).max(100),itemIds:z.array(z.string().min(1)).max(200).optional(),note:z.string().max(500).default(''),channels:z.array(z.object({channel:channels,itemIds:z.array(z.string().min(1)).max(200).optional()}).strict()).min(1).max(20)}).strict();
export function publishMenu(db,ctx,input){
  permit(ctx,'channels');
  const b=publicationBody.parse(input);
  assert(new Set(b.channels.map(c=>c.channel)).size===b.channels.length,'Choose each channel once per publication.');
  return transaction(db,()=>{
    const results=b.channels.map(entry=>{
      const ids=entry.itemIds||b.itemIds;
      if(!ids||!ids.length)return {channel:entry.channel,status:'failed',itemCount:0,error:'No menu items were provided for this channel.',missing:[]};
      const missing=ids.filter(iid=>!db.prepare('SELECT id FROM menu WHERE id=? AND tenant_id=? AND outlet_id=?').get(iid,ctx.tenantId,ctx.outletId));
      const status=missing.length?'failed':'published';
      const error=missing.length?`Unknown menu items for this outlet: ${missing.join(', ')}`:'';
      const prior=db.prepare('SELECT * FROM channel_publications WHERE tenant_id=? AND outlet_id=? AND brand=? AND channel=?').get(ctx.tenantId,ctx.outletId,b.brand,entry.channel);
      const stamp=now();
      if(status==='published'){
        if(prior)db.prepare('UPDATE channel_publications SET status=?,items=?,item_count=?,error=?,note=?,version=version+1,updated_at=? WHERE id=?').run(status,JSON.stringify(ids),ids.length,error,b.note,stamp,prior.id);
        else db.prepare('INSERT INTO channel_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id('publication'),ctx.tenantId,ctx.outletId,b.brand,entry.channel,status,JSON.stringify(ids),ids.length,error,b.note,1,stamp,stamp);
      }
      audit(db,ctx,status==='published'?'channel.menu_published':'channel.menu_publish_failed',prior?.id||entry.channel,{brand:b.brand,channel:entry.channel,itemCount:ids.length,missing});
      return {channel:entry.channel,status,itemCount:ids.length,error,missing};
    });
    return {brand:b.brand,results,published:results.filter(r=>r.status==='published').map(r=>r.channel),failed:results.filter(r=>r.status==='failed').map(r=>({channel:r.channel,reason:r.error}))};
  });
}
export function listPublications(db,ctx){
  permit(ctx,'channels','read');
  return db.prepare('SELECT * FROM channel_publications WHERE tenant_id=? AND outlet_id=? ORDER BY brand,channel').all(ctx.tenantId,ctx.outletId).map(r=>({...r,items:JSON.parse(r.items)}));
}

// ORD-15 — station capacity shared between brands. A '*' row is the station's
// shared ceiling; otherwise the outlet brand's row applies.
export function setStationCapacity(db,ctx,input){
  permit(ctx,'channels');
  const b=z.object({station:z.string().min(1).max(40),brand:z.string().trim().min(1).max(100).default('*'),capacity:z.number().int().positive().max(100000)}).strict().parse(input);
  return transaction(db,()=>{
    assert(db.prepare('SELECT id FROM stations WHERE tenant_id=? AND outlet_id=? AND code=?').get(ctx.tenantId,ctx.outletId,b.station),'Select a configured outlet station.',404);
    const prior=db.prepare('SELECT * FROM station_capacity WHERE tenant_id=? AND outlet_id=? AND brand=? AND station=?').get(ctx.tenantId,ctx.outletId,b.brand,b.station),stamp=now();
    if(prior)db.prepare('UPDATE station_capacity SET capacity=?,updated_at=? WHERE id=?').run(b.capacity,stamp,prior.id);
    else db.prepare('INSERT INTO station_capacity VALUES(?,?,?,?,?,?,?)').run(id('capacity'),ctx.tenantId,ctx.outletId,b.brand,b.station,b.capacity,stamp);
    audit(db,ctx,'channel.station_capacity',prior?.id||b.station,{station:b.station,brand:b.brand,capacity:b.capacity});
    return {station:b.station,brand:b.brand,capacity:b.capacity};
  });
}
export function stationCapacityReport(db,ctx){
  permit(ctx,'channels','read');
  const brand=db.prepare('SELECT brand FROM outlets WHERE id=?').get(ctx.outletId)?.brand;
  const rows=db.prepare('SELECT * FROM station_capacity WHERE tenant_id=? AND outlet_id=?').all(ctx.tenantId,ctx.outletId);
  const stations=db.prepare('SELECT name,code FROM stations WHERE tenant_id=? AND outlet_id=?').all(ctx.tenantId,ctx.outletId);
  const loadOf=code=>db.prepare("SELECT COALESCE(SUM(l.quantity),0) n FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.tenant_id=? AND o.outlet_id=? AND o.status IN ('accepted','preparing','held') AND l.station=?").get(ctx.tenantId,ctx.outletId,code).n;
  return {brand,stations:stations.map(s=>{const shared=rows.find(r=>r.station===s.code&&r.brand==='*'),own=rows.find(r=>r.station===s.code&&r.brand===brand);const capacity=(shared||own)?.capacity??null,load=loadOf(s.code);return {station:s.code,name:s.name,capacity,load,available:capacity===null?null:Math.max(0,capacity-load),throttled:capacity!==null&&load>=capacity,shared:!!shared};})};
}

// ORD-16 — match a provider statement to the outlet's actual channel orders.
export function matchChannelSettlement(db,ctx,settlementId,input){
  permit(ctx,'finance');assert(['owner','accountant','manager'].includes(ctx.user.role),'Finance permission is required to match a settlement.',403);
  const b=z.object({date:z.iso.date(),evidence:z.string().trim().min(3).max(1000)}).strict().parse(input);
  return transaction(db,()=>{
    const settlement=getRecord(db,ctx,settlementId);assert(settlement.module==='settlements','Settlement not found.',404);assert(settlement.status==='unmatched','This settlement is already reconciled.',409);
    const orders=db.prepare("SELECT id,total FROM orders WHERE tenant_id=? AND outlet_id=? AND channel=? AND business_date=? AND status NOT IN ('cancelled')").all(ctx.tenantId,ctx.outletId,settlement.data.channel,b.date);
    const actualGross=orders.reduce((s,o)=>s+o.total,0),variance=actualGross-settlement.data.gross;
    db.prepare('DELETE FROM settlement_orders WHERE tenant_id=? AND settlement_id=?').run(ctx.tenantId,settlement.id);
    for(const o of orders)db.prepare('INSERT INTO settlement_orders VALUES(?,?,?,?,?,?,?)').run(id('set_order'),ctx.tenantId,ctx.outletId,settlement.id,o.id,o.total,now());
    db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify({...settlement.data,actualGross,actualOrders:orders.length,matchVariance:variance,matchedAt:now(),matchEvidence:b.evidence,matchDate:b.date}),now(),settlement.id);
    audit(db,ctx,'channel.settlement_matched',settlement.id,{channel:settlement.data.channel,date:b.date,actualGross,statementGross:settlement.data.gross,variance,orders:orders.length});
    return {settlementId:settlement.id,channel:settlement.data.channel,date:b.date,statementGross:settlement.data.gross,actualGross,actualOrders:orders.length,variance,matched:orders.map(o=>o.id)};
  });
}
export function settlementOrders(db,ctx,settlementId){
  permit(ctx,'finance','read');
  const settlement=getRecord(db,ctx,settlementId);assert(settlement.module==='settlements','Settlement not found.',404);
  return {settlementId,actualGross:settlement.data.actualGross??null,matchVariance:settlement.data.matchVariance??null,orders:db.prepare('SELECT so.order_id,so.total,o.number,o.business_date FROM settlement_orders so JOIN orders o ON o.id=so.order_id WHERE so.tenant_id=? AND so.settlement_id=? ORDER BY o.number').all(ctx.tenantId,settlementId)};
}

export function mountChannels(app,db){
  app.get('/api/channels/mappings',(req,res)=>{permit(req.ctx,'channels','read');res.json(db.prepare("SELECT m.*,mo.name item_name FROM channel_items m LEFT JOIN menu mo ON mo.id=m.item_id WHERE m.tenant_id=? AND m.outlet_id=? ORDER BY m.channel,m.external_id").all(req.ctx.tenantId,req.ctx.outletId));});
  app.post('/api/channels/mappings',(req,res)=>{permit(req.ctx,'channels');const b=z.object({channel:channels,externalItemId:z.string().min(1).max(160),externalName:z.string().max(300).default(''),itemId:z.string().min(1)}).strict().parse(req.body);
    res.status(201).json(transaction(db,()=>{const item=db.prepare('SELECT id,name FROM menu WHERE id=? AND tenant_id=? AND outlet_id=?').get(b.itemId,req.ctx.tenantId,req.ctx.outletId);assert(item,'Menu item is not mapped to this outlet.',404);
      const prior=mapping(db,req.ctx,b.channel,b.externalItemId);
      if(prior)db.prepare('UPDATE channel_items SET item_id=?,external_name=? WHERE id=?').run(b.itemId,b.externalName,prior.id);
      else db.prepare('INSERT INTO channel_items VALUES(?,?,?,?,?,?,?,?,?)').run(id('channel_item'),req.ctx.tenantId,req.ctx.outletId,b.channel,b.externalItemId,b.externalName,b.itemId,req.user.id,now());
      audit(db,req.ctx,'channel.mapping_saved',prior?.id||b.externalItemId,{channel:b.channel,externalItemId:b.externalItemId,itemId:b.itemId});return {channel:b.channel,externalItemId:b.externalItemId,itemId:b.itemId,itemName:item.name};}));});
  app.delete('/api/channels/mappings/:id',(req,res)=>{permit(req.ctx,'channels');res.json(transaction(db,()=>{const row=db.prepare('SELECT * FROM channel_items WHERE id=? AND tenant_id=? AND outlet_id=?').get(req.params.id,req.ctx.tenantId,req.ctx.outletId);assert(row,'Channel mapping not found in this outlet.',404);db.prepare('DELETE FROM channel_items WHERE id=?').run(row.id);audit(db,req.ctx,'channel.mapping_deleted',row.id,{channel:row.channel,externalItemId:row.external_id});return {ok:true};}));});
  app.get('/api/channels/exceptions',(req,res)=>{permit(req.ctx,'channels','read');res.json(db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='mapping_exceptions' ORDER BY created_at DESC LIMIT 300").all(req.ctx.tenantId,req.ctx.outletId).map(parseRecord));});
  app.post('/api/channels/import',(req,res)=>{permit(req.ctx,'orders','create');const body=importBody.parse(req.body);res.status(201).json(applyImport(db,req.ctx,body));});
  app.post('/api/channels/exceptions/:id/retry',(req,res)=>{permit(req.ctx,'channels');const b=z.object({version:z.number().int().positive()}).strict().parse(req.body);
    res.json(transaction(db,()=>{const record=parseRecord(db.prepare("SELECT * FROM records WHERE id=? AND tenant_id=? AND outlet_id=? AND module='mapping_exceptions'").get(req.params.id,req.ctx.tenantId,req.ctx.outletId));assert(record,'Mapping exception not found in this outlet.',404);assert(record.status==='open','This mapping exception is already resolved.',409);assert(record.version===b.version,'This exception changed. Refresh before retrying.',409);
      const {mapped,unresolved}=resolveLines(db,req.ctx,record.data.payload);
      if(unresolved.length){const ids=[...new Set(unresolved.map(u=>u.externalItemId))];db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify({...record.data,unresolved:ids,reason:`Still missing ${ids.length} mapping${ids.length===1?'':'s'}: ${ids.join(', ')}.`,attempts:(record.data.attempts||0)+1,lastSeenAt:now()}),now(),record.id);const error=new Error(`Still unresolved: ${ids.join(', ')}. The order was not applied.`);error.status=409;throw error;}
      const order=createOrder(db,req.ctx,{service:record.data.payload.service,channel:record.data.payload.channel,customer:record.data.payload.customer||'',notes:record.data.payload.notes||'',idempotencyKey:importKey(record.data.payload.channel,record.data.payload.externalOrderId),lines:mapped});
      db.prepare("UPDATE records SET status='resolved',data=?,version=version+1,updated_at=? WHERE id=?").run(JSON.stringify({...record.data,unresolved:[],resolvedOrderId:order.id,resolvedAt:now()}),now(),record.id);
      audit(db,req.ctx,'channel.exception_retried',record.id,{orderId:order.id,externalOrderId:record.data.externalOrderId});
      return {order,status:'imported'};}));});
  app.get('/api/channels/publications',(req,res)=>res.json(listPublications(db,req.ctx)));
  app.post('/api/channels/publications',(req,res)=>res.status(201).json(publishMenu(db,req.ctx,req.body)));
  app.get('/api/channels/capacity',(req,res)=>res.json(stationCapacityReport(db,req.ctx)));
  app.post('/api/channels/capacity',(req,res)=>res.json(setStationCapacity(db,req.ctx,req.body)));
  app.post('/api/finance/settlements/:id/match',(req,res)=>res.json(matchChannelSettlement(db,req.ctx,req.params.id,req.body)));
  app.get('/api/finance/settlements/:id/match',(req,res)=>res.json(settlementOrders(db,req.ctx,req.params.id)));
}
