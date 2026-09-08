import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { loadDefaultNormalizationCoordinator } from './inplace-default-normalization-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { modelCapacitySnapshot } from './model-capacity-snapshot.mjs'

const root = new URL('../../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`default_normalization_${code}`) }
export async function executeDefaultNormalizationUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database), 'scope')
  check(!injectAfterDdl || apply && database === 'dev_vue_m1_source_20260907_02', 'fault_scope')
  if (apply && database === 'dev_vue') {
    const bytes = await readFile(new URL('docs/migration/dev-vue-default-normalization-rehearsal-20260908.json', root))
    check(sha256(bytes) === 'ed7c27cde8729884587479e8fac2a749b3f9509cdc48aefdc8ee5f4d3852ff04', 'rehearsal_hash')
    const proof = JSON.parse(bytes)
    check(proof.kind === 'default-normalization-upgrade/v1' && proof.schemaSteps === 131 && proof.ddlCount === 17
      && proof.repeated && proof.grantsRestored && !proof.currentDevVueWritten && proof.protectedDataSchemaCountersUnchanged
      && proof.identity.db === 'dev_vue_m1_source_20260907_02' && proof.faults.length === 17, 'rehearsal_invalid')
  }
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.sql_mode sql_mode')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  check(identity.sql_mode.split(',').some(value => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(value)), 'strict_mode_required')
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadDefaultNormalizationCoordinator(root), additions = plan.transitions.slice(114)
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'journal')
    const store = plan.store(connection), initial = await coordinateInplaceSchema(store, plan)
    check(plan.steps.length === 131 && initial.steps.slice(0, 114).every(row => row.status === 'completed'), 'prerequisites')
    const [[tokens]] = await connection.query("SELECT COUNT(*) invalid FROM bridge_refresh_sessions WHERE CHAR_LENGTH(token_hash)<>64 OR REGEXP_LIKE(token_hash,'[^0-9a-f]','c')")
    check(Number(tokens.invalid) === 0, 'token_hash_format')
    const before = await modelCapacitySnapshot(connection, additions), faults = []
    let ddlCount = 0, result
    const writer = { ...store, async execute(sql) {
      const step = plan.steps.slice(114).find(row => row.sql === sql)
      check(step, 'unexpected_ddl')
      await store.execute(sql); ddlCount++
      if (injectAfterDdl) { faults.push(step.id); throw Error('default_normalization_injected') }
    } }
    for (let attempt = 0; attempt < 18; attempt++) {
      try { result = await coordinateInplaceSchema(writer, plan, { apply }); break }
      catch (error) {
        if (!injectAfterDdl || error.message !== 'default_normalization_injected') throw error
        const recovery = await coordinateInplaceSchema(store, plan)
        check(recovery.steps.find(row => row.id === faults.at(-1))?.status === 'reconcile', 'reconcile')
      }
    }
    check(result, 'unfinished')
    if (injectAfterDdl) check(ddlCount === 17 && new Set(faults).size === 17, 'faults_missing')
    if (apply) check((await coordinateInplaceSchema(writer, plan, { apply: true })).steps.every(row => row.status === 'completed'), 'repeat')
    const after = await modelCapacitySnapshot(connection, additions)
    check(JSON.stringify(before) === JSON.stringify(after), 'protected_changed')
    return { kind: 'default-normalization-upgrade/v1', identity, apply, schemaSteps: plan.steps.length, ddlCount, faults, result,
      protectedTableCount: before.rows.length, protectedRows: before.rows, protectedDataSchemaCountersUnchanged: true,
      numericComparison: 'full_decimal_text_and_null', repeated: apply,
      currentDevVueWritten: apply && database === 'dev_vue', runtimeEnabled: false }
  })
}
