import { z } from 'zod';
import { id,now,transaction,audit } from './db.mjs';
import { assert,permit,orderDetail } from './domain.mjs';

// ORD-11 — printer interruption handling. A kitchen/floor ticket is queued, then
// explicitly acknowledged; a failed or interrupted print keeps its attempt count
// and stays available for a controlled reprint rather than silently disappearing.
const key=z.string().trim().min(8).max(200);
export function queuePrint(db,ctx,orderId,input){
  permit(ctx,'orders');
  const body=z.object({station:z.string().trim().min(1).max(40),printer:z.string().trim().max(120).default(''),idempotencyKey:key}).strict().parse(input);
  return transaction(db,()=>{
    const prior=db.prepare('SELECT * FROM print_jobs WHERE tenant_id=? AND outlet_id=? AND idempotency_key=?').get(ctx.tenantId,ctx.outletId,body.idempotencyKey);
    assert(!prior||prior.order_id===orderId,'This print key belongs to another order.',409);
    if(prior)return printJob(db,prior.id);
    const order=orderDetail(db,ctx,orderId);
    const wantAll=body.station==='receipt'||body.station==='pass';
    const lines=order.lines.filter(l=>wantAll||l.station===body.station).map(l=>({name:l.name,quantity:l.quantity,modifiers:l.modifiers.map(m=>m.name),notes:l.notes}));
    assert(lines.length,'No lines for this station are on the order.',409);
    const ticket={orderNumber:order.number,service:order.service,channel:order.channel,customer:order.customer,station:body.station,lines,queuedAt:now()};
    const jobId=id('print');
    db.prepare('INSERT INTO print_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(jobId,ctx.tenantId,ctx.outletId,orderId,body.station,body.printer||null,'queued',0,null,ctx.user.id,body.idempotencyKey,now(),now(),JSON.stringify(ticket));
    audit(db,ctx,'print.queued',jobId,{orderId,station:body.station,printer:body.printer});
    return printJob(db,jobId);
  });
}
export function acknowledgePrint(db,ctx,jobId,input){
  permit(ctx,'orders');
  const body=z.object({ok:z.boolean(),error:z.string().trim().max(500).optional(),evidence:z.string().trim().max(500).optional()}).strict().parse(input);
  return transaction(db,()=>{
    const job=db.prepare('SELECT * FROM print_jobs WHERE id=? AND tenant_id=? AND outlet_id=?').get(jobId,ctx.tenantId,ctx.outletId);assert(job,'Print job not found.',404);assert(['queued','failed'].includes(job.status),'This print job is already resolved.',409);
    if(body.ok)db.prepare("UPDATE print_jobs SET status='printed',attempts=attempts+1,last_error=NULL,updated_at=? WHERE id=?").run(now(),jobId);
    else db.prepare("UPDATE print_jobs SET status='failed',attempts=attempts+1,last_error=?,updated_at=? WHERE id=?").run(body.error||'Printing was interrupted.',now(),jobId);
    audit(db,ctx,body.ok?'print.confirmed':'print.failed',jobId,{orderId:job.order_id,station:job.station,error:body.error||null,evidence:body.evidence||null});
    return printJob(db,jobId);
  });
}
export function retryPrint(db,ctx,jobId,input){
  permit(ctx,'orders');
  const body=z.object({reason:z.string().trim().min(3).max(500)}).strict().parse(input);
  return transaction(db,()=>{
    const job=db.prepare('SELECT * FROM print_jobs WHERE id=? AND tenant_id=? AND outlet_id=?').get(jobId,ctx.tenantId,ctx.outletId);assert(job,'Print job not found.',404);assert(job.status==='failed','Only an interrupted ticket can be reprinted.',409);
    db.prepare("UPDATE print_jobs SET status='queued',updated_at=? WHERE id=?").run(now(),jobId);
    audit(db,ctx,'print.retried',jobId,{orderId:job.order_id,reason:body.reason,attempts:job.attempts});
    return printJob(db,jobId);
  });
}
export function printJobs(db,ctx,query={}){
  permit(ctx,'orders','read');
  const where=["tenant_id=? AND outlet_id=?"],args=[ctx.tenantId,ctx.outletId];
  if(query.status){where.push('status=?');args.push(query.status);}
  if(query.orderId){where.push('order_id=?');args.push(query.orderId);}
  return db.prepare(`SELECT * FROM print_jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...args).map(j=>({...j,ticket:j.ticket?JSON.parse(j.ticket):null}));
}
export function printSummary(db,ctx){
  permit(ctx,'orders','read');
  const rows=db.prepare('SELECT status,COUNT(*) n FROM print_jobs WHERE tenant_id=? AND outlet_id=? GROUP BY status').all(ctx.tenantId,ctx.outletId);
  const byStatus=Object.fromEntries(rows.map(r=>[r.status,r.n]));
  return {queued:byStatus.queued||0,printed:byStatus.printed||0,failed:byStatus.failed||0,needsReprint:byStatus.failed||0};
}
function printJob(db,jobId){const j=db.prepare('SELECT * FROM print_jobs WHERE id=?').get(jobId);return {...j,ticket:j.ticket?JSON.parse(j.ticket):null};}
export function mountPrinters(app,db){
  db.exec(`CREATE TABLE IF NOT EXISTS print_jobs(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,order_id TEXT NOT NULL,station TEXT NOT NULL,printer TEXT,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,actor_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,ticket TEXT,UNIQUE(tenant_id,outlet_id,idempotency_key));`);
  app.post('/api/orders/:id/print-jobs',(req,res)=>res.status(201).json(queuePrint(db,req.ctx,req.params.id,req.body)));
  app.get('/api/print-jobs',(req,res)=>res.json(printJobs(db,req.ctx,req.query)));
  app.get('/api/print-jobs/summary',(req,res)=>res.json(printSummary(db,req.ctx)));
  app.post('/api/print-jobs/:id/acknowledge',(req,res)=>res.json(acknowledgePrint(db,req.ctx,req.params.id,req.body)));
  app.post('/api/print-jobs/:id/retry',(req,res)=>res.json(retryPrint(db,req.ctx,req.params.id,req.body)));
}
