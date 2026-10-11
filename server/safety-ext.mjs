import { z } from 'zod';
import {traceDescendants} from './traceability.mjs';
import { id,now,businessDate,transaction,audit } from './db.mjs';
import { assert,permit,getRecord,parseRecord } from './domain.mjs';

// CORE-08 completion — a controlled recall review that proves the affected
// stock is held and every exposed order is accounted for before the recall is
// closed, plus the external notification adapters a recall depends on and the
// bulk-service consumer identity link that individual servings cannot infer.
const text=z.string().max(4000);
const key=z.string().min(8).max(160);
const insertRecord=(db,ctx,module,status,data)=>{const rid=id(module),stamp=now();db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?)').run(rid,ctx.tenantId,ctx.entityId,ctx.outletId,module,status,JSON.stringify(data),1,stamp,stamp);return rid;};
const outputLots=(db,ctx,batchId)=>db.prepare('SELECT * FROM lots WHERE origin=? AND tenant_id=? AND outlet_id=?').all(batchId,ctx.tenantId,ctx.outletId);

export function recallReview(db,ctx,sourceId,input){
  permit(ctx,'safety');assert(['owner','manager','safety'].includes(ctx.user.role),'A food-safety responsible person must review the recall.',403);
  const body=z.object({version:z.number().int().positive().optional(),evidence:text.min(3),notify:z.boolean().default(true),idempotencyKey:key.optional()}).strict().parse(input);
  return transaction(db,()=>{
    const record=parseRecord(db.prepare('SELECT * FROM records WHERE id=? AND tenant_id=? AND outlet_id=?').get(sourceId,ctx.tenantId,ctx.outletId));
    let label,rootLots;
    if(record){assert(record.module==='batches','A recall review must reference a production batch or a source lot.',404);assert(body.version===undefined||record.version===body.version,'This batch changed. Refresh before reviewing.',409);label=record.data.name;rootLots=outputLots(db,ctx,record.id);}
    else{const lot=db.prepare('SELECT * FROM lots WHERE id=? AND tenant_id=? AND outlet_id=?').get(sourceId,ctx.tenantId,ctx.outletId);assert(lot,'Recall source not found.',404);label=`Lot ${lot.code}`;rootLots=[lot];}
    assert(rootLots.length,'This source has no lot to trace.',409);
    const held=new Set(db.prepare("SELECT lot_id FROM recall_holds WHERE released_at IS NULL").all().map(r=>r.lot_id));
    const exposure=new Map();const affected=new Map();let restricted=false,truncated=false;
    for(const lot of rootLots){
      const trace=traceDescendants(db,ctx,lot);if(trace.restrictedLinks)restricted=true;if(trace.truncated)truncated=true;
      for(const l of trace.lots)affected.set(l.id,l);
      for(const o of trace.orders)exposure.set(o.id,o);
    }
    assert(!restricted&&!truncated,'The recall chain crosses outlets or exceeds the trace limit. An authorised recall lead must review the complete chain.',409);
    const unheld=rootLots.filter(l=>l.quantity>0&&!held.has(l.id));
    assert(!unheld.length,`Hold every affected lot before closing the review (${unheld.length} lot(s) with stock remain unheld).`,409);
    assert(exposure.size||body.evidence,'Record the review evidence when no exposed order was traced.',409);
    const reviewId=insertRecord(db,ctx,'recall_reviews','reviewed',{name:`Recall review · ${label}`,batchId:record?record.id:null,sourceLotId:record?null:rootLots[0].id,batchStatus:record?.status||null,affectedLots:[...affected.values()].map(l=>({id:l.id,code:l.code,ingredientId:l.ingredient_id,quantity:l.quantity,status:l.status})),exposedOrders:[...exposure.values()].map(o=>({id:o.id,number:o.number,service:o.service,status:o.status})),evidence:body.evidence,reviewedAt:now(),reviewedBy:ctx.user.name});
    let queued=0;
    if(body.notify)for(const o of exposure.values()){const recipient=o.customer&&o.customer.trim()?o.customer:`order ${o.number}`;queueNotification(db,ctx,{kind:'recall_notice',recipient,body:`Recall for ${label}. Order ${o.number} is affected. Do not consume; contact the outlet.`,idempotencyKey:`recall:${reviewId}:${o.id}`});queued++;}
    audit(db,ctx,'safety.recall_reviewed',reviewId,{sourceId,affectedLots:affected.size,exposedOrders:exposure.size,notifications:queued});
    return {reviewId,affectedLots:affected.size,exposedOrders:exposure.size,notificationsQueued:queued,lots:[...affected.values()].map(l=>({id:l.id,code:l.code,status:l.status}))};
  });
}
export function recallReviews(db,ctx){
  permit(ctx,'safety','read');
  return db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='recall_reviews' ORDER BY created_at DESC LIMIT 200").all(ctx.tenantId,ctx.outletId).map(parseRecord);
}

/* External notification adapters — a provider is registered per channel; a
   recall or campaign can queue notices, but transmission requires a validated
   provider adapter supplied out of band (as with the ASP interface). */
export const notificationProviders=()=>[
  {id:'whatsapp_business',name:'WhatsApp Business Platform',requires:'Meta Business verification, phone number and message templates'},
  {id:'sms_gateway',name:'Regional SMS gateway',requires:'Registered sender ID and provider credentials'},
  {id:'email_relay',name:'Transactional email relay',requires:'Verified sending domain and API credentials'},
];
const notificationAdapters=new Map();
export function registerNotificationAdapter(providerId,adapter){assert(notificationProviders().some(p=>p.id===providerId),'Unknown notification provider.',404);assert(adapter&&typeof adapter.send==='function','A notification adapter must expose send().',400);notificationAdapters.set(providerId,adapter);return {providerId};}
export function notificationConfig(db,ctx){
  const setting=db.prepare("SELECT value FROM settings WHERE tenant_id=? AND outlet_id=? AND key='notifications'").get(ctx.tenantId,ctx.outletId);
  const value=setting?JSON.parse(setting.value):null;
  return value?{...value,enabled:notificationAdapters.has(value.providerId)}:null;
}
export function selectNotificationProvider(db,ctx,input){
  permit(ctx,'settings');assert(ctx.user.role==='owner','Only an owner can select the notification provider.',403);
  const body=z.object({providerId:z.enum(notificationProviders().map(p=>p.id)),evidence:text.min(3)}).strict().parse(input);
  return transaction(db,()=>{
    const config={providerId:body.providerId,evidence:body.evidence,selectedAt:now(),selectedBy:ctx.user.id,enabled:notificationAdapters.has(body.providerId)};
    db.prepare("INSERT INTO settings(tenant_id,outlet_id,key,value) VALUES(?,?,?,?) ON CONFLICT(tenant_id,outlet_id,key) DO UPDATE SET value=excluded.value").run(ctx.tenantId,ctx.outletId,'notifications',JSON.stringify(config));
    audit(db,ctx,'notification.provider_selected',body.providerId,{enabled:config.enabled});
    return config;
  });
}
export function queueNotification(db,ctx,input){
  const body=z.object({kind:z.enum(['recall_notice','campaign','service_message','booking_reminder']),recipient:z.string().trim().min(1).max(200),body:z.string().trim().min(1).max(1000),channel:z.string().max(40).default(''),idempotencyKey:key}).strict().parse(input);
  const prior=db.prepare('SELECT * FROM notification_outbox WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);
  if(prior)return prior;
  const nid=id('notify'),stamp=now();
  db.prepare('INSERT INTO notification_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(nid,ctx.tenantId,ctx.outletId,body.kind,body.recipient,body.body,'queued',null,null,body.idempotencyKey,stamp,stamp);
  return db.prepare('SELECT * FROM notification_outbox WHERE id=?').get(nid);
}
export function notificationOutbox(db,ctx){
  permit(ctx,'safety','read');
  return {config:notificationConfig(db,ctx),providers:notificationProviders(),items:db.prepare('SELECT * FROM notification_outbox WHERE tenant_id=? AND outlet_id=? ORDER BY created_at DESC LIMIT 300').all(ctx.tenantId,ctx.outletId)};
}
export function dispatchNotifications(db,ctx,input={}){
  permit(ctx,'safety');assert(['owner','manager','safety'].includes(ctx.user.role),'An authorised operator must dispatch notifications.',403);
  const config=notificationConfig(db,ctx);assert(config&&config.enabled,'Select a validated notification provider before dispatching.',409);
  const adapter=notificationAdapters.get(config.providerId);
  const body=z.object({limit:z.number().int().positive().max(500).default(100)}).strict().parse(input);
  return transaction(db,()=>{
    const rows=db.prepare("SELECT * FROM notification_outbox WHERE tenant_id=? AND outlet_id=? AND status='queued' ORDER BY created_at LIMIT ?").all(ctx.tenantId,ctx.outletId,body.limit);
    let sent=0,failed=0;
    for(const row of rows){
      try{const result=adapter.send({kind:row.kind,recipient:row.recipient,body:row.body})||{};db.prepare("UPDATE notification_outbox SET status='sent',provider_reference=?,last_error=NULL,updated_at=? WHERE id=?").run(result.reference||null,now(),row.id);sent++;}
      catch(e){db.prepare("UPDATE notification_outbox SET status='failed',last_error=?,updated_at=? WHERE id=?").run(String(e.message||e).slice(0,500),now(),row.id);failed++;}
    }
    audit(db,ctx,'notification.dispatched',config.providerId,{sent,failed,attempted:rows.length});
    return {attempted:rows.length,sent,failed,providerId:config.providerId};
  });
}

/* Bulk-service consumer identity — link an individual scan to an eater so a
   recall can identify a person, not just a serving count. Group counts cannot
   identify individuals and are reported separately. */
export function linkScanEater(db,ctx,input){
  permit(ctx,'catering');assert(['owner','manager','safety'].includes(ctx.user.role),'Manager or safety permission is required to link identity.',403);
  const body=z.object({scanId:z.string().min(1).max(200),eaterId:z.string().min(1).max(200)}).strict().parse(input);
  return transaction(db,()=>{
    const scan=db.prepare('SELECT * FROM serving_scans WHERE id=? AND tenant_id=? AND outlet_id=?').get(body.scanId,ctx.tenantId,ctx.outletId);assert(scan,'Serving scan not found.',404);
    const eater=getRecord(db,ctx,body.eaterId);assert(eater.module==='eaters','Select an eater record.',404);assert(eater.status==='active','Only an active eater can be linked.',409);
    assert(eater.data.contractId===scan.contract_id,'The eater belongs to a different contract than this scan.',409);
    const existing=db.prepare('SELECT * FROM scan_eaters WHERE scan_id=?').get(scan.id);
    if(existing){assert(existing.eater_id===eater.id,'This scan is already linked to another eater.',409);return existing;}
    db.prepare('INSERT INTO scan_eaters VALUES(?,?,?,?,?)').run(scan.id,eater.id,ctx.tenantId,ctx.outletId,now());
    audit(db,ctx,'catering.scan_eater_linked',scan.id,{eaterId:eater.id,contractId:scan.contract_id});
    return db.prepare('SELECT * FROM scan_eaters WHERE scan_id=?').get(scan.id);
  });
}
export function bulkIdentityReport(db,ctx,contractId,date){
  permit(ctx,'catering','read');
  const scanRows=db.prepare('SELECT * FROM serving_scans WHERE tenant_id=? AND outlet_id=? AND contract_id=? AND (? IS NULL OR date=?)').all(ctx.tenantId,ctx.outletId,contractId,date,date);
  const linked=new Set(db.prepare('SELECT scan_id FROM scan_eaters WHERE tenant_id=? AND outlet_id=?').all(ctx.tenantId,ctx.outletId).map(r=>r.scan_id));
  const individual=scanRows.filter(s=>s.source!=='group'&&s.status!=='conflict');
  const identified=individual.filter(s=>linked.has(s.id));
  const groupCounts=scanRows.filter(s=>s.source==='group');
  return {contractId,date:date||null,scans:scanRows.length,individual:individual.length,identified:identified.length,unidentified:individual.length-identified.length,groupCounts:groupCounts.length,groupUnits:groupCounts.reduce((s,r)=>s+r.quantity,0),traceability:'Individual scans can be resolved to a person for recall; group counts cannot establish individual consumer identity.'};
}

export function mountSafetyExt(app,db){
  app.post('/api/safety/recalls/:batchId/review',(req,res)=>res.json(recallReview(db,req.ctx,req.params.batchId,req.body)));
  app.get('/api/safety/recalls',(req,res)=>res.json(recallReviews(db,req.ctx)));
  app.get('/api/safety/notifications',(req,res)=>res.json(notificationOutbox(db,req.ctx)));
  app.post('/api/safety/notifications/provider',(req,res)=>res.json(selectNotificationProvider(db,req.ctx,req.body)));
  app.post('/api/safety/notifications/dispatch',(req,res)=>res.json(dispatchNotifications(db,req.ctx,req.body)));
  app.post('/api/catering/servings/:scanId/eater',(req,res)=>res.json(linkScanEater(db,req.ctx,{scanId:req.params.scanId,eaterId:req.body.eaterId})));
  app.get('/api/catering/contracts/:id/identity',(req,res)=>res.json(bulkIdentityReport(db,req.ctx,req.params.id,req.query.date)));
}
