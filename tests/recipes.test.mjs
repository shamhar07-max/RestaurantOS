import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { createApp } from '../server/app.mjs';
import { createSubRecipe,reviseSubRecipe,suspendSubRecipe,explodeRecipe,explodeMenu,planProduction,listRecipes } from '../server/recipes.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const sauceLines=[{ingredientId:'tomato',quantity:100},{ingredientId:'milk',quantity:200}];

async function server(t){
  const {db,ctx}=fixture();
  const app=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');
  await new Promise(resolve=>app.once('listening',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const signIn=async role=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})});const session=await res.json();return {headers:{'cookie':res.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'x-outlet-id':'outlet_downtown'}};};
  const call=async(session,path,options={})=>{const res=await fetch(base+path,{...options,headers:{...session.headers,...(options.headers||{})}});return {status:res.status,body:await res.json()};};
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));db.close();});
  return {db,ctx,base,owner:await signIn('owner'),chef:await signIn('chef'),cashier:await signIn('cashier'),call};
}

test('a versioned sub-recipe explodes to base ingredients with cost, allergens and shortages',()=>{
  const {db,ctx}=fixture();
  const recipe=createSubRecipe(db,ctx,{name:'House sauce base',outputId:'sauce',outputQuantity:111,lines:sauceLines});
  assert.equal(recipe.version,1);assert.equal(recipe.outputName,'House sauce');
  const exploded=explodeRecipe(db,ctx,recipe.id,111);
  const byId=Object.fromEntries(exploded.lines.map(l=>[l.ingredientId,l.quantity]));
  assert.equal(byId.tomato,100);assert.equal(byId.milk,200);
  assert.equal(exploded.totalCost,100*1+200*1,'cost uses ingredient base-unit cost');
  assert.ok(exploded.allergens.includes('milk'));
  assert.equal(exploded.short,false);
  const doubled=explodeRecipe(db,ctx,recipe.id,222);
  assert.equal(Object.fromEntries(doubled.lines.map(l=>[l.ingredientId,l.quantity])).tomato,200);
  db.close();
});

test('revising a recipe supersedes the old version and keeps history',()=>{
  const {db,ctx}=fixture();
  const v1=createSubRecipe(db,ctx,{name:'House sauce base',outputId:'sauce',outputQuantity:100,lines:[{ingredientId:'tomato',quantity:100}]});
  const v2=reviseSubRecipe(db,ctx,v1.id,{version:1,outputQuantity:200,lines:[{ingredientId:'tomato',quantity:100},{ingredientId:'oil',quantity:20}]});
  assert.equal(v2.version,2);assert.equal(v2.status,'active');
  assert.equal(db.prepare('SELECT status FROM sub_recipes WHERE id=?').get(v1.id).status,'superseded');
  const exploded=explodeRecipe(db,ctx,v2.id,200);
  assert.deepEqual(Object.fromEntries(exploded.lines.map(l=>[l.ingredientId,l.quantity])),{tomato:100,oil:20});
  const listed=listRecipes(db,ctx);
  assert.equal(listed.length,2,'both versions are visible for audit');
  assert.equal(listed.filter(r=>r.status==='active').length,1);
  db.close();
});

test('nested recipes consolidate the full base-ingredient tree and scale correctly',()=>{
  const {db,ctx}=fixture();
  const base=createSubRecipe(db,ctx,{name:'Marinade base',outputId:'sauce',outputQuantity:100,lines:[{ingredientId:'tomato',quantity:100},{ingredientId:'oat',quantity:50}]});
  const outer=createSubRecipe(db,ctx,{name:'Chicken marinade',outputId:'chicken',outputQuantity:200,lines:[{subRecipeId:base.id,quantity:100},{ingredientId:'oil',quantity:10}]});
  const one=explodeRecipe(db,ctx,outer.id,200);
  assert.deepEqual(Object.fromEntries(one.lines.map(l=>[l.ingredientId,l.quantity])),{tomato:100,oat:50,oil:10});
  const two=explodeRecipe(db,ctx,outer.id,400);
  assert.deepEqual(Object.fromEntries(two.lines.map(l=>[l.ingredientId,l.quantity])),{tomato:200,oat:100,oil:20});
  db.close();
});

test('recipe cycles are rejected and a nested recipe cannot be suspended while in use',()=>{
  const {db,ctx}=fixture();
  const a=createSubRecipe(db,ctx,{name:'Base A',outputId:'sauce',outputQuantity:100,lines:[{ingredientId:'tomato',quantity:100}]});
  const b=createSubRecipe(db,ctx,{name:'Base B',outputId:'beef',outputQuantity:100,lines:[{subRecipeId:a.id,quantity:100}]});
  assert.throws(()=>reviseSubRecipe(db,ctx,a.id,{version:1,outputQuantity:100,lines:[{subRecipeId:b.id,quantity:100}]}),/cycle/);
  assert.throws(()=>reviseSubRecipe(db,ctx,a.id,{version:1,outputQuantity:100,lines:[{subRecipeId:a.id,quantity:100}]}),/itself/);
  assert.throws(()=>suspendSubRecipe(db,ctx,a.id,{version:1,reason:'No longer used'}),/nested/);
  db.close();
});

test('a menu item explodes through any active sub-recipe for a selected ingredient',()=>{
  const {db,ctx}=fixture();
  // The seeded burger uses ingredient 'sauce'. Give 'sauce' a nested BOM and it should explode through.
  createSubRecipe(db,ctx,{name:'House sauce base',outputId:'sauce',outputQuantity:30,lines:[{ingredientId:'tomato',quantity:20},{ingredientId:'cheese',quantity:5}]});
  const exploded=explodeMenu(db,ctx,'burger_outlet_downtown',1);
  assert.equal(exploded.nested.length,1);assert.equal(exploded.nested[0].ingredientId,'sauce');
  const byId=Object.fromEntries(exploded.lines.map(l=>[l.ingredientId,l.quantity]));
  assert.equal(byId.sauce,undefined,'the nested sauce is replaced by its components');
  assert.equal(byId.tomato,20,'30g sauce bill consumes 20g tomato');assert.equal(byId.cheese,5);
  assert.equal(byId.beef,180,'direct burger ingredients are unchanged');
  db.close();
});

test('production can be planned from a recipe and consolidated into a planned batch',async t=>{
  const {db,ctx,owner,chef,cashier,call}=await server(t);
  const created=await call(owner,'/api/recipes',{method:'POST',body:JSON.stringify({name:'House sauce base',outputId:'sauce',outputQuantity:111,lines:sauceLines})});
  assert.equal(created.status,201);assert.equal(created.body.version,1);
  const forbidden=await call(cashier,`/api/recipes/${created.body.id}/produce`,{method:'POST',body:JSON.stringify({name:'Sauce run',quantity:222,expiry:'2099-01-01'})});
  assert.equal(forbidden.status,403,'planning production needs production permission');
  const planned=await call(chef,`/api/recipes/${created.body.id}/produce`,{method:'POST',body:JSON.stringify({name:'Sauce run',quantity:222,expiry:'2099-01-01'})});
  assert.equal(planned.status,201);
  assert.equal(planned.body.batch.status,'planned');assert.equal(planned.body.batch.data.outputId,'sauce');assert.equal(planned.body.batch.data.outputQuantity,222);
  assert.deepEqual(Object.fromEntries(planned.body.inputs.map(i=>[i.ingredientId,i.quantity])),{tomato:200,milk:400});
  const settings=await call(owner,`/api/recipes/${created.body.id}/explode?quantity=111`,{});
  assert.equal(settings.status,200);assert.equal(settings.body.quantity,111);
  const castRecipeList=await call(cashier,'/api/recipes',{});assert.equal(castRecipeList.status,200,'menu read scope can view recipes');
  assert.equal((await call(cashier,'/api/recipes',{method:'POST',body:JSON.stringify({name:'No',outputId:'sauce',outputQuantity:1,lines:[{ingredientId:'tomato',quantity:1}]})})).status,403,'recipe editing needs menu write scope');
});
