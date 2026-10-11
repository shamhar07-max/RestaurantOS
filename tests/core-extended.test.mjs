import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate,now,id } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createRecord,recordAction,getRecord,moveStock,stockPlacement,contractRateAt } from '../server/domain.mjs';
import { createSubRecipe,planProduction } from '../server/recipes.mjs';
import { mealCalendar,serviceSchedule,productionPlan } from '../server/mes.mjs';
import { compareSupplierOffers,approvedSubstitute,recipeImpact,reviewPublication,allocateCateringResources,cateringResourceReport,aspProviders,selectAspProvider,aspSubmit,aspAcknowledge,aspSubmissions,registerAspAdapter } from '../server/operations-ext.mjs';
import { createOrder } from '../server/domain.mjs';
import { createApp } from '../server/app.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'},user};};
const tomorrow=()=>new Date(Date.now()+86400000).toISOString().slice(0,10);
const weekdayOf=date=>new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Dubai',weekday:'short'}).format(new Date(`${date}T12:00:00Z`));
const contractBase=()=>({name:'Site meal contract',payer:'Example Co.',site:'Business Bay',billingBasis:'accepted_meal',rate:1200,minimum:0,eligible:100,accepted:100,served:0,mealType:'lunch',startDate:businessDate(),endDate:'2099-01-01',notes:'Client approved terms'});

async function server(t){
  const {db,ctx}=fixture();
  const app=createApp(db,{demo:true,production:false,staticDir:'/tmp/nonexistent-restaurant-static'}).listen(0,'127.0.0.1');
  await new Promise(resolve=>app.once('listening',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const signIn=async r=>{const res=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:r})});const session=await res.json();return {headers:{'cookie':res.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'x-outlet-id':'outlet_downtown'}};};
  const call=async(session,path,options={})=>{const res=await fetch(base+path,{...options,headers:{...session.headers,...(options.headers||{})}});return {status:res.status,body:await res.json()};};
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));db.close();});
  return {db,ctx,base,owner:await signIn('owner'),chef:await signIn('chef'),cashier:await signIn('cashier'),call};
}

test('MES-06 a meal calendar resolves served meals by weekday and shift window',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  const breakfast=createRecord(db,ctx,'meal_calendars',{name:'Breakfast rota',contractId:c.id,mealType:'breakfast',days:'Mon–Fri',serviceStart:'06:30',serviceEnd:'09:00',rateCode:'breakfast_std',notes:'Weekday breakfast'});
  recordAction(db,ctx,breakfast.id,{action:'active',version:breakfast.version,reason:'Rota confirmed'});
  const dinner=createRecord(db,ctx,'meal_calendars',{name:'Dinner rota',contractId:c.id,mealType:'dinner',days:'Sat,Sun',serviceStart:'18:00',serviceEnd:'21:00',rateCode:'dinner_std',notes:'Weekend dinner'});
  recordAction(db,ctx,dinner.id,{action:'active',version:dinner.version,reason:'Rota confirmed'});
  const date='2099-06-01',wd=weekdayOf(date);
  const cal=mealCalendar(db,ctx,c.id,date);
  const weekend=['Sat','Sun'].includes(wd);
  assert.deepEqual(cal.served,weekend?['dinner']:['breakfast']);
  assert.equal(cal.meals.find(m=>m.mealType==='breakfast').serviceStart,'06:30');
  assert.equal(cal.meals.find(m=>m.mealType==='breakfast').rateCode,'breakfast_std');
  assert.equal(cal.headcount,100);
  const schedule=serviceSchedule(db,ctx,c.id,date,tomorrow()>date?tomorrow():date);
  assert.ok(schedule.days.length>=1);
  db.close();
});

test('MES-06 without a calendar the contract meal type is derived for every day',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  const cal=mealCalendar(db,ctx,c.id);
  assert.deepEqual(cal.served,['lunch']);
  assert.equal(cal.meals[0].status,'derived');
  db.close();
});

test('CORE-05 production can consume multi-level base ingredients and link demand to capacity',()=>{
  const {db,ctx}=fixture();
  const c=createRecord(db,ctx,'contracts',contractBase());
  const base=createSubRecipe(db,ctx,{name:'Sauce base',outputId:'sauce',outputQuantity:100,lines:[{ingredientId:'tomato',quantity:100}]});
  const outer=createSubRecipe(db,ctx,{name:'Marinade',outputId:'chicken',outputQuantity:200,lines:[{subRecipeId:base.id,quantity:100},{ingredientId:'oil',quantity:20}]});
  const shallow=planProduction(db,ctx,outer.id,{name:'Shallow run',quantity:200,expiry:tomorrow(),deep:false});
  assert.deepEqual(Object.fromEntries(shallow.inputs.map(i=>[i.ingredientId,i.quantity])),{sauce:100,oil:20});
  const deep=planProduction(db,ctx,outer.id,{name:'Deep run',quantity:200,expiry:tomorrow(),deep:true});
  assert.deepEqual(Object.fromEntries(deep.inputs.map(i=>[i.ingredientId,i.quantity])),{tomato:100,oil:20});
  db.prepare("INSERT INTO settings VALUES(?,?,?,?)").run(ctx.tenantId,ctx.outletId,'productionCapacity',JSON.stringify({units:50}));
  createRecord(db,ctx,'demand_snapshots',{name:'Lunch demand',contractId:c.id,mealType:'lunch',date:businessDate(),quantity:100,cutoffAt:'2099-01-01T12:00',notes:'x'});
  const plan=productionPlan(db,ctx,businessDate());
  assert.equal(plan.capacity,50);assert.equal(plan.required,100);assert.equal(plan.shortfall,50);assert.equal(plan.within,false);
  db.close();
});

test('CORE-01 stock can be placed and partially moved between locations',()=>{
  const {db,ctx}=fixture();
  const location='location_outlet_downtown_main';
  const moved=moveStock(db,ctx,'lot_oat_outlet_downtown',{locationId:location,quantity:150,reason:'Placed on shelf A'});
  assert.equal(moved.quantity,150);assert.equal(moved.locationId,location);
  const source=db.prepare('SELECT * FROM lots WHERE id=?').get('lot_oat_outlet_downtown');
  assert.equal(source.quantity,500,'the remainder stays in the source lot');
  const spilled=db.prepare('SELECT * FROM lots WHERE id=?').get(moved.lotId);
  assert.equal(spilled.quantity,150);assert.equal(spilled.origin,'lot_oat_outlet_downtown');
  const placement=stockPlacement(db,ctx);
  assert.equal(placement.locations.find(l=>l.id===location).lots.find(l=>l.id===moved.lotId).quantity,150);
  assert.throws(()=>moveStock(db,ctx,moved.lotId,{locationId:location,quantity:50,reason:'Same place'}),/already placed/);
  db.close();
});

test('CORE-01 an intercompany transfer posts intercompany journals on both entities',()=>{
  const {db,ctx,user}=fixture();
  db.prepare('INSERT INTO entities VALUES(?,?,?,?)').run('entity_llc','tenant_burj','Fig & Pear Marina LLC','');
  db.prepare('INSERT INTO outlets(id,tenant_id,entity_id,name,brand,format) VALUES(?,?,?,?,?,?)').run('outlet_llc','tenant_burj','entity_llc','Marina LLC','Fig & Pear','dine_in');
  user.outlet_ids.push('outlet_llc');
  const t=createRecord(db,ctx,'transfers',{name:'Intercompany oat',ingredientId:'oat',quantity:100,destinationId:'outlet_llc',notes:'Intercompany supply'});
  const dispatched=recordAction(db,ctx,t.id,{action:'in_transit',version:t.version,reason:'Intercompany dispatch approved',evidence:'Gate pass'});
  assert.equal(dispatched.data.intercompany,true);
  assert.ok(db.prepare("SELECT id FROM journals WHERE origin=? AND type='intercompany_dispatch'").get(t.id),'the seller books an intercompany receivable');
  const received=recordAction(db,ctx,t.id,{action:'received',version:getRecord(db,ctx,t.id).version,reason:'Received',evidence:'Signed gate pass'});
  assert.equal(received.status,'received');
  assert.ok(db.prepare("SELECT id FROM journals WHERE origin=? AND type='intercompany_receive'").get(t.id),'the buyer books the mirror intercompany entry');
  assert.equal(db.prepare("SELECT quantity FROM lots WHERE outlet_id='outlet_llc' AND ingredient_id='oat' AND origin=?").get(t.id).quantity,100);
  db.close();
});

test('CORE-15 an ingredient substitution needs approval before it is surfaced',()=>{
  const {db,ctx}=fixture();
  assert.equal(approvedSubstitute(db,ctx,'milk'),null);
  const s=createRecord(db,ctx,'substitutions',{name:'Oat for dairy',ingredientId:'milk',substituteId:'oat',quantity:180,reason:'Dairy shortage'});
  assert.equal(s.status,'draft');
  assert.equal(approvedSubstitute(db,ctx,'milk'),null,'a draft substitution is not used');
  const approved=recordAction(db,ctx,s.id,{action:'approved',version:s.version,reason:'Chef and nutrition approved',evidence:'Signed substitution sheet'});
  assert.equal(approved.status,'approved');
  assert.equal(approvedSubstitute(db,ctx,'milk').substituteId,'oat');
  assert.throws(()=>createRecord(db,ctx,'substitutions',{name:'Bad',ingredientId:'milk',substituteId:'milk',quantity:1,reason:'x'}),/different substitute/);
  db.close();
});

test('CORE-15 supplier offers are ranked by effective unit cost and lead time',()=>{
  const {db,ctx}=fixture();
  createRecord(db,ctx,'packs',{name:'Oat milk · 6 × 1 L',supplierId:'supplier_prime',ingredientId:'oat',packSize:6000,packCost:10800,notes:'Alternative pack'});
  const compared=compareSupplierOffers(db,ctx,'oat',5000);
  assert.equal(compared.offers.length,2);
  assert.equal(compared.recommended,compared.offers[0]);
  assert.ok(compared.offers[0].effectiveUnitCost<=compared.offers[1].effectiveUnitCost);
  const bySupplier=Object.fromEntries(compared.offers.map(o=>[o.supplierId,o]));
  assert.equal(bySupplier.supplier_green.unitCost,2);
  assert.equal(bySupplier.supplier_prime.unitCost,1.8);
  assert.equal(bySupplier.supplier_green.packsNeeded,1);
  assert.equal(bySupplier.supplier_prime.packsNeeded,1);
  db.close();
});

test('CORE-16 a component change reports affected menu items and live orders',()=>{
  const {db,ctx}=fixture();
  const sauce=createSubRecipe(db,ctx,{name:'House sauce base',outputId:'sauce',outputQuantity:30,lines:[{ingredientId:'tomato',quantity:20}]});
  createOrder(db,ctx,{service:'takeaway',channel:'POS',customer:'Guest',idempotencyKey:'impact-key-0001',lines:[{itemId:'burger_outlet_downtown',quantity:1}]});
  const impact=recipeImpact(db,ctx,sauce.id);
  const itemIds=impact.affectedItems.map(i=>i.id).sort();
  assert.deepEqual(itemIds,['bowl_outlet_downtown','burger_outlet_downtown']);
  assert.equal(impact.affectedOrders.length,1);
  const review=reviewPublication(db,ctx,sauce.id,{decision:'approved',evidence:'Allergen review complete'});
  assert.equal(review.decision,'approved');assert.equal(review.affectedItems.length,2);
  db.close();
});

test('CORE-17 catering resources are checked for double-booking and over-commitment',()=>{
  const {db,ctx}=fixture();
  const oven=createRecord(db,ctx,'catering_resources',{name:'Portable oven',type:'equipment',quantity:1,notes:'Single unit'});
  const chef=createRecord(db,ctx,'catering_resources',{name:'Event chef',type:'staff',quantity:2,notes:'Two chefs available'});
  const date=businessDate();
  const first=createRecord(db,ctx,'catering',{name:'Wedding A',customer:'A',date,venue:'Hall',guests:80,quoteAmount:500000,deposit:0,dietary:'',resources:'',notes:''});
  const second=createRecord(db,ctx,'catering',{name:'Wedding B',customer:'B',date,venue:'Hall',guests:60,quoteAmount:400000,deposit:0,dietary:'',resources:'',notes:''});
  const firstAlloc=allocateCateringResources(db,ctx,first.id,{allocations:[{resourceId:oven.id,quantity:1},{resourceId:chef.id,quantity:1}],reason:'Confirmed with client'});
  assert.equal(firstAlloc.allocations.length,2);
  assert.throws(()=>allocateCateringResources(db,ctx,second.id,{allocations:[{resourceId:oven.id,quantity:1}],reason:'Second event'}),/over-committed/);
  assert.throws(()=>allocateCateringResources(db,ctx,second.id,{allocations:[{resourceId:chef.id,quantity:1}],reason:'Second event'}),/already allocated/);
  const report=cateringResourceReport(db,ctx,date);
  assert.equal(report.resources.find(r=>r.id===oven.id).available,0);
  db.prepare("INSERT INTO settings VALUES(?,?,?,?)").run(ctx.tenantId,ctx.outletId,'venueCapacity',JSON.stringify({guests:70}));
  createRecord(db,ctx,'catering',{name:'Large gala',customer:'C',date,venue:'Hall',guests:80,quoteAmount:1,deposit:0,dietary:'',resources:'',notes:''});
  assert.throws(()=>allocateCateringResources(db,ctx,first.id,{allocations:[{resourceId:oven.id,quantity:1}],reason:'Recount'}),/venue capacity/);
  db.close();
});

test('CORE-18 the ASP interface requires a validated provider and records the transmission lifecycle',()=>{
  const {db,ctx}=fixture();
  assert.ok(aspProviders().length>=1);
  const config=selectAspProvider(db,ctx,{providerId:'peppol_access_point',evidence:'ASP agreement signed'});
  assert.equal(config.enabled,false,'no validated adapter yet');
  assert.throws(()=>aspSubmit(db,ctx,{documentType:'tax_invoice',reference:'INV-1',amount:10000,tax:500,buyer:'Example Co.',idempotencyKey:'asp-key-0001'}),/validated ASP provider/);
  registerAspAdapter('peppol_access_point',{transmit:payload=>({status:'submitted',reference:`AP-${payload.reference}`})});
  const enabled=selectAspProvider(db,ctx,{providerId:'peppol_access_point',endpoint:'https://asp.example.test/peppol',evidence:'Endpoint verified'});
  assert.equal(enabled.enabled,true);
  const submitted=aspSubmit(db,ctx,{documentType:'tax_invoice',reference:'INV-1',amount:10000,tax:500,buyer:'Example Co.',idempotencyKey:'asp-key-0001'});
  assert.equal(submitted.status,'submitted');assert.equal(submitted.provider_reference,'AP-INV-1');
  const replay=aspSubmit(db,ctx,{documentType:'tax_invoice',reference:'INV-1',amount:10000,tax:500,buyer:'Example Co.',idempotencyKey:'asp-key-0001'});
  assert.equal(replay.id,submitted.id,'the transmission is idempotent');
  const acknowledged=aspAcknowledge(db,ctx,submitted.id,{status:'accepted',reference:'AP-ACK-1',evidence:'Provider acknowledgement'});
  assert.equal(acknowledged.status,'accepted');
  assert.throws(()=>aspAcknowledge(db,ctx,submitted.id,{status:'accepted',evidence:'Again'}),/already acknowledged/);
  assert.equal(aspSubmissions(db,ctx).length,1);
  db.close();
});

test('remaining operations endpoints enforce permissions and return the new reports',async t=>{
  const {owner,chef,cashier,call}=await server(t);
  const sauce=await call(owner,'/api/recipes',{method:'POST',body:JSON.stringify({name:'House sauce base',outputId:'sauce',outputQuantity:30,lines:[{ingredientId:'tomato',quantity:20}]})});
  assert.equal(sauce.status,201);
  assert.equal((await call(cashier,`/api/recipes/${sauce.body.id}/impact`,{})).status,403,'cashier lacks production read');
  const impact=await call(owner,`/api/recipes/${sauce.body.id}/impact`,{});
  assert.equal(impact.status,200);assert.ok(impact.body.affectedItems.length>=1);
  assert.equal((await call(owner,`/api/recipes/${sauce.body.id}/impact/review`,{method:'POST',body:JSON.stringify({decision:'approved',evidence:'Reviewed'})})).status,200);
  const offers=await call(owner,'/api/purchasing/offers?ingredientId=oat&quantity=5000',{});
  assert.equal(offers.status,200);assert.ok(offers.body.offers.length>=1);
  assert.equal((await call(owner,'/api/inventory/placement',{})).status,200);
  assert.equal((await call(owner,'/api/catering/resources',{})).status,200);
  const asp=await call(owner,'/api/finance/asp',{});
  assert.equal(asp.status,200);assert.ok(asp.body.providers.length>=1);
  assert.equal((await call(cashier,'/api/purchasing/offers?ingredientId=oat&quantity=5000',{})).status,403,'cashier lacks purchasing read');
});
