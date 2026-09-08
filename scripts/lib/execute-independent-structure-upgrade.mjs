import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { loadIndependentStructureCoordinator } from './inplace-independent-structure-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { independentProtectedSnapshot } from './independent-structure-snapshot.mjs'

const root = new URL('../../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`independent_structure_${code}`) }
export async function executeIndependentStructureUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database), 'scope')
  check(!injectAfterDdl || apply && database === 'dev_vue_m1_source_20260907_02', 'fault_scope')
  if (apply && database === 'dev_vue') {
    const proof = JSON.parse(await readFile(new URL('docs/migration/dev-vue-independent-structure-rehearsal-20260908.json', root), 'utf8'))
    const expected = 'c5ec13f8c4d297d060080ca0e58264e1870a399796cf86ad51d5f465fab913f7'
    const bytes = await readFile(new URL('docs/migration/dev-vue-independent-structure-rehearsal-20260908.json', root))
    check(/^[0-9a-f]{64}$/.test(expected) && sha256(bytes) === expected, 'rehearsal_hash')
    check(proof.kind === 'independent-structure-upgrade/v1' && proof.schemaSteps === 75 && proof.ddlCount === 11
      && proof.repeated && proof.grantsRestored && !proof.currentDevVueWritten && proof.protectedDataSchemaCountersUnchanged
      && proof.identity.db === 'dev_vue_m1_source_20260907_02' && proof.faults.length === 11, 'rehearsal_invalid')
  }
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadIndependentStructureCoordinator(root)
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'journal')
    const store = plan.store(connection), initial = await coordinateInplaceSchema(store, plan)
    check(plan.steps.length === 75 && initial.steps.slice(0, 64).every(row => row.status === 'completed'), 'prerequisites')
    const before = await independentProtectedSnapshot(connection), faults = []
    let ddlCount = 0, result
    const writer = { ...store, async execute(sql) {
      const step = plan.steps.slice(64).find(row => row.sql === sql)
      check(step, 'unexpected_ddl')
      await store.execute(sql); ddlCount++
      if (injectAfterDdl) { faults.push(step.id); throw Error('independent_structure_injected') }
    } }
    for (let attempt = 0; attempt < 12; attempt++) {
      try { result = await coordinateInplaceSchema(writer, plan, { apply }); break }
      catch (error) {
        if (!injectAfterDdl || error.message !== 'independent_structure_injected') throw error
        const recovery = await coordinateInplaceSchema(store, plan)
        check(recovery.steps.find(row => row.id === faults.at(-1))?.status === 'reconcile', 'reconcile')
      }
    }
    check(result, 'unfinished')
    if (injectAfterDdl) check(ddlCount === 11 && new Set(faults).size === 11, 'faults_missing')
    if (apply) {
      const repeated = await coordinateInplaceSchema(writer, plan, { apply: true })
      check(repeated.steps.every(row => row.status === 'completed'), 'repeat')
    }
    const after = await independentProtectedSnapshot(connection)
    check(JSON.stringify(before) === JSON.stringify(after), 'protected_changed')
    return { kind: 'independent-structure-upgrade/v1', identity, apply, schemaSteps: plan.steps.length,
      ddlCount, faults, result, protectedTableCount: before.rows.length, protectedRows: before.rows,
      protectedDataSchemaCountersUnchanged: true, repeated: apply,
      currentDevVueWritten: apply && database === 'dev_vue', seedsApplied: false, runtimeEnabled: false }
  })
}
