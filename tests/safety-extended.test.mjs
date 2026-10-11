import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,businessDate,now,id } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createRecord,holdLot } from '../server/domain.mjs';
import { recallReview,recallReviews,notificationProviders,registerNotificationAdapter,selectNotificationProvider,notificationConfig,queueNotification,notificationOutbox,dispatchNotifications,linkScanEater,bulkIdentityReport } from '../server/safety-ext.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};
const contractBase=()=>({name:'Site meal contract',payer:'Example Co.',site:'Business Bay',billingBasis:'accepted_meal',rate:1200,minimum:0,eligible:100,accepted:100,served:0,mealType:'lunch',startDate:businessDate(),endDate:'2099-01-01',notes:'Client approved terms'});

test('CORE-08 a recall review requires every affected lot to be held before it closes',()=>{
  const {db,ctx}=fixture();
  assert.throws(()=>recallReview(db,ctx,'lot_milk_outlet_downtown',{evidence:'Nothing held'}),/Hold every affected lot/);
  holdLot(db,ctx,'lot_oat_outlet_downtown',{status:'quarantined',reason:'Supplier recall notice',recall:true});
  const review=recallReview(db,ctx,'lot_oat_outlet_downtown',{evidence:'Supplier notice 2026-01 verifies the affected consignment'});
  assert.ok(review.reviewId);assert.ok(review.affectedLots>=1);
  const listed=recallReviews(db,ctx);
  assert.equal(listed.length,1);assert.equal(listed[0].data.evidence.includes('consignment'),true);
  db.close();
});

test('CORE-08 recall notices queue only after a validated provider is selected, then dispatch',()=>{
  const {db,ctx}=fixture();
  assert.equal(notificationProviders().length,3);
  const disabled=selectNotificationProvider(db,ctx,{providerId:'sms_gateway',evidence:'Provider contract pending'});
  assert.equal(disabled.enabled,false);
  assert.throws(()=>dispatchNotifications(db,ctx,{}),/Select a validated notification provider/);
  registerNotificationAdapter('sms_gateway',{send:({recipient})=>({reference:`SMS:${recipient}`})});
  const enabled=selectNotificationProvider(db,ctx,{providerId:'sms_gateway',evidence:'Provider contract signed'});
  assert.equal(enabled.enabled,true);assert.equal(notificationConfig(db,ctx).providerId,'sms_gateway');
  queueNotification(db,ctx,{kind:'recall_notice',recipient:'+971500000001',body:'Recalled product notice',idempotencyKey:'notify-key-1'});
  const result=dispatchNotifications(db,ctx,{});
  assert.deepEqual({attempted:result.attempted,sent:result.sent,failed:result.failed},{attempted:1,sent:1,failed:0});
  assert.equal(notificationOutbox(db,ctx).items[0].status,'sent');
  db.close();
});

test('CORE-08 bulk-service identity links a scan to a person and reports group counts separately',()=>{
  const {db,ctx}=fixture();
  const contract=createRecord(db,ctx,'contracts',contractBase());
  const eater=createRecord(db,ctx,'eaters',{name:'Hassan',contractId:contract.id,externalRef:'BADGE-9',entitlement:20,site:'Business Bay',notes:'x'});
  const scanId=id('scan');
  db.prepare('INSERT INTO serving_scans VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(scanId,ctx.tenantId,ctx.outletId,'SCAN-1',contract.id,businessDate(),'lunch',1,'individual_scan',now(),'recorded',null);
  const link=linkScanEater(db,ctx,{scanId,eaterId:eater.id});
  assert.equal(link.eater_id,eater.id);
  const report=bulkIdentityReport(db,ctx,contract.id,businessDate());
  assert.equal(report.individual,1);assert.equal(report.identified,1);assert.equal(report.unidentified,0);
  const other=createRecord(db,ctx,'eaters',{name:'Sara',contractId:contract.id,externalRef:'BADGE-10',entitlement:20,site:'Business Bay',notes:'y'});
  assert.throws(()=>linkScanEater(db,ctx,{scanId,eaterId:other.id}),/already linked/);
  db.close();
});
