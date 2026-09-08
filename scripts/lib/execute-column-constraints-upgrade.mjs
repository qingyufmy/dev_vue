import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { loadColumnConstraintsCoordinator } from './inplace-column-constraints-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { modelCapacitySnapshot } from './model-capacity-snapshot.mjs'

const root = new URL('../../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`column_constraints_${code}`) }
export async function executeColumnConstraintsUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database), 'scope')
  check(!injectAfterDdl || apply && database === 'dev_vue_m1_source_20260907_02', 'fault_scope')
  if (apply && database === 'dev_vue') {
    const bytes = await readFile(new URL('docs/migration/dev-vue-column-constraints-rehearsal-20260908.json', root))
    check(sha256(bytes) === '49020fca6b4c8730222287e90e4ec341340371360d58ada1f396c847c1e6a7f1', 'rehearsal_hash')
    const proof = JSON.parse(bytes)
    check(proof.kind === 'column-constraints-upgrade/v1' && proof.schemaSteps === 114 && proof.ddlCount === 9
      && proof.repeated && proof.grantsRestored && !proof.currentDevVueWritten && proof.protectedDataSchemaCountersUnchanged
      && proof.identity.db === 'dev_vue_m1_source_20260907_02' && proof.faults.length === 9, 'rehearsal_invalid')
  }
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.sql_mode sql_mode')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  check(identity.sql_mode.split(',').some(value => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(value)), 'strict_mode_required')
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadColumnConstraintsCoordinator(root), additions = plan.transitions.slice(105)
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'journal')
    const store = plan.store(connection), initial = await coordinateInplaceSchema(store, plan)
    check(plan.steps.length === 114 && initial.steps.slice(0, 105).every(row => row.status === 'completed'), 'prerequisites')
    for (const { step, after } of additions) {
      const [references] = await connection.execute(`SELECT CONSTRAINT_NAME name FROM information_schema.KEY_COLUMN_USAGE
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME=? AND REFERENCED_COLUMN_NAME=?`, [step.table, step.column])
      check(references.length === 0, 'new_foreign_key')
      if (step.table === 'users' || after.type.includes('unsigned')) {
        const predicate = step.table === 'users' ? `\`${step.column}\` IS NULL` : `\`${step.column}\`<=0`
        const [[row]] = await connection.query(`SELECT COUNT(*) invalid FROM \`${step.table}\` WHERE ${predicate}`)
        check(Number(row.invalid) === 0, 'invalid_existing_value')
      }
    }
    const before = await modelCapacitySnapshot(connection, additions), faults = []
    let ddlCount = 0, result
    const writer = { ...store, async execute(sql) {
      const step = plan.steps.slice(105).find(row => row.sql === sql)
      check(step, 'unexpected_ddl')
      await store.execute(sql); ddlCount++
      if (injectAfterDdl) { faults.push(step.id); throw Error('column_constraints_injected') }
    } }
    for (let attempt = 0; attempt < 10; attempt++) {
      try { result = await coordinateInplaceSchema(writer, plan, { apply }); break }
      catch (error) {
        if (!injectAfterDdl || error.message !== 'column_constraints_injected') throw error
        const recovery = await coordinateInplaceSchema(store, plan)
        check(recovery.steps.find(row => row.id === faults.at(-1))?.status === 'reconcile', 'reconcile')
      }
    }
    check(result, 'unfinished')
    if (injectAfterDdl) check(ddlCount === 9 && new Set(faults).size === 9, 'faults_missing')
    if (apply) check((await coordinateInplaceSchema(writer, plan, { apply: true })).steps.every(row => row.status === 'completed'), 'repeat')
    const after = await modelCapacitySnapshot(connection, additions)
    check(JSON.stringify(before) === JSON.stringify(after), 'protected_changed')
    return { kind: 'column-constraints-upgrade/v1', identity, apply, schemaSteps: plan.steps.length, ddlCount, faults, result,
      protectedTableCount: before.rows.length, protectedRows: before.rows, protectedDataSchemaCountersUnchanged: true,
      numericComparison: 'full_decimal_text_and_null', repeated: apply,
      currentDevVueWritten: apply && database === 'dev_vue', runtimeEnabled: false }
  })
}
