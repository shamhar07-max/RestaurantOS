import { z } from 'zod';
import { id,now,businessDate,transaction,audit } from './db.mjs';
import { assert,permit,getRecord,parseRecord,orderDetail,moveStock,stockPlacement } from './domain.mjs';

const recordsOf=(db,ctx,module)=>db.prepare('SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module=? ORDER BY created_at DESC').all(ctx.tenantId,ctx.outletId,module).map(parseRecord);
const subRecipesOf=(db,ctx)=>db.prepare('SELECT * FROM sub_recipes WHERE tenant_id=? AND outlet_id=?').all(ctx.tenantId,ctx.outletId);
const menuOf=(db,ctx)=>db.prepare('SELECT * FROM menu WHERE tenant_id=? AND outlet_id=?').all(ctx.tenantId,ctx.outletId);
const reasonText=z.string().trim().min(3).max(1000);

/* CORE-15 — explicit ingredient-substitution approval workflow. A substitution
   is drafted, then approved/rejected through the approval machinery; only an
   approved substitution is surfaced for operational use. */
export function approvedSubstitute(db,ctx,ingredientId){
  const approved=recordsOf(db,ctx,'substitutions').find(s=>s.status==='approved'&&s.data.ingredientId===ingredientId);
  return approved?{substitutionId:approved.id,ingredientId,substituteId:approved.data.substituteId,quantity:approved.data.quantity,reason:approved.data.reason}:null;
}

/* CORE-15 — supplier offer comparison. Rank active purchase packs for an
   ingredient by effective unit cost for the required quantity, then lead time. */
export function compareSupplierOffers(db,ctx,ingredientId,quantity){
  permit(ctx,'purchasing','read');
  assert(Number.isInteger(quantity)&&quantity>0,'Provide a positive required quantity.',400);
  const packs=recordsOf(db,ctx,'packs').filter(p=>p.status==='active'&&p.data.ingredientId===ingredientId);
  const suppliers=new Map(recordsOf(db,ctx,'suppliers').map(s=>[s.id,s.data]));
  const offers=packs.map(p=>{
    const packSize=p.data.packSize,packCost=p.data.packCost,unitCost=packCost/packSize,packsNeeded=Math.ceil(quantity/packSize),total=packsNeeded*packCost;
    const supplier=suppliers.get(p.data.supplierId)||{};
    return {packId:p.id,pack:p.data.name,supplierId:p.data.supplierId,supplier:supplier.name||p.data.supplierId,packSize,packCost,packsNeeded,total,unitCost:Math.round(unitCost*10000)/10000,effectiveUnitCost:Math.round(total/quantity*10000)/10000,leadDays:supplier.leadDays||null,terms:supplier.terms||''};
  }).sort((a,b)=>a.effectiveUnitCost-b.effectiveUnitCost||(a.leadDays??999)-(b.leadDays??999)||a.total-b.total);
  return {ingredientId,quantity,offers,recommended:offers[0]||null};
}

/* CORE-16 — component publication impact review. When a prepared component
   (sub-recipe) changes, identify the menu items and live orders that inherit it. */
function derivedIngredients(db,ctx,rootOutput){
  const recipes=subRecipesOf(db,ctx);
  const set=new Set([rootOutput]);
  let changed=true;
  while(changed){changed=false;for(const r of recipes){if(set.has(r.output_id))continue;const lines=JSON.parse(r.lines);if(lines.some(l=>l.ingredientId&&set.has(l.ingredientId))){set.add(r.output_id);changed=true;}}}
  return set;
}
export function recipeImpact(db,ctx,recipeId){
  permit(ctx,'production','read');
  const recipe=subRecipesOf(db,ctx).find(r=>r.id===recipeId);assert(recipe,'Prepared-component recipe not found in this outlet.',404);
  const ingredients=derivedIngredients(db,ctx,recipe.output_id);
  const items=menuOf(db,ctx).map(m=>({m,recipe:JSON.parse(m.recipe)})).filter(({recipe:r})=>r.some(l=>ingredients.has(l.ingredientId))).map(({m})=>({id:m.id,name:m.name,category:m.category,version:m.version}));
  const itemIds=new Set(items.map(i=>i.id));
  const orders=db.prepare("SELECT o.id,o.number,o.status FROM orders o WHERE o.tenant_id=? AND o.outlet_id=? AND o.status IN ('accepted','preparing','held','ready')").all(ctx.tenantId,ctx.outletId)
    .map(o=>({o,lines:db.prepare('SELECT DISTINCT item_id FROM order_lines WHERE order_id=?').all(o.id)}))
    .filter(({lines})=>lines.some(l=>itemIds.has(l.item_id))).map(({o})=>({orderId:o.id,number:o.number,status:o.status}));
  return {recipeId,component:recipe.name,outputId:recipe.output_id,version:recipe.version,derivedIngredients:[...ingredients],affectedItems:items,affectedOrders:orders};
}
export function reviewPublication(db,ctx,recipeId,input){
  permit(ctx,'production');
  const body=z.object({decision:z.enum(['approved','rejected']),evidence:reasonText,reviewer:z.string().trim().min(1).max(200).optional()}).strict().parse(input);
  return transaction(db,()=>{
    const impact=recipeImpact(db,ctx,recipeId);
    audit(db,ctx,'production.publication_reviewed',recipeId,{decision:body.decision,evidence:body.evidence,affectedItems:impact.affectedItems.map(i=>i.id),affectedOrders:impact.affectedOrders.map(o=>o.orderId)});
    return {...impact,decision:body.decision,evidence:body.evidence,reviewedAt:now(),reviewer:body.reviewer||ctx.user.name};
  });
}

/* CORE-17 — catering equipment/staff/venue capacity conflicts. Allocations are
   recorded against a resource register and checked for double-booking and
   over-capacity across events sharing a date. */
export function allocateCateringResources(db,ctx,eventId,input){
  permit(ctx,'catering');
  const body=z.object({allocations:z.array(z.object({resourceId:z.string().min(1).max(200),quantity:z.number().int().positive().max(1_000_000)})).min(1).max(50),reason:reasonText}).strict().parse(input);
  return transaction(db,()=>{
    const event=getRecord(db,ctx,eventId);assert(event.module==='catering','Catering event not found.',404);assert(!['served','closed'].includes(event.status),'Resources cannot change once service has finished.',409);
    const resourceOf=resourceId=>{const r=getRecord(db,ctx,resourceId);assert(r.module==='catering_resources','Select a catering resource.',404);assert(r.status==='active','This resource is retired.',409);return r;};
    const pool=recordsOf(db,ctx,'catering_resources');
    const others=recordsOf(db,ctx,'catering').filter(e=>e.id!==event.id&&e.data.date===event.data.date&&!['closed'].includes(e.status));
    const allocatedElsewhere=(resourceId)=>{let total=0;for(const e of others)for(const a of (e.data.resourceAllocations||[]))if(a.resourceId===resourceId)total+=a.quantity;return total;};
    const venue=db.prepare("SELECT value FROM settings WHERE tenant_id=? AND outlet_id=? AND key='venueCapacity'").get(ctx.tenantId,ctx.outletId);
    if(venue){const capacity=Number(JSON.parse(venue.value).guests)||0;assert(event.data.guests<=capacity,`This event exceeds the venue capacity of ${capacity} guests.`,409);}
    const allocations=[];
    for(const a of body.allocations){
      const resource=resourceOf(a.resourceId);
      const committed=allocatedElsewhere(a.resourceId);
      assert(committed+a.quantity<=resource.data.quantity,`${resource.data.name} is over-committed on ${event.data.date}: ${committed+a.quantity} of ${resource.data.quantity} required.`,409);
      if(resource.data.type==='staff')assert(!others.some(e=>(e.data.resourceAllocations||[]).some(x=>x.resourceId===a.resourceId)),`${resource.data.name} is already allocated to another event on ${event.data.date}.`,409);
      allocations.push({resourceId:a.resourceId,name:resource.data.name,type:resource.data.type,quantity:a.quantity});
    }
    const data={...event.data,resourceAllocations:[...(event.data.resourceAllocations||[]),...allocations]};
    db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(data),now(),event.id);
    audit(db,ctx,'catering.resources_allocated',event.id,{allocations,reason:body.reason});
    return {eventId:event.id,date:event.data.date,allocations:data.resourceAllocations};
  });
}
export function cateringResourceReport(db,ctx,date=businessDate()){
  permit(ctx,'catering','read');
  const resources=recordsOf(db,ctx,'catering_resources').filter(r=>r.status==='active');
  const events=recordsOf(db,ctx,'catering').filter(e=>e.data.date===date&&e.status!=='closed');
  const committed=new Map();
  for(const e of events)for(const a of (e.data.resourceAllocations||[]))committed.set(a.resourceId,(committed.get(a.resourceId)||0)+a.quantity);
  return {date,resources:resources.map(r=>({id:r.id,name:r.data.name,type:r.data.type,quantity:r.data.quantity,committed:committed.get(r.id)||0,available:r.data.quantity-(committed.get(r.id)||0)})),events:events.map(e=>({id:e.id,name:e.data.name,guests:e.data.guests,status:e.status,allocations:e.data.resourceAllocations||[]}))};
}

/* CORE-18 — ASP (Access Point) interface. A provider must be selected and
   validated before transmission; adapters are registered per provider so a
   certified integration can be dropped in without changing the workflow. */
export const aspProviders=()=>[{id:'peppol_access_point',name:'Peppol Access Point',requires:'Signed ASP agreement, participant identifier and certificate'},{id:'uae_fixed_network',name:'UAE eInvoicing accredited service provider',requires:'Accredited ASP onboarding and validation of invoice formats'}];
const aspAdapters=new Map();
export function registerAspAdapter(providerId,adapter){assert(aspProviders().some(p=>p.id===providerId),'Unknown ASP provider.',404);assert(adapter&&typeof adapter.transmit==='function','An ASP adapter must expose transmit().',400);aspAdapters.set(providerId,adapter);return {providerId};}
export function aspConfig(db,ctx){
  const setting=db.prepare("SELECT value FROM settings WHERE tenant_id=? AND outlet_id=? AND key='aspProvider'").get(ctx.tenantId,ctx.outletId);
  return setting?JSON.parse(setting.value):null;
}
export function selectAspProvider(db,ctx,input){
  permit(ctx,'settings');assert(ctx.user.role==='owner','Only an owner can select the ASP provider.',403);
  const body=z.object({providerId:z.enum(aspProviders().map(p=>p.id)),endpoint:z.string().url().max(300).optional(),evidence:reasonText}).strict().parse(input);
  return transaction(db,()=>{
    const config={providerId:body.providerId,endpoint:body.endpoint||null,evidence:body.evidence,selectedAt:now(),selectedBy:ctx.user.id,enabled:aspAdapters.has(body.providerId)};
    db.prepare("INSERT INTO settings(tenant_id,outlet_id,key,value) VALUES(?,?,?,?) ON CONFLICT(tenant_id,outlet_id,key) DO UPDATE SET value=excluded.value").run(ctx.tenantId,ctx.outletId,'aspProvider',JSON.stringify(config));
    audit(db,ctx,'asp.provider_selected',body.providerId,{endpoint:config.endpoint,enabled:config.enabled});
    return config;
  });
}
export function aspSubmit(db,ctx,input){
  permit(ctx,'finance');assert(['owner','accountant'].includes(ctx.user.role),'Only finance can transmit e-invoices.',403);
  const body=z.object({documentType:z.enum(['tax_invoice','credit_note']),reference:z.string().trim().min(1).max(200),amount:z.number().int().positive().max(1_000_000_000),tax:z.number().int().min(0).max(1_000_000_000),buyer:z.string().trim().min(1).max(300),idempotencyKey:z.string().trim().min(8).max(200)}).strict().parse(input);
  return transaction(db,()=>{
    const prior=db.prepare('SELECT * FROM asp_submissions WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);
    if(prior)return aspSubmission(db,prior.id);
    const config=aspConfig(db,ctx);assert(config&&config.enabled,'Select a validated ASP provider before transmitting.',409);
    const adapter=aspAdapters.get(config.providerId);
    const payload={documentType:body.documentType,reference:body.reference,amount:body.amount,tax:body.tax,currency:'AED',buyer:body.buyer,outletId:ctx.outletId,issuedAt:now()};
    const submissionId=id('asp');
    let status='awaiting_provider_validation',providerReference=null,lastError=null;
    if(adapter){try{const result=adapter.transmit(payload)||{};status=result.status||'submitted';providerReference=result.reference||null;}catch(e){status='failed';lastError=e.message;}}
    db.prepare('INSERT INTO asp_submissions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(submissionId,ctx.tenantId,ctx.outletId,config.providerId,body.documentType,status,providerReference,JSON.stringify(payload),lastError,body.idempotencyKey,now());
    audit(db,ctx,'asp.submitted',submissionId,{providerId:config.providerId,status,reference:body.reference});
    return aspSubmission(db,submissionId);
  });
}
export function aspAcknowledge(db,ctx,submissionId,input){
  permit(ctx,'finance');assert(['owner','accountant'].includes(ctx.user.role),'Only finance can record an ASP acknowledgement.',403);
  const body=z.object({status:z.enum(['accepted','rejected']),reference:z.string().trim().min(1).max(200).optional(),evidence:reasonText}).strict().parse(input);
  return transaction(db,()=>{
    const row=db.prepare('SELECT * FROM asp_submissions WHERE id=? AND tenant_id=? AND outlet_id=?').get(submissionId,ctx.tenantId,ctx.outletId);assert(row,'ASP submission not found.',404);assert(!['accepted','rejected'].includes(row.status),'This submission is already acknowledged.',409);
    db.prepare('UPDATE asp_submissions SET status=?,provider_reference=COALESCE(?,provider_reference),updated_at=? WHERE id=?').run(body.status,body.reference||null,now(),row.id);
    audit(db,ctx,'asp.acknowledged',row.id,{status:body.status,evidence:body.evidence});
    return aspSubmission(db,row.id);
  });
}
function aspSubmission(db,submissionId){const r=db.prepare('SELECT * FROM asp_submissions WHERE id=?').get(submissionId);return {...r,payload:JSON.parse(r.payload)};}
export function aspSubmissions(db,ctx){
  permit(ctx,'finance','read');
  return db.prepare('SELECT * FROM asp_submissions WHERE tenant_id=? AND outlet_id=? ORDER BY updated_at DESC').all(ctx.tenantId,ctx.outletId).map(r=>({...r,payload:JSON.parse(r.payload)}));
}

export function mountOperationsExt(app,db){
  db.exec(`CREATE TABLE IF NOT EXISTS asp_submissions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,provider_id TEXT NOT NULL,document_type TEXT NOT NULL,status TEXT NOT NULL,provider_reference TEXT,payload TEXT NOT NULL,last_error TEXT,idempotency_key TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(tenant_id,outlet_id,idempotency_key));`);
  // CORE-01 — physical stock placement/moves.
  app.post('/api/inventory/lots/:id/move',(req,res)=>res.json(moveStock(db,req.ctx,req.params.id,req.body)));
  app.get('/api/inventory/placement',(req,res)=>res.json(stockPlacement(db,req.ctx)));
  // CORE-15 — substitutions and supplier offers.
  app.get('/api/purchasing/substitution',(req,res)=>{permit(req.ctx,'purchasing','read');res.json({position:approvedSubstitute(db,req.ctx,req.query.ingredientId)});});
  app.get('/api/purchasing/offers',(req,res)=>res.json(compareSupplierOffers(db,req.ctx,req.query.ingredientId,Number(req.query.quantity))));
  // CORE-16 — component publication impact review.
  app.get('/api/recipes/:id/impact',(req,res)=>res.json(recipeImpact(db,req.ctx,req.params.id)));
  app.post('/api/recipes/:id/impact/review',(req,res)=>res.json(reviewPublication(db,req.ctx,req.params.id,req.body)));
  // CORE-17 — catering resource conflicts.
  app.get('/api/catering/resources',(req,res)=>res.json(cateringResourceReport(db,req.ctx,req.query.date||businessDate())));
  app.post('/api/catering/:id/resources',(req,res)=>res.json(allocateCateringResources(db,req.ctx,req.params.id,req.body)));
  // CORE-18 — ASP interface.
  app.get('/api/finance/asp',(req,res)=>{permit(req.ctx,'finance','read');res.json({providers:aspProviders(),config:aspConfig(db,req.ctx),submissions:aspSubmissions(db,req.ctx)});});
  app.post('/api/finance/asp/provider',(req,res)=>res.json(selectAspProvider(db,req.ctx,req.body)));
  app.post('/api/finance/asp/submissions',(req,res)=>res.status(201).json(aspSubmit(db,req.ctx,req.body)));
  app.post('/api/finance/asp/submissions/:id/acknowledge',(req,res)=>res.json(aspAcknowledge(db,req.ctx,req.params.id,req.body)));
}
