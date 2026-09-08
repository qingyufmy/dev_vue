import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { loadModelCheckCoordinator } from './inplace-model-check-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { modelCapacitySnapshot } from './model-capacity-snapshot.mjs'
import { removeModelCheckDefinition } from './inplace-model-check-schema.mjs'

const root = new URL('../../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`model_check_${code}`) }
export async function executeModelCheckUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database), 'scope')
  check(!injectAfterDdl || apply && database === 'dev_vue_m1_source_20260907_02', 'fault_scope')
  if (apply && database === 'dev_vue') {
    const bytes = await readFile(new URL('docs/migration/dev-vue-model-check-rehearsal-20260908.json', root))
    check(sha256(bytes) === 'cdd34e97278d61567f1354559b7f39c8a03fbdf407a82f2a786a810d92ecd058', 'rehearsal_hash')
    const proof = JSON.parse(bytes)
    check(proof.kind === 'model-check-upgrade/v1' && proof.schemaSteps === 133 && proof.ddlCount === 2
      && proof.repeated && proof.grantsRestored && !proof.currentDevVueWritten && proof.protectedDataSchemaCountersUnchanged
      && proof.identity.db === 'dev_vue_m1_source_20260907_02' && proof.faults.length === 2 && proof.enforcement?.length === 2
      && proof.enforcement.every(code => code === 'ER_CHECK_CONSTRAINT_VIOLATED'), 'rehearsal_invalid')
  }
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.sql_mode sql_mode')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  check(identity.sql_mode.split(',').some(value => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(value)), 'strict_mode_required')
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadModelCheckCoordinator(root), additions = plan.transitions.slice(131)
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'journal')
    const store = plan.store(connection), initial = await coordinateInplaceSchema(store, plan)
    check(plan.steps.length === 133 && initial.steps.slice(0, 131).every(row => row.status === 'completed'), 'prerequisites')
    const [[models]] = await connection.query("SELECT COUNT(*) invalid FROM ai_model_profiles WHERE NOT ((scope='platform' AND owner_user_id=0) OR (scope='user' AND owner_user_id>0))")
    const [[policy]] = await connection.query('SELECT COUNT(*) invalid FROM platform_model_usage_policy WHERE id<>1')
    check(Number(models.invalid) === 0 && Number(policy.invalid) === 0, 'invalid_data')
    const before = await protectedSnapshot(connection, additions), faults = []
    let ddlCount = 0, result
    const writer = { ...store, async execute(sql) {
      const step = plan.steps.slice(131).find(row => row.sql === sql)
      check(step, 'unexpected_ddl')
      await store.execute(sql); ddlCount++
      if (injectAfterDdl) { faults.push(step.id); throw Error('model_check_injected') }
    } }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await coordinateInplaceSchema(writer, plan, { apply }); break }
      catch (error) {
        if (!injectAfterDdl || error.message !== 'model_check_injected') throw error
        const recovery = await coordinateInplaceSchema(store, plan)
        check(recovery.steps.find(row => row.id === faults.at(-1))?.status === 'reconcile', 'reconcile')
      }
    }
    check(result, 'unfinished')
    if (injectAfterDdl) check(ddlCount === 2 && new Set(faults).size === 2, 'faults_missing')
    if (apply) check((await coordinateInplaceSchema(writer, plan, { apply: true })).steps.every(row => row.status === 'completed'), 'repeat')
    const enforcement = []
    if (apply && database === 'dev_vue_m1_source_20260907_02') {
      for (const sql of ["UPDATE ai_model_profiles SET owner_user_id=-1 WHERE id=(SELECT id FROM (SELECT MIN(id) id FROM ai_model_profiles) probe)", 'UPDATE platform_model_usage_policy SET id=2 WHERE id=1']) {
        await connection.beginTransaction()
        let rejected = false
        try { await connection.query(sql) } catch (error) { if (error.code !== 'ER_CHECK_CONSTRAINT_VIOLATED') throw error; rejected = true }
        finally { await connection.rollback() }
        check(rejected, 'enforcement_missing'); enforcement.push('ER_CHECK_CONSTRAINT_VIOLATED')
      }
    }
    const after = await protectedSnapshot(connection, additions)
    check(JSON.stringify(before) === JSON.stringify(after), 'protected_changed')
    return { kind: 'model-check-upgrade/v1', identity, apply, schemaSteps: plan.steps.length, ddlCount, faults, result, enforcement,
      protectedTableCount: before.rows.length, protectedRows: before.rows, protectedDataSchemaCountersUnchanged: true,
      numericComparison: 'full_decimal_text_and_null', repeated: apply,
      currentDevVueWritten: apply && database === 'dev_vue', runtimeEnabled: false }
  })
}

async function protectedSnapshot(connection, additions) {
  const snapshot = await modelCapacitySnapshot(connection, [])
  for (const row of snapshot.definitions) {
    const transition = additions.find(item => item.step.table === row.name)
    if (transition) row.ddl = removeModelCheckDefinition(row.ddl, transition)
  }
  return snapshot
}
