import assert from 'node:assert/strict'
import {loadQuoteProvenanceUpgrade,coordinateQuoteProvenanceUpgrade} from './quote-provenance-upgrade.mjs'
import {mysqlColumnStore,verifyInplaceJournal} from './mysql-inplace-column-store.mjs'
import {tableDefinitionHash} from './inplace-foundation-upgrade.mjs'

export async function verifyQuoteUpgradeCoordinator(db) {
  const plan=await loadQuoteProvenanceUpgrade(new URL('../../',import.meta.url)),[[identity]]=await db.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.match(identity.db,/^dev_vue_quote_ref_[a-f0-9]{32}$/);assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104')
  const lock='aurum:inplace:'+identity.db,[[claim]]=await db.execute('SELECT GET_LOCK(?,0) acquired',[lock]);assert.equal(Number(claim.acquired),1)
  try {
    await db.query(`CREATE TABLE database_upgrade_steps_v4 (
      id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      status ENUM('started','completed') NOT NULL,started_at_utc DATETIME(3) NOT NULL,completed_at_utc DATETIME(3) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    // These are explicit prior-history fixtures, not a claim that this small reference DB contains the full old schema.
    for(const step of plan.prior.steps)await db.execute("INSERT INTO database_upgrade_steps_v4 VALUES (?,?,'completed','2026-09-10 10:00:00.000','2026-09-10 10:00:00.000')",[step.id,step.checksum])
    const journal=mysqlColumnStore(db,true);assert.equal(await verifyInplaceJournal(db),true)
    const beforeHistory=await journal.history(),snapshot=async()=>JSON.stringify((await db.query('SELECT * FROM trading_projection_provenance_v4 ORDER BY resource_kind,resource_id'))[0]),before=await snapshot()
    let stage='begin',ddlCount=0
    const store={
      async verifyPlan(input){assert.equal(input.step.checksum,plan.step.checksum);const [[held]]=await db.execute('SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() currentId',[lock]);assert.equal(String(held.owner),String(held.currentId))},
      async verifyPrior(history){assert.deepEqual(history,beforeHistory)},async verifyProtected(){assert.equal(await snapshot(),before)},
      history:()=>journal.history(),async tableHash(table){assert.equal(table,plan.step.table);return tableDefinitionHash((await db.query('SHOW CREATE TABLE trading_projection_provenance_v4'))[0][0]['Create Table'])},
      async begin(step){await journal.begin(step);if(stage==='begin')throw Error('injected_begin_ack_loss')},
      async execute(sql){await db.query(sql);ddlCount++;if(stage==='ddl')throw Error('injected_ddl_ack_loss')},
      async complete(step){await journal.complete(step);if(stage==='complete')throw Error('injected_complete_ack_loss')},
    }
    const inspect=async()=> (await coordinateQuoteProvenanceUpgrade(store,plan)).steps[0].status
    assert.equal(await inspect(),'pending');assert.equal(ddlCount,0)
    await assert.rejects(()=>coordinateQuoteProvenanceUpgrade(store,plan,{apply:true}),/injected_begin_ack_loss/);assert.equal(await inspect(),'pending')
    stage='ddl';await assert.rejects(()=>coordinateQuoteProvenanceUpgrade(store,plan,{apply:true}),/injected_ddl_ack_loss/);assert.equal(await inspect(),'reconcile');assert.equal(ddlCount,1)
    stage='complete';await assert.rejects(()=>coordinateQuoteProvenanceUpgrade(store,plan,{apply:true}),/injected_complete_ack_loss/);assert.equal(await inspect(),'completed')
    stage='replay';await coordinateQuoteProvenanceUpgrade(store,plan,{apply:true});assert.equal(ddlCount,1);assert.equal((await journal.history()).length,205)
    assert.equal(await snapshot(),before)
    return {passed:true,ddlCount,completedSteps:205,priorHistory:'synthetic-reviewed-204-step-fixture',existingRowsPreserved:true,
      checks:['durable-start-ack-loss-pending','durable-DDL-ack-loss-reconciled-without-realter','durable-completion-ack-loss-replay','actual-upgrade-lock-and-protected-existing-rows']}
  } finally {
    const [[release]]=await db.execute('SELECT RELEASE_LOCK(?) released',[lock]);assert.equal(Number(release.released),1)
  }
}
