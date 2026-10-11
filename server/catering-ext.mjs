import { z } from 'zod';
import { id,now,businessDate,transaction,audit } from './db.mjs';
import { assert,permit,getRecord } from './domain.mjs';

// Catering completion — versioned event quotes/change orders, equipment returns
// against allocated resources, and actual profitability (quote vs captured
// actual cost).
const text=z.string().max(4000);
const insertRecord=(db,ctx,module,status,data)=>{const rid=id(module),stamp=now();db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?)').run(rid,ctx.tenantId,ctx.entityId,ctx.outletId,module,status,JSON.stringify(data),1,stamp,stamp);return rid;};
const quoteOf=(db,ctx,id_)=>db.prepare('SELECT * FROM records WHERE id=? AND tenant_id=? AND outlet_id=? AND module=?').get(id_,ctx.tenantId,ctx.outletId,'catering_quotes');
const parsed=r=>r?{...r,data:JSON.parse(r.data)}:null;
const event_=(db,ctx,eventId)=>{const e=getRecord(db,ctx,eventId);assert(e.module==='catering','Catering event not found.',404);return e;};
const setEventData=(db,ctx,e,data)=>{db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(data),now(),e.id);};

export function createCateringQuote(db,ctx,input){
  permit(ctx,'catering');
  const body=z.object({eventId:z.string().min(1).max(200),amount:z.number().int().positive().max(1_000_000_000),notes:text,evidence:text.min(1)}).strict().parse(input);
  return transaction(db,()=>{
    const event=event_(db,ctx,body.eventId);assert(!['served','closed'].includes(event.status),'Quotes cannot change after service has finished.',409);
    const prior=db.prepare("SELECT id FROM records WHERE tenant_id=? AND outlet_id=? AND module='catering_quotes' AND json_extract(data,'$.eventId')=? AND status!='superseded'").all(ctx.tenantId,ctx.outletId,body.eventId);
    for(const p of prior)db.prepare("UPDATE records SET status='superseded',version=version+1,updated_at=? WHERE id=?").run(now(),p.id);
    const version=prior.length+1;
    const qid=insertRecord(db,ctx,'catering_quotes','approved',{name:`Quote v${version} · ${event.data.name}`,eventId:event.id,version,amount:body.amount,currency:'AED',notes:body.notes,evidence:body.evidence,supersedes:prior[0]?.id||null});
    audit(db,ctx,'catering.quote_created',qid,{eventId:event.id,version,amount:body.amount});
    return parsed(quoteOf(db,ctx,qid));
  });
}
export function cateringQuotes(db,ctx,eventId){
  permit(ctx,'catering','read');
  const rows=db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='catering_quotes' ORDER BY created_at DESC").all(ctx.tenantId,ctx.outletId).map(parsed);
  return eventId?rows.filter(r=>r.data.eventId===eventId):rows;
}

export function returnCateringResource(db,ctx,eventId,input){
  permit(ctx,'catering');
  const body=z.object({resourceId:z.string().min(1).max(200),quantity:z.number().int().positive().max(1_000_000),condition:z.enum(['good','damaged','lost']),notes:text}).strict().parse(input);
  return transaction(db,()=>{
    const event=event_(db,ctx,eventId);
    const allocations=[...(event.data.resourceAllocations||[])];
    const idx=allocations.findIndex(a=>a.resourceId===body.resourceId);
    assert(idx>=0,'This resource is not allocated to the event.',404);
    const allocated=allocations[idx].quantity;assert(body.quantity<=allocated,'Return quantity exceeds the allocation.',409);
    if(body.quantity===allocated)allocations.splice(idx,1);else allocations[idx]={...allocations[idx],quantity:allocated-body.quantity};
    const returns=[...(event.data.resourceReturns||[]),{resourceId:body.resourceId,quantity:body.quantity,condition:body.condition,notes:body.notes,at:now()}];
    setEventData(db,ctx,event,{...event.data,resourceAllocations:allocations,resourceReturns:returns});
    audit(db,ctx,'catering.resource_returned',event.id,{resourceId:body.resourceId,quantity:body.quantity,condition:body.condition});
    return getRecord(db,ctx,event.id);
  });
}

export function recordCateringActual(db,ctx,eventId,input){
  permit(ctx,'catering');assert(['owner','manager','accountant'].includes(ctx.user.role),'An authorised reviewer must capture actual cost.',403);
  const body=z.object({actualCost:z.number().int().nonnegative().max(1_000_000_000),notes:text,evidence:text.min(1)}).strict().parse(input);
  return transaction(db,()=>{
    const event=event_(db,ctx,eventId);
    setEventData(db,ctx,event,{...event.data,actualCost:body.actualCost,actualNotes:body.notes,actualEvidence:body.evidence,actualCapturedAt:now()});
    audit(db,ctx,'catering.actual_cost',event.id,{actualCost:body.actualCost});
    return cateringProfitability(db,ctx,eventId);
  });
}
export function cateringProfitability(db,ctx,eventId){
  permit(ctx,'catering','read');
  const event=event_(db,ctx,eventId);
  const quote=parsed(quoteOf(db,ctx,(db.prepare("SELECT id FROM records WHERE tenant_id=? AND outlet_id=? AND module='catering_quotes' AND json_extract(data,'$.eventId')=? AND status='approved' ORDER BY created_at DESC LIMIT 1").get(ctx.tenantId,ctx.outletId,eventId)||{}).id));
  const amount=quote?quote.data.amount:event.data.quoteAmount;
  const actual=event.data.actualCost;
  return {eventId,event:event.data.name,guests:event.data.guests,quoteAmount:amount,deposit:event.data.deposit||0,actualCost:actual===undefined?null:actual,margin:actual===undefined?null:amount-actual,marginPercent:actual?Math.round((amount-actual)/amount*10000)/100:null,quoteVersion:quote?.data.version||null,status:event.status};
}

export function mountCateringExt(app,db){
  app.post('/api/catering/quotes',(req,res)=>res.status(201).json(createCateringQuote(db,req.ctx,req.body)));
  app.get('/api/catering/quotes',(req,res)=>res.json(cateringQuotes(db,req.ctx,req.query.eventId)));
  app.post('/api/catering/:id/resources/return',(req,res)=>res.json(returnCateringResource(db,req.ctx,req.params.id,req.body)));
  app.post('/api/catering/:id/actual-cost',(req,res)=>res.json(recordCateringActual(db,req.ctx,req.params.id,req.body)));
  app.get('/api/catering/:id/profitability',(req,res)=>res.json(cateringProfitability(db,req.ctx,req.params.id)));
}
