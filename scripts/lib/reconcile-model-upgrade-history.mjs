import { inspectRecentUpgrades } from './recent-upgrade-inspection.mjs'
const ids = ['inplace_082_01_model_configuration_receipts','inplace_083_01_model_assignments']
const require = (condition, code) => { if (!condition) throw new Error(code) }

// Register verified existing objects only. Never executes migration DDL or modifies old receipts.
export async function reconcileModelUpgradeHistory(db, sources, options, evidence, inspect = inspectRecentUpgrades) {
  require(options.database && options.serverUuid, 'reconciliation_identity_required')
  let locked = false, transaction = false, committing = false
  const lock = `aurum:inplace:${options.database}`
  try {
    const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid')
    require(identity.db === options.database && identity.uuid === options.serverUuid, 'reconciliation_wrong_target')
    const [[acquired]] = await db.execute('SELECT GET_LOCK(?,0) acquired',[lock])
    require(Number(acquired.acquired) === 1, 'reconciliation_lock_busy'); locked = true
    await db.query("SET SESSION time_zone='+00:00'")
    await db.beginTransaction(); transaction = true
    // Hold metadata locks until commit so concurrent ALTER cannot change verified tables.
    for (const table of ['market_source_selections','model_configuration_receipts_v4','user_model_assignments_v4']) {
      await db.query(`SELECT 1 FROM ${table} LIMIT 0`)
    }
    const before = await inspect(db,sources)
    require(before.identity.db === options.database && before.identity.uuid === options.serverUuid && before.journal === 'available','reconciliation_journal_required')
    require(before.steps.length === 3 && before.steps[0].id === 'inplace_081_01_market_source_selections' && before.steps[0].status === 'completed','reconciliation_prior_incomplete')
    const targets = before.steps.filter(s=>ids.includes(s.id))
    require(targets.length === 2 && new Set(targets.map(s=>s.id)).size === 2,'reconciliation_targets_invalid')
    require(targets.every(s=>['completed','reconciliation_required'].includes(s.status)),'reconciliation_inspection_conflict')
    const missing=targets.filter(s=>s.status==='reconciliation_required')
    if (!missing.length) { await db.rollback(); transaction=false; return {status:'already_registered',writes:false,identity:before.identity} }
    const receipt = {kind:'observed_schema_registration',originalExecutionTimeKnown:false,verifiedAt:new Date().toISOString(),identity:before.identity,steps:missing}
    // Durable local evidence must exist before the first ledger write.
    await evidence('prepared',receipt)
    for (const step of missing) {
      const [result] = await db.execute("INSERT INTO database_upgrade_steps_v4 (id,checksum_sha256,status,started_at_utc,completed_at_utc) VALUES (?,?,'completed',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",[step.id,step.checksum])
      require(result.affectedRows===1,'reconciliation_insert_failed')
    }
    committing=true; await db.commit(); transaction=false
    await evidence('committed',{...receipt,registeredAt:new Date().toISOString()})
    return {status:'registered',writes:true,registered:missing.map(s=>s.id),identity:before.identity}
  } catch(error) {
    if(transaction) await db.rollback().catch(()=>{})
    // A commit/network or receipt-write error is uncertain: inspect before any retry.
    if(committing) throw new Error('reconciliation_outcome_requires_inspection')
    throw error
  } finally {
    if(locked) await db.execute('SELECT RELEASE_LOCK(?)',[lock])
  }
}
