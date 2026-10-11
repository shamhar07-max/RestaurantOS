import {z} from 'zod';
import {assert,permit,createRecord} from './domain.mjs';
import {transaction,audit,id,now} from './db.mjs';

// A sub-recipe is a versioned bill of materials for a prepared output ingredient.
// Lines reference either a base ingredient or another sub-recipe, so a recipe can
// nest. Explosion resolves the full base-ingredient tree with cycle detection.
const lineSchema=z.object({ingredientId:z.string().min(1).max(200).optional(),subRecipeId:z.string().min(1).max(200).optional(),quantity:z.number().int().positive().max(100_000_000)}).strict()
  .refine(l=>Boolean(l.ingredientId)!==Boolean(l.subRecipeId),'A line must reference exactly one ingredient or sub-recipe.');
const bodySchema=z.object({name:z.string().trim().min(1).max(200),outputId:z.string().min(1).max(200),outputQuantity:z.number().int().positive().max(100_000_000),lines:z.array(lineSchema).min(1).max(40),notes:z.string().max(2000).default('')}).strict();

const scoped=(db,ctx,rid)=>db.prepare('SELECT * FROM sub_recipes WHERE id=? AND tenant_id=? AND outlet_id=?').get(rid,ctx.tenantId,ctx.outletId);
const parse=r=>r?{...r,lines:JSON.parse(r.lines)}:null;
function ingredient(db,ctx,ingredientId){return db.prepare('SELECT * FROM ingredients WHERE id=? AND tenant_id=?').get(ingredientId,ctx.tenantId);}
function activeForOutput(db,ctx,outputId){return db.prepare("SELECT * FROM sub_recipes WHERE tenant_id=? AND outlet_id=? AND output_id=? AND status='active' ORDER BY version DESC LIMIT 1").get(ctx.tenantId,ctx.outletId,outputId);}

function decorate(db,ctx,recipe){
  const out=ingredient(db,ctx,recipe.output_id);const lines=recipe.lines.map(l=>l.subRecipeId?{...l,subRecipe:parse(scoped(db,ctx,l.subRecipeId))}:{...l,ingredient:ingredient(db,ctx,l.ingredientId)});
  return {...recipe,name:recipe.name,outputName:out?.name||recipe.output_id,outputUnit:out?.unit||'',lines};
}

export function listRecipes(db,ctx,{includeSuperseded=true}={}){
  permit(ctx,'menu','read');
  const rows=db.prepare(`SELECT * FROM sub_recipes WHERE tenant_id=? AND outlet_id=? ${includeSuperseded?'':'AND status=\'active\''} ORDER BY output_id,name,version DESC`).all(ctx.tenantId,ctx.outletId).map(parse);
  return rows.map(r=>decorate(db,ctx,r));
}

function assertNoCycle(db,ctx,outputId,lines,selfId){
  const reaches=(recipeId,target,visited=new Set())=>{
    if(visited.has(recipeId))return false;visited.add(recipeId);
    const r=scoped(db,ctx,recipeId);if(!r)return false;
    const parsed=parse(r);if(parsed.output_id===target)return true;
    return parsed.lines.some(l=>l.subRecipeId&&reaches(l.subRecipeId,target,visited));
  };
  for(const l of lines){
    if(!l.subRecipeId)continue;
    const child=scoped(db,ctx,l.subRecipeId);assert(child&&child.status==='active','A nested sub-recipe must exist and be active.',404);
    if(child.id===selfId)assert(false,'A recipe cannot nest itself.',409);
    if(child.output_id===outputId)assert(false,'A recipe cannot consume its own output.',409);
    if(reaches(child.id,outputId))assert(false,'Nested recipes would form a cycle.',409);
  }
}

function validateLines(db,ctx,lines){
  const seen=new Set();
  for(const l of lines){
    if(l.ingredientId){assert(ingredient(db,ctx,l.ingredientId),'Recipe ingredient not found in this tenant.',404);assert(!seen.has(`i:${l.ingredientId}`),'Duplicate ingredient line.');seen.add(`i:${l.ingredientId}`);}
    else {const child=scoped(db,ctx,l.subRecipeId);assert(child&&child.status==='active','Nested sub-recipe not found or not active.',404);assert(!seen.has(`s:${l.subRecipeId}`),'Duplicate sub-recipe line.');seen.add(`s:${l.subRecipeId}`);}
  }
}

export function createSubRecipe(db,ctx,input){
  permit(ctx,'menu');
  const b=bodySchema.parse(input);
  return transaction(db,()=>{
    assert(ingredient(db,ctx,b.outputId),'Output ingredient not found in this tenant.',404);
    assert(!db.prepare("SELECT id FROM sub_recipes WHERE tenant_id=? AND outlet_id=? AND name=? AND status='active'").get(ctx.tenantId,ctx.outletId,b.name),'An active recipe already uses this name.',409);
    assertNoCycle(db,ctx,b.outputId,b.lines,null);validateLines(db,ctx,b.lines);
    const rid=id('recipe'),stamp=now();
    db.prepare('INSERT INTO sub_recipes VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(rid,ctx.tenantId,ctx.outletId,b.name,b.outputId,b.outputQuantity,1,'active',JSON.stringify(b.lines),stamp,stamp);
    audit(db,ctx,'recipe.created',rid,{name:b.name,outputId:b.outputId,version:1});
    return decorate(db,ctx,parse(scoped(db,ctx,rid)));
  });
}

export function reviseSubRecipe(db,ctx,recipeId,input){
  permit(ctx,'menu');
  const b=z.object({version:z.number().int().positive(),outputQuantity:z.number().int().positive().max(100_000_000),lines:z.array(lineSchema).min(1).max(40),notes:z.string().max(2000).default('')}).strict().parse(input);
  return transaction(db,()=>{
    const current=parse(scoped(db,ctx,recipeId));assert(current,'Recipe not found in this outlet.',404);assert(current.status==='active','Only the active version can be revised.',409);assert(current.version===b.version,'Recipe changed. Refresh before editing.',409);
    assertNoCycle(db,ctx,current.output_id,b.lines,current.id);validateLines(db,ctx,b.lines);
    db.prepare("UPDATE sub_recipes SET status='superseded',updated_at=? WHERE id=?").run(now(),current.id);
    const rid=id('recipe'),stamp=now();
    db.prepare('INSERT INTO sub_recipes VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(rid,ctx.tenantId,ctx.outletId,current.name,current.output_id,b.outputQuantity,current.version+1,'active',JSON.stringify(b.lines),stamp,stamp);
    audit(db,ctx,'recipe.revised',rid,{name:current.name,outputId:current.output_id,version:current.version+1,previous:current.id});
    return decorate(db,ctx,parse(scoped(db,ctx,rid)));
  });
}

export function suspendSubRecipe(db,ctx,recipeId,input){
  permit(ctx,'menu');
  const b=z.object({version:z.number().int().positive(),reason:z.string().min(3).max(500)}).strict().parse(input);
  return transaction(db,()=>{
    const current=parse(scoped(db,ctx,recipeId));assert(current,'Recipe not found in this outlet.',404);assert(current.status==='active','Only the active version can be suspended.',409);assert(current.version===b.version,'Recipe changed. Refresh before editing.',409);
    assert(!db.prepare("SELECT id FROM sub_recipes WHERE tenant_id=? AND outlet_id=? AND status='active' AND lines LIKE ?").get(ctx.tenantId,ctx.outletId,`%"subRecipeId":"${recipeId}"%`),'This recipe is nested by another active recipe. Revise that recipe first.',409);
    db.prepare("UPDATE sub_recipes SET status='superseded',updated_at=? WHERE id=?").run(now(),current.id);
    audit(db,ctx,'recipe.suspended',current.id,{reason:b.reason});return {ok:true};
  });
}

// Recursively resolve a recipe's lines into consolidated base-ingredient quantities.
function explodeLines(db,ctx,lines,factor,seen,out){
  for(const l of lines){
    if(l.ingredientId){const q=Math.round(l.quantity*factor);assert(q>0,'A scaled recipe quantity rounds below one base unit. Increase the batch size.',409);out.set(l.ingredientId,(out.get(l.ingredientId)||0)+q);continue;}
    assert(!seen.has(l.subRecipeId),'Nested recipes form a cycle.',409);seen.add(l.subRecipeId);
    const child=parse(scoped(db,ctx,l.subRecipeId));assert(child&&child.status==='active','A nested sub-recipe is missing or inactive.',409);
    explodeLines(db,ctx,child.lines,factor*l.quantity/child.output_quantity,seen,out);
    seen.delete(l.subRecipeId);
  }
  return out;
}

function requirements(db,ctx,ingredientMap){
  const lines=[...ingredientMap].map(([ingredientId,quantity])=>{
    const ing=ingredient(db,ctx,ingredientId);
    const available=db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM lots WHERE tenant_id=? AND outlet_id=? AND ingredient_id=? AND status='available' AND expiry>=?").get(ctx.tenantId,ctx.outletId,ingredientId,new Date().toISOString().slice(0,10)).n;
    return {ingredientId,name:ing?.name||ingredientId,unit:ing?.unit||'',quantity,unitCost:ing?.unit_cost||0,cost:quantity*(ing?.unit_cost||0),available,short:available<quantity};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  const allergens=[...new Set(lines.flatMap(l=>JSON.parse(ingredient(db,ctx,l.ingredientId)?.allergens||'[]')))];
  return {lines,totalCost:lines.reduce((s,l)=>s+l.cost,0),allergens,short:lines.some(l=>l.short)};
}

export function explodeRecipe(db,ctx,recipeId,quantity){
  permit(ctx,'menu','read');
  const recipe=parse(scoped(db,ctx,recipeId));assert(recipe,'Recipe not found in this outlet.',404);
  const target=quantity||recipe.output_quantity;
  const out=new Map();explodeLines(db,ctx,recipe.lines,target/recipe.output_quantity,new Set([recipe.id]),out);
  return {recipe:{id:recipe.id,name:recipe.name,version:recipe.version,outputId:recipe.output_id,outputQuantity:recipe.output_quantity},target,quantity:target,...requirements(db,ctx,out)};
}

// Explode a menu item's recipe, descending into any active sub-recipe for a selected ingredient.
export function explodeMenu(db,ctx,itemId,quantity=1){
  permit(ctx,'menu','read');
  const item=db.prepare('SELECT * FROM menu WHERE id=? AND tenant_id=? AND outlet_id=?').get(itemId,ctx.tenantId,ctx.outletId);assert(item,'Menu item not found in this outlet.',404);
  const recipe=JSON.parse(item.recipe),out=new Map(),nested=[];
  for(const l of recipe){
    const child=activeForOutput(db,ctx,l.ingredientId);
    if(child){nested.push({ingredientId:l.ingredientId,name:ingredient(db,ctx,l.ingredientId)?.name||l.ingredientId,recipeId:child.id,version:child.version});explodeLines(db,ctx,JSON.parse(child.lines),(l.quantity*quantity)/child.output_quantity,new Set([child.id]),out);}
    else out.set(l.ingredientId,(out.get(l.ingredientId)||0)+l.quantity*quantity);
  }
  return {item:{id:item.id,name:item.name,version:item.version},quantity,nested,...requirements(db,ctx,out)};
}

// Create a planned production batch from a recipe, consuming its immediate inputs.
export function planProduction(db,ctx,recipeId,input){
  permit(ctx,'production');
  const b=z.object({name:z.string().trim().min(1).max(200),quantity:z.number().int().positive().max(100_000_000),expiry:z.iso.date(),notes:z.string().max(2000).default(''),deep:z.boolean().default(false)}).strict().parse(input);
  return transaction(db,()=>{
    const recipe=parse(scoped(db,ctx,recipeId));assert(recipe&&recipe.status==='active','An active recipe is required.',404);
    const factor=b.quantity/recipe.output_quantity,aggregate=new Map();
    if(b.deep){
      explodeLines(db,ctx,recipe.lines,factor,new Set([recipe.id]),aggregate);
    } else {
      for(const l of recipe.lines){const ingredientId=l.ingredientId||parse(scoped(db,ctx,l.subRecipeId)).output_id;const q=Math.round(l.quantity*factor);assert(q>0,'A scaled input rounds below one base unit. Increase the batch size.',409);aggregate.set(ingredientId,(aggregate.get(ingredientId)||0)+q);}
    }
    const inputs=[...aggregate].map(([ingredientId,quantity])=>({ingredientId,quantity}));
    const batch=createRecord(db,ctx,'batches',{name:b.name,outputId:recipe.output_id,outputQuantity:b.quantity,expiry:b.expiry,inputs,notes:b.notes||`Planned from ${recipe.name} v${recipe.version}`});
    audit(db,ctx,'recipe.production_planned',batch.id,{recipeId,recipeVersion:recipe.version,quantity:b.quantity,deep:b.deep});
    return {recipeId,recipeVersion:recipe.version,batch,batchId:batch.id,inputs,deep:b.deep,requirements:requirements(db,ctx,aggregate)};
  });
}

export function mountRecipes(app,db){
  app.get('/api/recipes',(req,res)=>res.json(listRecipes(db,req.ctx)));
  app.post('/api/recipes',(req,res)=>res.status(201).json(createSubRecipe(db,req.ctx,req.body)));
  app.get('/api/recipes/:id/explode',(req,res)=>res.json(explodeRecipe(db,req.ctx,req.params.id,req.query.quantity?Number(req.query.quantity):undefined)));
  app.post('/api/recipes/:id/revision',(req,res)=>res.json(reviseSubRecipe(db,req.ctx,req.params.id,req.body)));
  app.post('/api/recipes/:id/suspend',(req,res)=>res.json(suspendSubRecipe(db,req.ctx,req.params.id,req.body)));
  app.post('/api/recipes/:id/produce',(req,res)=>res.status(201).json(planProduction(db,req.ctx,req.params.id,req.body)));
  app.get('/api/menu/:id/explode',(req,res)=>res.json(explodeMenu(db,req.ctx,req.params.id,req.query.quantity?Number(req.query.quantity):1)));
}
