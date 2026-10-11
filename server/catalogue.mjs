import {z} from 'zod';
import {assert,permit} from './domain.mjs';
import {transaction,audit} from './db.mjs';
export function configureCombo(db,ctx,itemId,input){
  permit(ctx,'menu');
  const b=z.object({version:z.number().int().positive(),components:z.array(z.object({itemId:z.string(),quantity:z.number().int().min(1).max(20),modifierIds:z.array(z.string()).max(20).default([])})).min(1).max(20)}).parse(input);
  return transaction(db,()=>{
    const item=db.prepare('SELECT * FROM menu WHERE id=? AND tenant_id=? AND outlet_id=?').get(itemId,ctx.tenantId,ctx.outletId);assert(item,'Menu item not found.',404);assert(item.version===b.version,'Menu changed. Refresh before editing.',409);
    assert(b.components.reduce((s,c)=>s+c.quantity,0)<=20,'A combo supports at most 20 component units.');
    assert(!db.prepare('SELECT components FROM menu_combos').all().some(r=>JSON.parse(r.components).some(c=>c.itemId===itemId)),'An existing combo component cannot become a combo.',409);
    for(const c of b.components){assert(c.itemId!==itemId,'A combo cannot contain itself.');const child=db.prepare('SELECT * FROM menu WHERE id=? AND tenant_id=? AND outlet_id=?').get(c.itemId,ctx.tenantId,ctx.outletId);assert(child,'Component is not in this outlet.',404);assert(!db.prepare('SELECT item_id FROM menu_combos WHERE item_id=?').get(c.itemId),'Nested combos are not supported.');assert(child.price>0,'Component prices must be positive.');const options=JSON.parse(child.modifiers);assert(new Set(c.modifierIds).size===c.modifierIds.length,'Duplicate component modifier.');const chosen=c.modifierIds.map(mid=>{const m=options.find(x=>x.id===mid);assert(m,'Unknown component modifier.');return m;});for(const g of new Map(options.filter(m=>m.group).map(m=>[m.group.id,m.group])).values()){const count=chosen.filter(m=>m.group?.id===g.id).length;assert(count>=(g.min||0)&&count<=g.max,'Component modifier group selection is invalid.');}}
    db.prepare('INSERT INTO menu_combos VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET components=excluded.components').run(item.id,JSON.stringify(b.components));
    db.prepare("UPDATE menu SET recipe='[]',modifiers='[]',version=version+1 WHERE id=?").run(item.id);
    audit(db,ctx,'menu.combo_configured',item.id,{version:item.version+1,components:b.components});return {ok:true,version:item.version+1};
  });
}
export function mountCatalogue(app,db){app.get('/api/menu/:id/combo',(req,res)=>{permit(req.ctx,'menu','read');const item=db.prepare('SELECT id,name,price,version,available FROM menu WHERE id=? AND tenant_id=? AND outlet_id=?').get(req.params.id,req.ctx.tenantId,req.ctx.outletId);assert(item,'Menu item not found.',404);const configuration=db.prepare('SELECT components FROM menu_combos WHERE item_id=?').get(item.id);res.json({...item,components:configuration?JSON.parse(configuration.components):null});});app.post('/api/menu/:id/combo',(req,res)=>res.json(configureCombo(db,req.ctx,req.params.id,req.body)));}
