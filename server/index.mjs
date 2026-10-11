import {packLine} from './service.mjs';
import { openDatabase } from './db.mjs';
import { seed } from './seed.mjs';
import { createApp } from './app.mjs';
import { createOrder,taskAction,pay,orderAction } from './domain.mjs';
const production=process.env.NODE_ENV==='production';
const demo=!production&&process.env.DEMO_MODE!=='false';
const db=openDatabase();
seed(db,{demo,adminEmail:process.env.ADMIN_EMAIL,adminPassword:process.env.ADMIN_PASSWORD});
if(demo&&!db.prepare('SELECT COUNT(*) n FROM orders').get().n){
  const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);
  const ctx={user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'};
  for(const [index,item,service,customer] of [[1,'burger','dine_in','Table 03'],[2,'latte','takeaway','Maya'],[3,'bowl','delivery','Direct order'],[4,'salad','dine_in','Table 05'],[5,'espresso','takeaway','Walk-in']]){
    const order=createOrder(db,ctx,{service,customer,tableId:service==='dine_in'?`table_outlet_downtown_${index===1?3:5}`:undefined,channel:service==='delivery'?'Direct':'POS',idempotencyKey:`seed-order-${index}`,lines:[{itemId:`${item}_outlet_downtown`,quantity:index===1?2:1,modifierIds:item==='latte'?['oat']:[]}]});
    if(index<=3){taskAction(db,ctx,order.tasks[0].id,{action:'start'});if(index===2)taskAction(db,ctx,order.tasks[0].id,{action:'ready'});}
    if(index===5){taskAction(db,ctx,order.tasks[0].id,{action:'start'});taskAction(db,ctx,order.tasks[0].id,{action:'ready'});pay(db,ctx,order.id,{amount:order.total,method:'cash',idempotencyKey:'seed-payment-5'});for(const line of order.lines)packLine(db,ctx,order.id,{lineId:line.id,quantity:line.quantity,reason:'Synthetic seed packing verification'});orderAction(db,ctx,order.id,{action:'handover'});orderAction(db,ctx,order.id,{action:'complete'});}
  }
}
const app=createApp(db,{demo,production});
const server=app.listen(Number(process.env.PORT||3001),'0.0.0.0',()=>console.log(`Restaurant OS API ready on port ${process.env.PORT||3001}; demo=${demo}`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
