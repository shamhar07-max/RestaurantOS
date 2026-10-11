import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { id,now,businessDate,transaction,audit,journal } from './db.mjs';
import { assert,permit,getRecord,createRecord,recordAction,parseRecord,contractRateAt } from './domain.mjs';
import { planProduction } from './recipes.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const scoped=(db,table,ctx,recordId)=>db.prepare(`SELECT * FROM ${table} WHERE id=? AND tenant_id=? AND outlet_id=?`).get(recordId,ctx.tenantId,ctx.outletId);
const reason=z.string().trim().min(3).max(1000);
function contractRef(db,ctx,contractId){const c=getRecord(db,ctx,contractId);assert(c.module==='contracts','This action requires a meal contract.',404);return c;}
function recordsOf(db,ctx,module){return db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module=? ORDER BY created_at DESC").all(ctx.tenantId,ctx.outletId,module).map(parseRecord);}

/* MES-01 — effective-dated contract rate versions. A future change is recorded
   without rewriting a closed period: the invoice snapshot keeps its rate. */
export function addContractRate(db,ctx,contractId,input){
  permit(ctx,'catering');
  const b=z.object({rate:z.number().int().positive().max(100_000_000),billingBasis:z.enum(['accepted_meal','fixed_person','guaranteed_minimum','fixed_site']),minimum:z.number().int().nonnegative().default(0),effectiveFrom:z.iso.date(),reason}).parse(input);
  return transaction(db,()=>{
    const c=contractRef(db,ctx,contractId);
    assert(c.status!=='period_closed','A closed contract period is immutable. Create a renewal or a new contract version.',409);
    assert(b.effectiveFrom>=c.data.startDate&&b.effectiveFrom<=c.data.endDate,'The effective date must fall within the contract term.');
    const history=[...(c.data.rateHistory||[])];
    assert(!history.some(h=>h.effectiveFrom===b.effectiveFrom),'A rate already takes effect on that date.',409);
    const version=(history.length?Math.max(...history.map(h=>h.version)):1)+1;
    history.push({id:id('rate'),version,rate:b.rate,billingBasis:b.billingBasis,minimum:b.minimum,effectiveFrom:b.effectiveFrom,reason:b.reason,createdBy:ctx.user.name,createdAt:now()});
    history.sort((x,y)=>x.effectiveFrom.localeCompare(y.effectiveFrom));
    const data={...c.data,rateHistory:history};
    const current=[...history].filter(h=>h.effectiveFrom<=businessDate()).pop();
    if(current){data.rate=current.rate;data.billingBasis=current.billingBasis;data.minimum=current.minimum;data.rateVersion=current.version;}
    db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(data),now(),c.id);
    audit(db,ctx,'contract.rate_version',c.id,{version,effectiveFrom:b.effectiveFrom,rate:b.rate});
    return getRecord(db,ctx,c.id);
  });
}
export function contractRateSchedule(db,ctx,contractId){permit(ctx,'catering','read');const c=contractRef(db,ctx,contractId);return {contractId,term:{start:c.data.startDate,end:c.data.endDate},versions:[{version:1,rate:c.data.rate,billingBasis:c.data.billingBasis,minimum:c.data.minimum||0,effectiveFrom:c.data.startDate,initial:true},...(c.data.rateHistory||[])],effectiveAt:(date)=>contractRateAt(c,date)};}

/* MES-03 — separate eater and payer: individual eaters/entitlements against a payer contract. */
export function eaterRoster(db,ctx,contractId){permit(ctx,'catering','read');const c=contractRef(db,ctx,contractId);const rows=recordsOf(db,ctx,'eaters').filter(e=>e.data.contractId===contractId);return {contractId,payer:c.data.payer,site:c.data.site,eaters:rows.map(e=>({id:e.id,name:e.data.name,externalRef:e.data.externalRef||'',site:e.data.site,entitlement:e.data.entitlement,status:e.status})),eligible:rows.filter(e=>e.status==='active').reduce((s,e)=>s+e.data.entitlement,0),people:rows.filter(e=>e.status==='active').length};}

/* MES-04 — effective roster changes. join/leave/transfer apply on their effective date. */
export function effectiveRoster(db,ctx,contractId,date=businessDate()){
  permit(ctx,'catering','read');const c=contractRef(db,ctx,contractId);
  const events=db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='roster_events' AND status='applied'").all(ctx.tenantId,ctx.outletId).map(parseRecord).filter(e=>e.data.contractId===contractId&&e.data.effectiveFrom<=date).sort((a,b)=>a.data.effectiveFrom.localeCompare(b.data.effectiveFrom));
  let headcount=c.data.eligible;const sites=new Map();sites.set(c.data.site,c.data.eligible);
  for(const e of events){
    if(e.data.action==='join'){headcount+=e.data.quantity;sites.set(e.data.toSite||c.data.site,(sites.get(e.data.toSite||c.data.site)||0)+e.data.quantity);}
    else if(e.data.action==='leave'){headcount-=e.data.quantity;sites.set(e.data.fromSite||c.data.site,Math.max(0,(sites.get(e.data.fromSite||c.data.site)||0)-e.data.quantity));}
    else if(e.data.action==='transfer'){sites.set(e.data.fromSite||c.data.site,Math.max(0,(sites.get(e.data.fromSite||c.data.site)||0)-e.data.quantity));sites.set(e.data.toSite||c.data.site,(sites.get(e.data.toSite||c.data.site)||0)+e.data.quantity);}
  }
  assert(headcount>=0,'Roster changes would take the headcount below zero.',409);
  return {contractId,date,baseline:c.data.eligible,headcount,sites:Object.fromEntries(sites),appliedEvents:events.map(e=>({id:e.id,action:e.data.action,quantity:e.data.quantity,effectiveFrom:e.data.effectiveFrom}))};
}

/* MES-05 — cutoff and demand snapshot. A change after the cutoff does not rewrite
   the locked snapshot; it creates an exception that an approver must decide. */
export function lockDemand(db,ctx,demandId,input){permit(ctx,'catering');const b=z.object({version:z.number().int().positive(),reason}).parse(input);return recordAction(db,ctx,demandId,{action:'locked',version:b.version,reason:b.reason});}
export function reviseDemand(db,ctx,demandId,input){
  permit(ctx,'catering');
  const b=z.object({quantity:z.number().int().nonnegative().max(100_000_000),version:z.number().int().positive(),reason}).parse(input);
  return transaction(db,()=>{
    const d=getRecord(db,ctx,demandId);assert(d.module==='demand_snapshots','Demand snapshot not found.',404);assert(d.version===b.version,'The snapshot changed. Refresh before revising.',409);
    const cutoff=new Date(d.data.cutoffAt).getTime(),late=d.status==='locked'||Date.now()>cutoff;
    if(late){
      const exception=createRecord(db,ctx,'demand_exceptions',{name:`Late change · ${d.data.name}`,contractId:d.data.contractId,demandId:d.id,change:b.quantity,reason:b.reason});
      audit(db,ctx,'catering.demand_change_exception',d.id,{exceptionId:exception.id,requested:b.quantity,original:d.data.quantity});
      return {late:true,demand:d,exception};
    }
    const revisions=[...(d.data.revisions||[]),{at:now(),from:d.data.quantity,to:b.quantity,reason:b.reason,by:ctx.user.name}];
    db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify({...d.data,quantity:b.quantity,revisions}),now(),d.id);
    audit(db,ctx,'catering.demand_revised',d.id,{from:d.data.quantity,to:b.quantity,reason:b.reason});
    return {late:false,demand:getRecord(db,ctx,d.id)};
  });
}
export function decideDemandException(db,ctx,exceptionId,input){
  permit(ctx,'catering');
  const b=z.object({decision:z.enum(['approved','rejected']),version:z.number().int().positive(),reason}).parse(input);
  return recordAction(db,ctx,exceptionId,{action:b.decision,version:b.version,reason:b.reason});
}

/* MES-07 — production linkage: a demand snapshot creates a traceable planned batch. */
export function produceDemand(db,ctx,demandId,input){
  permit(ctx,'production');
  const b=z.object({recipeId:z.string().min(1).optional(),name:z.string().trim().min(1).max(200).optional(),expiry:z.iso.date(),notes:z.string().max(2000).default(''),deep:z.boolean().default(true)}).parse(input);
  return transaction(db,()=>{
    const d=getRecord(db,ctx,demandId);assert(d.module==='demand_snapshots','Demand snapshot not found.',404);
    const contract=getRecord(db,ctx,d.data.contractId);
    const recipeId=b.recipeId||contract.data.recipeId;assert(recipeId,'Link a production recipe to the contract or pass one for this run.');
    const planned=planProduction(db,ctx,recipeId,{name:b.name||`Demand ${d.data.date} ${d.data.mealType}`,quantity:d.data.quantity,expiry:b.expiry,notes:b.notes,deep:b.deep});
    const runs=[...(d.data.production||[]),{at:now(),batchId:planned.batchId,recipeId,recipeVersion:planned.recipeVersion,quantity:d.data.quantity,deep:b.deep}];
    db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify({...d.data,production:runs}),now(),d.id);
    audit(db,ctx,'catering.demand_produced',d.id,{batchId:planned.batchId,recipeId,quantity:d.data.quantity});
    return {demand:getRecord(db,ctx,d.id),batch:planned.batch,batchId:planned.batchId,inputs:planned.inputs};
  });
}

/* MES-06 — meal-type calendar and service schedule. Each contract may hold
   breakfast/lunch/dinner calendars with service days, shift windows and an
   optional rate code; the calendar resolves which meals are served on a date. */
const WEEKDAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function weekdayOf(date){return new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Dubai',weekday:'short'}).format(new Date(`${date}T12:00:00Z`));}
export function dayMatches(days,weekday){
  if(!days||!days.trim())return true;
  const wi=WEEKDAYS.indexOf(weekday.slice(0,3));
  for(const token of days.split(',').map(s=>s.trim()).filter(Boolean)){
    const range=token.split(/[-–]/).map(s=>s.trim());
    if(range.length===2){
      const a=WEEKDAYS.indexOf(range[0].slice(0,3)),b=WEEKDAYS.indexOf(range[1].slice(0,3));
      if(a<0||b<0)continue;
      if(a<=b?(wi>=a&&wi<=b):(wi>=a||wi<=b))return true;
      continue;
    }
    if(token.slice(0,3).toLowerCase()===weekday.toLowerCase())return true;
  }
  return false;
}
export function mealCalendar(db,ctx,contractId,date=businessDate()){
  permit(ctx,'catering','read');const c=contractRef(db,ctx,contractId);
  const weekday=weekdayOf(date);
  let calendars=recordsOf(db,ctx,'meal_calendars').filter(m=>m.data.contractId===contractId);
  if(!calendars.length)calendars=[{id:null,status:'derived',data:{mealType:c.data.mealType,days:'',serviceStart:'',serviceEnd:'',rateCode:''}}];
  const roster=effectiveRoster(db,ctx,contractId,date);
  const meals=calendars.map(m=>({id:m.id,status:m.status,mealType:m.data.mealType,days:m.data.days,serviceStart:m.data.serviceStart,serviceEnd:m.data.serviceEnd,rateCode:m.data.rateCode||null,serves:m.status!=='retired'&&dayMatches(m.data.days,weekday)}));
  const expected={};for(const m of meals)if(m.serves)expected[m.mealType]=roster.headcount;
  return {contractId,date,weekday,headcount:roster.headcount,meals,served:meals.filter(m=>m.serves).map(m=>m.mealType),expected};
}
export function serviceSchedule(db,ctx,contractId,from,to){
  permit(ctx,'catering','read');contractRef(db,ctx,contractId);
  assert(from<=to,'The schedule end must not precede its start.',400);
  const days=[];for(let d=new Date(`${from}T00:00:00Z`);d.toISOString().slice(0,10)<=to;d.setUTCDate(d.getUTCDate()+1)){const date=d.toISOString().slice(0,10);const cal=mealCalendar(db,ctx,contractId,date);days.push({date,weekday:cal.weekday,served:cal.served,headcount:cal.headcount});}
  return {contractId,from,to,days};
}

/* CORE-05 — demand/capacity linkage. Aggregate a day's accepted demand across
   contracts and compare it to the configured daily production capacity. */
export function productionPlan(db,ctx,date=businessDate()){
  permit(ctx,'production','read');
  const setting=db.prepare("SELECT value FROM settings WHERE tenant_id=? AND outlet_id=? AND key='productionCapacity'").get(ctx.tenantId,ctx.outletId);
  const capacity=setting?Number(JSON.parse(setting.value).units)||0:0;
  const demand=recordsOf(db,ctx,'demand_snapshots').filter(d=>d.data.date===date);
  const contracts=demand.map(d=>{const c=getRecord(db,ctx,d.data.contractId);return {contractId:d.data.contractId,contract:c.data.name,mealType:d.data.mealType,quantity:d.data.quantity,produced:(d.data.production||[]).reduce((s,p)=>s+p.quantity,0),status:d.status};});
  const required=contracts.reduce((s,c)=>s+c.quantity,0);
  const produced=contracts.reduce((s,c)=>s+c.produced,0);
  return {date,capacity,required,produced,unplanned:Math.max(0,required-produced),shortfall:capacity?Math.max(0,required-capacity):0,within:capacity?required<=capacity:null,contracts};
}

/* MES-10 — offline serving. Queued scans are deduplicated by external scan id;
   a scan that would exceed the accepted balance is flagged, not silently consumed. */
export function syncOfflineServings(db,ctx,input){
  permit(ctx,'catering');
  const b=z.object({scans:z.array(z.object({scanId:z.string().trim().min(1).max(160),contractId:z.string(),date:z.iso.date(),mealType:z.enum(['breakfast','lunch','dinner']),method:z.enum(['individual_scan','group_count']),quantity:z.number().int().positive().max(100_000),site:z.string().max(200).default(''),evidence:z.string().max(500).default('')})).min(1).max(500)}).parse(input);
  return transaction(db,()=>{
    const results=b.scans.map(s=>{
      const prior=db.prepare('SELECT * FROM serving_scans WHERE tenant_id=? AND outlet_id=? AND scan_id=?').get(ctx.tenantId,ctx.outletId,s.scanId);
      if(prior)return {scanId:s.scanId,status:prior.status,servingId:prior.serving_id,duplicate:true,conflict:prior.status==='conflict'};
      const contract=contractRef(db,ctx,s.contractId);
      const accepted=contract.data.accepted,served=contract.data.served||0;
      const pending=db.prepare("SELECT COALESCE(SUM(CAST(json_extract(data,'$.quantity') AS INTEGER)),0) n FROM records WHERE tenant_id=? AND outlet_id=? AND module='servings' AND json_extract(data,'$.contractId')=? AND status='recorded'").get(ctx.tenantId,ctx.outletId,s.contractId).n;
      const conflict=served+pending+s.quantity>accepted;
      let status='accepted',servingId=null;
      if(!conflict){const rec=createRecord(db,ctx,'servings',{name:`Offline scan ${s.scanId}`,contractId:s.contractId,date:s.date,mealType:s.mealType,method:s.method,quantity:s.quantity,site:s.site||contract.data.site,evidence:s.evidence||'Offline scan queued and replayed'});servingId=rec.id;}
      else status='conflict';
      db.prepare('INSERT INTO serving_scans VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id('scan'),ctx.tenantId,ctx.outletId,s.scanId,s.contractId,s.date,s.mealType,s.quantity,'offline',now(),status,servingId);
      return {scanId:s.scanId,status,servingId,duplicate:false,conflict};
    });
    const conflicts=results.filter(r=>r.conflict).length;
    audit(db,ctx,'catering.offline_servings_synced',ctx.outletId,{count:results.length,conflicts});
    return {results,accepted:results.filter(r=>r.status==='accepted').length,duplicates:results.filter(r=>r.duplicate).length,conflicts};
  });
}

/* MES-13 — produced / dispatched / served / remaining / waste reconciliation. */
export function cateringReconciliation(db,ctx,contractId,date){
  permit(ctx,'catering','read');const c=contractRef(db,ctx,contractId);
  const onDate=d=>!date||d.data.date===date;
  const demand=recordsOf(db,ctx,'demand_snapshots').filter(d=>d.data.contractId===contractId&&onDate(d));
  const dispatches=recordsOf(db,ctx,'dispatches').filter(d=>d.data.contractId===contractId&&onDate(d));
  const servings=recordsOf(db,ctx,'servings').filter(s=>s.data.contractId===contractId&&(!date||s.data.date===date));
  const planned=demand.reduce((s,d)=>s+d.data.quantity,0);
  const produced=demand.reduce((s,d)=>s+(d.data.production||[]).reduce((a,p)=>a+p.quantity,0),0);
  const dispatched=dispatches.filter(d=>['dispatched','accepted'].includes(d.status)).reduce((s,d)=>s+d.data.dispatched,0);
  const accepted=dispatches.filter(d=>d.status==='accepted').reduce((s,d)=>s+(d.data.accepted??d.data.dispatched),0);
  const rejected=dispatches.reduce((s,d)=>s+(d.data.rejected||0),0);
  const served=servings.filter(s=>s.status==='verified').reduce((s,r)=>s+r.data.quantity,0);
  const recorded=servings.filter(s=>s.status==='recorded').reduce((s,r)=>s+r.data.quantity,0);
  return {contract:{id:c.id,name:c.data.name,payer:c.data.payer,site:c.data.site,mealType:c.data.mealType},date:date||null,planned,produced,dispatched,accepted,rejected,served,unverified:recorded,remainingAccepted:Math.max(0,accepted-served),leftover:Math.max(0,produced-dispatched),unaccounted:Math.max(0,dispatched-accepted-served),reconciled:accepted-served===0&&rejected===0&&produced===dispatched,demand:demand.length,dispatches:dispatches.length,servings:servings.length};
}

/* MES-14 — client approval portal. A scoped, revocable token shows a payer only their
   own contracts/sites and lets them approve an issued invoice. */
export function issueClientToken(db,ctx,input){
  permit(ctx,'catering');assert(['owner','manager'].includes(ctx.user.role),'Manager approval is required to invite a client.',403);
  const b=z.object({payer:z.string().trim().min(1).max(200),reason}).parse(input);
  return transaction(db,()=>{const token=randomBytes(24).toString('hex');const idv=id('client');db.prepare('INSERT INTO client_tokens VALUES(?,?,?,?,?,?,NULL)').run(idv,sha(token),ctx.tenantId,ctx.outletId,b.payer,now());audit(db,ctx,'catering.client_token_issued',idv,{payer:b.payer,reason:b.reason});return {token,payer:b.payer,id:idv};});
}
function clientToken(db,token){const t=db.prepare('SELECT * FROM client_tokens WHERE token_hash=? AND revoked_at IS NULL').get(sha(token));assert(t,'Client portal link is not valid.',404);return t;}
export function clientPortal(db,token){const t=clientToken(db,token);const contracts=db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='contracts'").all(t.tenant_id,t.outlet_id).map(parseRecord).filter(c=>c.data.payer===t.payer);return {payer:t.payer,contracts:contracts.map(c=>({id:c.id,name:c.data.name,site:c.data.site,mealType:c.data.mealType,billingBasis:c.data.billingBasis,accepted:c.data.accepted,served:c.data.served||0,invoice:c.data.invoice||null,clientApproval:c.data.clientApproval||null,status:c.status}))};}
export function clientPortalApprove(db,token,input){const t=clientToken(db,token);const b=z.object({contractId:z.string(),evidence:z.string().trim().min(3).max(1000)}).parse(input);const c=parseRecord(db.prepare("SELECT * FROM records WHERE id=? AND tenant_id=? AND outlet_id=? AND module='contracts'").get(b.contractId,t.tenant_id,t.outlet_id));assert(c&&c.data.payer===t.payer,'This contract does not belong to your organisation.',404);assert(c.data.invoice,'There is no issued invoice to approve yet.',409);const data={...c.data,clientApproval:{at:now(),evidence:b.evidence,by:t.payer}};db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(data),now(),c.id);audit(db,{tenantId:t.tenant_id,outletId:t.outlet_id,entityId:'',user:{id:'client_portal'}},'catering.client_approval',c.id,{payer:t.payer});return {ok:true,contractId:c.id,approvedAt:data.clientApproval.at};}

/* MES-16 — subscription cutoff and credit consequences. */
export function subscriptionCredit(db,ctx,subscriptionId,input){
  permit(ctx,'catering');assert(['owner','manager','accountant'].includes(ctx.user.role),'Finance approval is required to credit a subscription.',403);
  const b=z.object({reason,refund:z.boolean().default(false)}).parse(input);
  return transaction(db,()=>{
    const s=getRecord(db,ctx,subscriptionId);assert(s.module==='subscriptions','Subscription not found.',404);assert(s.status!=='cancelled','A cancelled subscription cannot be credited.',409);
    const remaining=Math.max(0,s.data.entitlements-(s.data.used||0));assert(remaining>0,'No funded entitlement remains to credit.');
    const amount=remaining*(s.data.mealPrice||0),cid=id('subcredit');
    if(b.refund&&amount)journal(db,ctx,cid,'subscription_refund',[{account:'Customer advances',debit:amount},{account:'Refund payable',credit:amount}]);
    const credits=[...(s.data.credits||[]),{id:cid,at:now(),meals:remaining,amount,refund:b.refund,reason:b.reason,by:ctx.user.name}];
    db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify({...s.data,credits}),now(),s.id);
    audit(db,ctx,'subscription.credited',s.id,{meals:remaining,amount,refund:b.refund});
    return {credit:credits[credits.length-1],subscription:getRecord(db,ctx,s.id)};
  });
}
/* MES-17 — effective-dated delivery calendar/address changes. */
export function subscriptionDelivery(db,ctx,subscriptionId,date=businessDate()){
  permit(ctx,'catering','read');const s=getRecord(db,ctx,subscriptionId);assert(s.module==='subscriptions','Subscription not found.',404);
  const changes=recordsOf(db,ctx,'subscription_changes').filter(c=>c.data.subscriptionId===subscriptionId&&c.data.effectiveFrom<=date&&['scheduled','applied'].includes(c.status)).sort((a,b)=>a.data.effectiveFrom.localeCompare(b.data.effectiveFrom));
  const current=changes[changes.length-1];
  return {subscriptionId,date,address:current?.data.address||s.data.address,days:current?.data.days||s.data.days,effectiveChange:current?{id:current.id,effectiveFrom:current.data.effectiveFrom}:null,futureChanges:recordsOf(db,ctx,'subscription_changes').filter(c=>c.data.subscriptionId===subscriptionId&&c.data.effectiveFrom>date).map(c=>c.data.effectiveFrom)};
}
/* MES-18 — renewal and prepaid balance / liability recognition. */
export function renewSubscription(db,ctx,subscriptionId,input){
  permit(ctx,'catering');assert(['owner','manager','accountant'].includes(ctx.user.role),'Finance approval is required to renew a subscription.',403);
  const b=z.object({entitlements:z.number().int().positive().max(10_000_000),paymentReference:z.string().trim().min(3).max(300)}).parse(input);
  return transaction(db,()=>{
    const s=getRecord(db,ctx,subscriptionId);assert(s.module==='subscriptions','Subscription not found.',404);assert(s.status!=='cancelled','A cancelled subscription cannot be renewed.',409);
    const added=b.entitlements,amount=added*(s.data.mealPrice||0);
    if(amount)journal(db,ctx,id('renewal'),'subscription_renewal',[{account:'Cash',debit:amount},{account:'Deferred meal revenue',credit:amount}]);
    const renewals=[...(s.data.renewals||[]),{at:now(),entitlements:added,amount,paymentReference:b.paymentReference,by:ctx.user.name}];
    db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify({...s.data,entitlements:s.data.entitlements+added,renewals,status:'active'}),now(),s.id);
    audit(db,ctx,'subscription.renewed',s.id,{entitlements:added,amount});
    return subscriptionBalance(db,ctx,s.id);
  });
}
export function subscriptionBalance(db,ctx,subscriptionId){
  permit(ctx,'catering','read');const s=getRecord(db,ctx,subscriptionId);assert(s.module==='subscriptions','Subscription not found.',404);
  const funded=s.data.entitlements,delivered=s.data.used||0,remaining=Math.max(0,funded-delivered),mealPrice=s.data.mealPrice||0;
  return {subscriptionId,funded,delivered,remaining,mealPrice,prepaidValue:remaining*mealPrice,deliveredValue:delivered*mealPrice,status:s.status,renewals:s.data.renewals||[],credits:s.data.credits||[]};
}

export function mountMes(app,db){
  app.get('/api/contracts/:id/rates',(req,res)=>res.json(contractRateSchedule(db,req.ctx,req.params.id)));
  app.post('/api/contracts/:id/rates',(req,res)=>res.json(addContractRate(db,req.ctx,req.params.id,req.body)));
  app.get('/api/contracts/:id/eaters',(req,res)=>res.json(eaterRoster(db,req.ctx,req.params.id)));
  app.get('/api/contracts/:id/roster',(req,res)=>res.json(effectiveRoster(db,req.ctx,req.params.id,req.query.date||businessDate())));
  app.post('/api/catering/demand/:id/lock',(req,res)=>res.json(lockDemand(db,req.ctx,req.params.id,req.body)));
  app.post('/api/catering/demand/:id/revise',(req,res)=>res.json(reviseDemand(db,req.ctx,req.params.id,req.body)));
  app.post('/api/catering/demand-exceptions/:id/decide',(req,res)=>res.json(decideDemandException(db,req.ctx,req.params.id,req.body)));
  app.post('/api/catering/demand/:id/produce',(req,res)=>res.status(201).json(produceDemand(db,req.ctx,req.params.id,req.body)));
  app.post('/api/catering/servings/offline',(req,res)=>res.json(syncOfflineServings(db,req.ctx,req.body)));
  app.get('/api/catering/reconciliation',(req,res)=>{const contractId=z.string().min(1).parse(req.query.contractId);res.json(cateringReconciliation(db,req.ctx,contractId,req.query.date));});
  app.post('/api/catering/client-tokens',(req,res)=>res.status(201).json(issueClientToken(db,req.ctx,req.body)));
  app.post('/api/subscriptions/:id/credit',(req,res)=>res.json(subscriptionCredit(db,req.ctx,req.params.id,req.body)));
  app.post('/api/subscriptions/:id/renew',(req,res)=>res.json(renewSubscription(db,req.ctx,req.params.id,req.body)));
  app.get('/api/subscriptions/:id/balance',(req,res)=>res.json(subscriptionBalance(db,req.ctx,req.params.id)));
  app.get('/api/subscriptions/:id/delivery',(req,res)=>res.json(subscriptionDelivery(db,req.ctx,req.params.id,req.query.date||businessDate())));
  app.get('/api/contracts/:id/calendar',(req,res)=>res.json(mealCalendar(db,req.ctx,req.params.id,req.query.date||businessDate())));
  app.get('/api/contracts/:id/schedule',(req,res)=>{const from=z.iso.date().parse(req.query.from),to=z.iso.date().parse(req.query.to);res.json(serviceSchedule(db,req.ctx,req.params.id,from,to));});
  app.get('/api/catering/production-plan',(req,res)=>res.json(productionPlan(db,req.ctx,req.query.date||businessDate())));
}
