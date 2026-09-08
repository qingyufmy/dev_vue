import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { loadRuntimeIndexCoordinator } from './inplace-runtime-index-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { modelCapacitySnapshot } from './model-capacity-snapshot.mjs'
import { removeRuntimeIndexDefinitions } from './inplace-runtime-index-schema.mjs'

const root = new URL('../../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`runtime_index_${code}`) }
export async function executeRuntimeIndexUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database), 'scope')
  check(!injectAfterDdl || apply && database === 'dev_vue_m1_source_20260907_02', 'fault_scope')
  if (apply && database === 'dev_vue') {
    const bytes = await readFile(new URL('docs/migration/dev-vue-runtime-index-rehearsal-20260908.json', root))
    check(sha256(bytes) === '9d0c62f17be4c1452100d87f943c1e3fc45eed690345f92a51162f25ebf60d64', 'rehearsal_hash')
    const proof = JSON.parse(bytes)
    check(proof.kind === 'runtime-index-upgrade/v1' && proof.schemaSteps === 139 && proof.ddlCount + proof.reconciledAtStart.length === 6
      && proof.repeated && proof.grantsRestored && !proof.currentDevVueWritten && proof.protectedDataSchemaCountersUnchanged
      && proof.identity.db === 'dev_vue_m1_source_20260907_02' && proof.faults.length === 6, 'rehearsal_invalid')
  }
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.sql_mode sql_mode')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  check(identity.sql_mode.split(',').some(value => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(value)), 'strict_mode_required')
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadRuntimeIndexCoordinator(root), additions = plan.transitions.slice(133)
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'journal')
    const store = plan.store(connection), initial = await coordinateInplaceSchema(store, plan)
    check(plan.steps.length === 139 && initial.steps.slice(0, 133).every(row => row.status === 'completed'), 'prerequisites')
    for (const column of ['migration_key', 'source_refresh_session_id']) {
      const [[row]] = await connection.query('SELECT COUNT(*) invalid FROM (SELECT \x60' + column + '\x60 FROM bridge_refresh_sessions WHERE \x60' + column + '\x60 IS NOT NULL GROUP BY \x60' + column + '\x60 HAVING COUNT(*)>1) d')
      check(Number(row.invalid) === 0, 'duplicate_key')
    }
    const before = await protectedSnapshot(connection, additions)
    const reconciledAtStart = initial.steps.filter(row => row.status === 'reconcile').map(row => row.id)
    const faults = injectAfterDdl ? [...reconciledAtStart] : []
    let ddlCount = 0, result
    const writer = { ...store, async execute(sql) {
      const step = plan.steps.slice(133).find(row => row.sql === sql)
      check(step, 'unexpected_ddl')
      await store.execute(sql); ddlCount++
      if (injectAfterDdl) { faults.push(step.id); throw Error('runtime_index_injected') }
    } }
    for (let attempt = 0; attempt < 7; attempt++) {
      try { result = await coordinateInplaceSchema(writer, plan, { apply }); break }
      catch (error) {
        if (!injectAfterDdl || error.message !== 'runtime_index_injected') throw error
        const recovery = await coordinateInplaceSchema(store, plan)
        check(recovery.steps.find(row => row.id === faults.at(-1))?.status === 'reconcile', 'reconcile')
      }
    }
    check(result, 'unfinished')
    if (injectAfterDdl) check(ddlCount + reconciledAtStart.length === 6 && new Set(faults).size === 6, 'faults_missing')
    if (apply) check((await coordinateInplaceSchema(writer, plan, { apply: true })).steps.every(row => row.status === 'completed'), 'repeat')
    const after = await protectedSnapshot(connection, additions)
    check(JSON.stringify(before) === JSON.stringify(after), 'protected_changed')
    return { kind: 'runtime-index-upgrade/v1', identity, apply, schemaSteps: plan.steps.length, ddlCount, reconciledAtStart, faults, result,
      protectedTableCount: before.rows.length, protectedRows: before.rows, protectedDataSchemaCountersUnchanged: true,
      numericComparison: 'full_decimal_text_and_null', repeated: apply,
      currentDevVueWritten: apply && database === 'dev_vue', runtimeEnabled: false }
  })
}

async function protectedSnapshot(connection, additions) {
  const snapshot = await modelCapacitySnapshot(connection, [])
  for (const row of snapshot.definitions) {
    row.ddl = removeRuntimeIndexDefinitions(row.name, row.ddl, additions)
  }
  return snapshot
}
