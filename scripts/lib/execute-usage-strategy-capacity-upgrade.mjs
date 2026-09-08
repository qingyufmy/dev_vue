import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { loadUsageStrategyCapacityCoordinator } from './inplace-usage-strategy-capacity-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { modelCapacitySnapshot } from './model-capacity-snapshot.mjs'

const root = new URL('../../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`usage_strategy_${code}`) }
export async function executeUsageStrategyCapacityUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database), 'scope')
  check(!injectAfterDdl || apply && database === 'dev_vue_m1_source_20260907_02', 'fault_scope')
  if (apply && database === 'dev_vue') {
    const bytes = await readFile(new URL('docs/migration/dev-vue-usage-strategy-capacity-rehearsal-20260908.json', root))
    check(sha256(bytes) === 'a7fe0169b463f47b4d23e3bc63e8604b249b3c6b21f2f627c9f7fc7252ce1a2a', 'rehearsal_hash')
    const proof = JSON.parse(bytes)
    check(proof.kind === 'usage-strategy-capacity-upgrade/v1' && proof.schemaSteps === 145 && proof.ddlCount + proof.reconciledAtStart.length === 1
      && proof.repeated && proof.grantsRestored && !proof.currentDevVueWritten && proof.protectedDataSchemaCountersUnchanged
      && proof.identity.db === 'dev_vue_m1_source_20260907_02' && proof.faults.length === 1, 'rehearsal_invalid')
  }
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.sql_mode sql_mode')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  check(identity.sql_mode.split(',').some(value => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(value)), 'strict_mode_required')
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadUsageStrategyCapacityCoordinator(root), additions = plan.transitions.slice(144)
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'journal')
    const store = plan.store(connection), initial = await coordinateInplaceSchema(store, plan)
    check(plan.steps.length === 145 && initial.steps.slice(0, 144).every(row => row.status === 'completed'), 'prerequisites')
    const [[invalid]] = await connection.query('SELECT COUNT(*) count FROM ai_model_usage_logs WHERE strategy_id<0')
    check(Number(invalid.count) === 0, 'negative_strategy')
    const before = await protectedSnapshot(connection, additions)
    const reconciledAtStart = initial.steps.filter(row => row.status === 'reconcile').map(row => row.id)
    const faults = injectAfterDdl ? [...reconciledAtStart] : []
    let ddlCount = 0, result
    const writer = { ...store, async execute(sql) {
      const step = plan.steps.slice(144).find(row => row.sql === sql)
      check(step, 'unexpected_ddl')
      await store.execute(sql); ddlCount++
      if (injectAfterDdl) { faults.push(step.id); throw Error('usage_strategy_injected') }
    } }
    for (let attempt = 0; attempt < 2; attempt++) {
      try { result = await coordinateInplaceSchema(writer, plan, { apply }); break }
      catch (error) {
        if (!injectAfterDdl || error.message !== 'usage_strategy_injected') throw error
        const recovery = await coordinateInplaceSchema(store, plan)
        check(recovery.steps.find(row => row.id === faults.at(-1))?.status === 'reconcile', 'reconcile')
      }
    }
    check(result, 'unfinished')
    if (injectAfterDdl) check(ddlCount + reconciledAtStart.length === 1 && new Set(faults).size === 1, 'faults_missing')
    if (apply) check((await coordinateInplaceSchema(writer, plan, { apply: true })).steps.every(row => row.status === 'completed'), 'repeat')
    const after = await protectedSnapshot(connection, additions)
    check(JSON.stringify(before) === JSON.stringify(after), 'protected_changed')
    return { kind: 'usage-strategy-capacity-upgrade/v1', identity, apply, schemaSteps: plan.steps.length, ddlCount, reconciledAtStart, faults, result,
      protectedTableCount: before.rows.length, protectedRows: before.rows, protectedDataSchemaCountersUnchanged: true,
      numericComparison: 'full_decimal_text_and_null', repeated: apply,
      currentDevVueWritten: apply && database === 'dev_vue', runtimeEnabled: false }
  })
}

async function protectedSnapshot(connection, additions) {
  return modelCapacitySnapshot(connection, additions.map(row => ({ step: { ...row.step, column: 'strategy_id', beforeLine: row.beforeLine, afterLine: row.afterLine }, after: { type: 'bigint unsigned' } })))
}
