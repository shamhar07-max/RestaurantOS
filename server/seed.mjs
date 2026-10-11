import {id,now,businessDate,passwordHash} from './db.mjs';
export function seed(db,{demo=true,adminEmail,adminPassword}={}) {
  if(db.prepare('SELECT COUNT(*) n FROM tenants').get().n)return;
  if(!demo&&(!adminEmail||!adminPassword||adminPassword.length<12))throw new Error('Fresh production setup requires ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters).');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO tenants VALUES(?,?)').run('tenant_burj','DigitalBurj Hospitality');
    db.prepare('INSERT INTO entities VALUES(?,?,?,?)').run('entity_burj','tenant_burj','Fig & Pear Hospitality LLC','');
    for(const [oid,name] of [['outlet_downtown','Downtown Dubai'],['outlet_marina','Dubai Marina']])db.prepare('INSERT INTO outlets(id,tenant_id,entity_id,name,brand,format) VALUES(?,?,?,?,?,?)').run(oid,'tenant_burj','entity_burj',name,'Fig & Pear','dine_in');
    const email=adminEmail||'owner@demo.digitalburj.local';
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,1)').run('user_owner','tenant_burj','Aisha Al Mansoori',email,passwordHash(adminPassword||id('unused')), 'owner',JSON.stringify(['outlet_downtown','outlet_marina']));
    if(!demo){db.exec('COMMIT');return;}
    for(const [role,name] of [['cashier','Sara · Cashier'],['chef','Omar · Kitchen'],['accountant','Leena · Finance'],['storekeeper','Bilal · Store'],['safety','Noor · Safety']])db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,1)').run(`user_${role}`,'tenant_burj',name,`${role}@demo.digitalburj.local`,passwordHash(id()),role,JSON.stringify(['outlet_downtown']));
    const ingredients=[
      ['beef','Beef patty','g',6,1500,[]],['bun','Brioche bun','unit',250,12,['gluten','egg']],['lettuce','Romaine lettuce','g',1,800,[]],['cheese','Cheddar cheese','g',4,500,['milk']],['sauce','House sauce','g',2,600,['egg']],['milk','Fresh milk','ml',1,1000,['milk']],['oat','Oat milk','ml',2,800,['oats']],['beans','Espresso beans','g',10,500,[]],['chicken','Chicken breast','g',3,1500,[]],['rice','Basmati rice','g',1,1200,[]],['box','Takeaway box','unit',80,15,[]],['lemon','Lemon juice','ml',1,500,[]],['tomato','Tomato','g',1,600,[]],['oil','Olive oil','ml',3,500,[]],
    ];
    for(const [key,name,unit,cost,reorder,allergens] of ingredients){
      db.prepare('INSERT INTO ingredients VALUES(?,?,?,?,?,?,?)').run(key,'tenant_burj',name,unit,cost,reorder,JSON.stringify(allergens));
      for(const outlet of ['outlet_downtown','outlet_marina']) {
        const quantity=key==='oat'?650:key==='bun'?36:key==='box'?50:key==='sauce'?1500:8000;
        const lid=`lot_${key}_${outlet}`;
        db.prepare('INSERT INTO lots VALUES(?,?,?,?,?,?,?,?,?,?)').run(lid,'tenant_burj',outlet,key,`DEMO-${key.toUpperCase()}`,new Date(Date.now()+5*86400000).toISOString().slice(0,10),'available',cost,quantity,'opening_count');
        db.prepare('INSERT INTO movements VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id('mov'),'tenant_burj',outlet,key,lid,quantity,'opening','opening_count','user_owner','Synthetic opening stock',now());
      }
    }
    const products=[
      ['burger','The house burger','Signature','برغر البيت',4200,'grill',12,[['beef',180],['bun',1],['lettuce',25],['sauce',30]],[{id:'cheese',name:'Add cheddar',price:500,ingredients:[{ingredientId:'cheese',quantity:25}]},{id:'double',name:'Double patty',price:1400,ingredients:[{ingredientId:'beef',quantity:180}]}],['gluten','egg'],'Flame-grilled beef, house sauce, crisp romaine.'],
      ['bowl','Grilled chicken bowl','Signature','طبق الدجاج',4800,'grill',14,[['chicken',180],['rice',100],['lettuce',40],['sauce',25]],[],['egg'],'A generous grain bowl with grilled chicken.'],
      ['salad','Garden fattoush','Salads','فتوش',3200,'cold',6,[['lettuce',150],['tomato',100],['lemon',25],['oil',15]],[],[],'Fresh garden greens, tomato and lemon dressing.'],
      ['latte','Flat white','Coffee','فلات وايت',2200,'drinks',4,[['beans',18],['milk',180]],[{id:'oat',name:'Oat milk',price:400,replace:'milk',ingredients:[{ingredientId:'oat',quantity:180}]},{id:'shot',name:'Extra shot',price:500,ingredients:[{ingredientId:'beans',quantity:18}]}],['milk'],'A double espresso with velvety steamed milk.'],
      ['espresso','Double espresso','Coffee','إسبريسو',1600,'drinks',3,[['beans',18]],[],[],'House-roasted blend, freshly pulled.'],
      ['lemonade','Mint lemonade','Drinks','ليمون بالنعناع',2000,'drinks',4,[['lemon',80]],[],[],'Bright, freshly squeezed and served cold.'],
    ];
    for(const outlet of ['outlet_downtown','outlet_marina']){
      for(const [key,name,category,arabic,price,station,prep,recipe,modifiers,allergens,description] of products)db.prepare('INSERT INTO menu VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`${key}_${outlet}`,'tenant_burj',outlet,name,arabic,category,price,station,prep,1,1,JSON.stringify(recipe.map(([ingredientId,quantity])=>({ingredientId,quantity}))),JSON.stringify(modifiers),JSON.stringify(allergens),description);
      for(let i=1;i<=8;i++)db.prepare('INSERT INTO dining_tables VALUES(?,?,?,?,?,?)').run(`table_${outlet}_${i}`,'tenant_burj',outlet,`T${String(i).padStart(2,'0')}`,i<5?4:6,i<=4?'Dining room':'Terrace');
    }
    const rec=(module,key,status,data)=>db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?)').run(key,'tenant_burj','entity_burj','outlet_downtown',module,status,JSON.stringify(data),1,now(),now());
    rec('suppliers','supplier_green','approved',{name:'Green Valley Fresh',contact:'Purchasing desk',email:'supply@example.test',terms:'Net 30',leadDays:1,notes:'Synthetic supplier · produce and dairy'});
    rec('suppliers','supplier_prime','approved',{name:'Prime Foods Trading',contact:'Wholesale team',terms:'Net 14',leadDays:2,notes:'Synthetic supplier · proteins and packaging'});
    rec('purchases','purchase_demo','requested',{name:'PO-1042',supplierId:'supplier_green',ingredientId:'oat',quantity:4000,unitCost:2,deliveryDate:businessDate(),received:0,notes:'Replenish oat milk before evening service'});
    rec('staff','staff_omar','active',{name:'Omar Hassan',position:'Head chef',station:'grill',notes:'Synthetic team profile'});
    rec('staff','staff_sara','active',{name:'Sara Ahmed',position:'Floor supervisor',station:'service',notes:'Synthetic team profile'});
    rec('shifts','shift_demo','scheduled',{name:'Evening service',staffId:'staff_omar',startsAt:`${businessDate()}T14:00`,endsAt:`${businessDate()}T22:00`,station:'grill'});
    rec('customers','customer_maya','active',{name:'Maya Thompson',email:'maya@example.test',consent:'granted',notes:'Synthetic customer'});
    rec('customers','customer_ali','active',{name:'Ali Rashid',consent:'not_granted',notes:'Synthetic customer'});
    rec('safety','safety_demo','recorded',{name:'Cold store · opening check',procedure:'DEMO-COLD-01',type:'temperature',reading:'Recorded in training dataset',criterion:'Operator-approved procedure required',result:'deviation',responsible:'Noor',notes:'Training example; review procedure before live operation'});
    rec('incidents','incident_demo','open',{name:'Cold-store procedure review',severity:'medium',affected:'No actual stock affected · demo',responsible:'Noor',notes:'Confirm procedure and instrument record before live operation'});
    rec('catering','catering_demo','quoted',{name:'Design studio lunch',customer:'Studio Nine · synthetic',date:new Date(Date.now()+4*86400000).toISOString().slice(0,10),venue:'Business Bay',guests:45,quoteAmount:315000,deposit:0,resources:'3 staff · chilled transport',notes:'Menu and dietary review pending'});
    rec('contracts','contract_demo','draft',{name:'Corporate lunches',payer:'Example Co.',site:'Business Bay',billingBasis:'accepted_meal',rate:1200,minimum:0,eligible:470,accepted:472,served:465,mealType:'lunch',startDate:businessDate(),endDate:new Date(Date.now()+30*86400000).toISOString().slice(0,10),notes:'Research illustration. Extra meals require approval before period close.'});
    rec('subscriptions','subscription_demo','active',{name:'Nadia · training account',plan:'Weekday lunch',entitlements:20,mealPrice:3500,address:'Downtown · example address',days:'Mon–Fri · 12:00–13:00',cutoff:'Previous day 18:00',used:0,notes:'Funded synthetic entitlement'});
    rec('documents','document_demo','requires_confirmation',{name:'Food establishment procedure register',authority:'Relevant local food authority',jurisdiction:'Dubai',expiry:new Date(Date.now()+30*86400000).toISOString().slice(0,10),responsible:'Safety lead',evidence:'Attach current establishment-specific procedure and review applicability. No compliance claim.'});
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
