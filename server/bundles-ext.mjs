import {z} from 'zod';
import {id,now,transaction,audit} from './db.mjs';
import {assert,permit} from './domain.mjs';
const text=z.string().max(4000);
const choiceSchema=z.object({itemId:z.string().min(1).max(200),modifierIds:z.array(z.string().max(200)).max(20).default([])}).strict();

// Mix-and-match bundles: a fixed-price group purchase where a customer chooses
// one option per configured group (pick exactly N from M). Selection is resolved
// at order time into component lines that carry stock, allergens, kitchen
// stations and an immutable snapshot like any other menu line.
function validateGroups(db,ctx,groups){
  for(const g of groups){
    assert(g.max>=g.min,'Group maximum cannot be below its minimum.');
    assert(g.min>=1&&g.max<=20,'Groups support 1–20 picks.');
    assert(g.min===g.max,'A mix-and-match bundle fixes the pick count per group.',409);
    assert(new Set(g.choices.map(c=>c.itemId)).size===g.choices.length,'An option can appear only once in a group.');
    for(const c of g.choices){
      const item=db.prepare('SELECT * FROM menu WHERE id=? AND tenant_id=? AND outlet_id=?').get(c.itemId,ctx.tenantId,ctx.outletId);
      assert(item,'Bundle option is not a menu item in this outlet.',404);
      const modifiers=JSON.parse(item.modifiers);
      for(const mid of c.modifierIds)assert(modifiers.some(m=>m.id===mid),'Bundle option references an invalid modifier.',409);
    }
  }
  assert(groups.reduce((s,g)=>s+g.min,0)<=50,'A bundle cannot exceed 50 total picks.');
}
export function createBundleConfig(db,ctx,input){
  assert(['owner','manager'].includes(ctx.user.role),'Bundle configuration requires a manager or owner.',403);permit(ctx,'catalogue');
  const body=z.object({name:z.string().trim().min(1).max(200),price:z.number().int().positive().max(100_000_000),groups:z.array(z.object({label:z.string().trim().min(1).max(120),min:z.number().int(),max:z.number().int(),choices:z.array(choiceSchema).min(1).max(30)}).strict()).min(1).max(10),evidence:text.min(3)}).strict().parse(input);
  return transaction(db,()=>{
    validateGroups(db,ctx,body.groups);
    const cid=id('bundle');
    db.prepare('INSERT INTO bundle_configs VALUES(?,?,?,?,?,?,?,?,?,?)').run(cid,ctx.tenantId,ctx.outletId,body.name,body.price,JSON.stringify(body.groups),'active',1,now(),now());
    audit(db,ctx,'catalogue.bundle_created',cid,{name:body.name,price:body.price});
    return bundleConfig(db,ctx,cid);
  });
}
export function updateBundleConfig(db,ctx,bundleId,input){
  assert(['owner','manager'].includes(ctx.user.role),'Bundle configuration requires a manager or owner.',403);permit(ctx,'catalogue');
  const body=z.object({version:z.number().int().positive(),name:z.string().trim().min(1).max(200).optional(),price:z.number().int().positive().max(100_000_000).optional(),groups:z.array(z.object({label:z.string().trim().min(1).max(120),min:z.number().int(),max:z.number().int(),choices:z.array(choiceSchema).min(1).max(30)}).strict()).min(1).max(10).optional(),evidence:text.min(3)}).strict().parse(input);
  return transaction(db,()=>{
    const cfg=db.prepare('SELECT * FROM bundle_configs WHERE id=? AND tenant_id=? AND outlet_id=?').get(bundleId,ctx.tenantId,ctx.outletId);
    assert(cfg,'Bundle configuration not found.',404);
    assert(cfg.status==='active','Suspended bundles must be re-activated before editing.',409);
    assert(body.version===cfg.version,'The bundle changed on another screen. Refresh and retry.',409);
    if(body.groups)validateGroups(db,ctx,body.groups);
    db.prepare('UPDATE bundle_configs SET name=?,price=?,groups=?,version=version+1,updated_at=? WHERE id=?').run(body.name??cfg.name,body.price??cfg.price,body.groups?JSON.stringify(body.groups):cfg.groups,now(),bundleId);
    audit(db,ctx,'catalogue.bundle_updated',bundleId,{version:cfg.version,evidence:body.evidence});
    return bundleConfig(db,ctx,bundleId);
  });
}
export function suspendBundleConfig(db,ctx,bundleId,input){
  assert(['owner','manager'].includes(ctx.user.role),'Bundle configuration requires a manager or owner.',403);permit(ctx,'catalogue');
  const body=z.object({version:z.number().int().positive(),evidence:text.min(3)}).strict().parse(input);
  return transaction(db,()=>{
    const cfg=db.prepare('SELECT * FROM bundle_configs WHERE id=? AND tenant_id=? AND outlet_id=?').get(bundleId,ctx.tenantId,ctx.outletId);
    assert(cfg,'Bundle configuration not found.',404);assert(body.version===cfg.version,'The bundle changed on another screen. Refresh and retry.',409);
    db.prepare("UPDATE bundle_configs SET status='suspended',updated_at=? WHERE id=?").run(now(),bundleId);
    audit(db,ctx,'catalogue.bundle_suspended',bundleId,{evidence:body.evidence});
    return bundleConfig(db,ctx,bundleId);
  });
}
export function bundleConfigs(db,ctx){permit(ctx,'catalogue','read');return db.prepare('SELECT * FROM bundle_configs WHERE tenant_id=? AND outlet_id=? ORDER BY created_at').all(ctx.tenantId,ctx.outletId).map(m=>mapBundle(m));}
export function bundleConfig(db,ctx,bundleId){permit(ctx,'catalogue','read');const cfg=db.prepare('SELECT * FROM bundle_configs WHERE id=? AND tenant_id=? AND outlet_id=?').get(bundleId,ctx.tenantId,ctx.outletId);assert(cfg,'Bundle configuration not found.',404);return mapBundle(cfg);}
function mapBundle(cfg){return {...cfg,groups:JSON.parse(cfg.groups),createdAt:cfg.created_at,updatedAt:cfg.updated_at};}