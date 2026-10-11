import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { seed } from '../server/seed.mjs';
import { ensureOrganisation } from '../server/organisation.mjs';
import { createRecord,recordAction } from '../server/domain.mjs';
import { sendCampaign,messageReport } from '../server/customers-ext.mjs';
const fixture=()=>{const db=openDatabase(':memory:');seed(db);ensureOrganisation(db);const user=db.prepare("SELECT * FROM users WHERE id='user_owner'").get();user.outlet_ids=JSON.parse(user.outlet_ids);return {db,ctx:{user,tenantId:'tenant_burj',entityId:'entity_burj',outletId:'outlet_downtown'}};};

test('CORE-14 campaign messaging sends only to consented customers and blocks the rest',()=>{
  const {db,ctx}=fixture();
  const campaign=createRecord(db,ctx,'campaigns',{name:'Winter menu',audience:'All active diners',budget:50000,message:'Try our winter specials'});
  assert.throws(()=>sendCampaign(db,ctx,campaign.id,{channel:'email_relay',evidence:'Before approval',idempotencyKey:'camp-key-1'}),/Approve the campaign/);
  recordAction(db,ctx,campaign.id,{action:'approved',version:campaign.version,reason:'Owner approved the campaign'});
  const result=sendCampaign(db,ctx,campaign.id,{channel:'email_relay',evidence:'Campaign approved by owner',idempotencyKey:'camp-key-1'});
  assert.equal(result.audience,2);assert.equal(result.sent,1);assert.equal(result.blocked,1);
  const report=messageReport(db,ctx);
  assert.equal(report.messages.length,2);
  assert.equal(report.counts.queued,1);assert.equal(report.counts.blocked,1);
  const blocked=report.messages.find(m=>m.status==='blocked');
  assert.equal(blocked.reason,'No marketing consent');assert.equal(blocked.customer_id,'customer_ali');
  const again=sendCampaign(db,ctx,campaign.id,{channel:'email_relay',evidence:'Campaign approved by owner',idempotencyKey:'camp-key-1'});
  assert.equal(again.sent,0);assert.equal(again.blocked,0);assert.equal(messageReport(db,ctx).messages.length,2);
  db.close();
});
