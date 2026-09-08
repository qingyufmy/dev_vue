import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { loadTemporalPrecisionCoordinator } from './inplace-temporal-precision-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { temporalPrecisionSnapshot } from './temporal-precision-snapshot.mjs'

const root = new URL('../../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`temporal_precision_${code}`) }
export async function executeTemporalPrecisionUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database), 'scope')
  check(!injectAfterDdl || apply && database === 'dev_vue_m1_source_20260907_02', 'fault_scope')
  if (apply && database === 'dev_vue') {
    const bytes = await readFile(new URL('docs/migration/dev-vue-temporal-precision-rehearsal-20260908.json', root))
    check(sha256(bytes) === '31cba930287c084c1337ca6dc643e023d9dfbea7873cea1697c8ca564c14a037', 'rehearsal_hash')
    const proof = JSON.parse(bytes)
    check(proof.kind === 'temporal-precision-upgrade/v1' && proof.schemaSteps === 91 && proof.ddlCount === 16
      && proof.repeated && proof.grantsRestored && !proof.currentDevVueWritten && proof.protectedDataSchemaCountersUnchanged
      && proof.identity.db === 'dev_vue_m1_source_20260907_02' && proof.faults.length === 16, 'rehearsal_invalid')
  }
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadTemporalPrecisionCoordinator(root), additions = plan.transitions.slice(75)
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'journal')
    const store = plan.store(connection), initial = await coordinateInplaceSchema(store, plan)
    check(plan.steps.length === 91 && initial.steps.slice(0, 75).every(row => row.status === 'completed'), 'prerequisites')
    for (const { step } of additions) {
      const [[row]] = await connection.query(`SELECT COUNT(*) invalid FROM \`${step.table}\` WHERE \`${step.column}\` IS NOT NULL
        AND (YEAR(\`${step.column}\`)=0 OR MONTH(\`${step.column}\`)=0 OR DAYOFMONTH(\`${step.column}\`)=0)`)
      check(Number(row.invalid) === 0, 'incomplete_date')
    }
    const before = await temporalPrecisionSnapshot(connection, additions), faults = []
    let ddlCount = 0, result
    const writer = { ...store, async execute(sql) {
      const step = plan.steps.slice(75).find(row => row.sql === sql)
      check(step, 'unexpected_ddl')
      await store.execute(sql); ddlCount++
      if (injectAfterDdl) { faults.push(step.id); throw Error('temporal_precision_injected') }
    } }
    const startedAt = Date.now()
    for (let attempt = 0; attempt < 17; attempt++) {
      try { result = await coordinateInplaceSchema(writer, plan, { apply }); break }
      catch (error) {
        if (!injectAfterDdl || error.message !== 'temporal_precision_injected') throw error
        const recovery = await coordinateInplaceSchema(store, plan)
        check(recovery.steps.find(row => row.id === faults.at(-1))?.status === 'reconcile', 'reconcile')
      }
    }
    check(result, 'unfinished')
    if (injectAfterDdl) check(ddlCount === 16 && new Set(faults).size === 16, 'faults_missing')
    if (apply) check((await coordinateInplaceSchema(writer, plan, { apply: true })).steps.every(row => row.status === 'completed'), 'repeat')
    const after = await temporalPrecisionSnapshot(connection, additions)
    check(JSON.stringify(before) === JSON.stringify(after), 'protected_changed')
    return { kind: 'temporal-precision-upgrade/v1', identity, apply, schemaSteps: plan.steps.length, ddlCount, faults,
      result, elapsedExecutionAndVerificationMs: Date.now() - startedAt,
      protectedTableCount: before.rows.length, protectedRows: before.rows, protectedDataSchemaCountersUnchanged: true,
      canonicalTimes: 'six_fractional_digits_including_null_no_offset_change', repeated: apply,
      currentDevVueWritten: apply && database === 'dev_vue', runtimeEnabled: false }
  })
}
