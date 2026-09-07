import { loadLearningCompletionCoordinator } from './inplace-learning-completion-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { verifyInplaceJournal, withInplaceUpgradeLock } from './mysql-inplace-column-store.mjs'
import { readOriginalRows } from './inplace-column-evidence.mjs'
import { columnMatches } from './dev-vue-column-upgrade.mjs'
import { recoveryLearningDefinitionHash } from './learning-completion-recovery-rendering.mjs'
import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'

const root = new URL('../../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`learning_completion_upgrade_${code}`) }
export async function executeLearningCompletionUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database), 'scope')
  check(!injectAfterDdl || apply && database === 'dev_vue_m1_source_20260907_02', 'fault_scope')
  if (apply && database === 'dev_vue') {
    const bytes = await readFile(new URL('docs/migration/dev-vue-learning-completion-upgrade-rehearsal-20260907.json', root))
    check(sha256(bytes) === '484f991e686ac6e3edc323b28cfc9fc6c2fc03ddedf73a246d4887eb6f10342f', 'rehearsal_hash')
    const proof = JSON.parse(bytes)
    check(proof.kind === 'learning-completion-upgrade/v1' && proof.schemaSteps === 64 && proof.ddlCount === 2
      && proof.repeated && proof.grantsRestored && proof.currentDevVueWritten === false
      && proof.originalAndMigratedRowsVerified && proof.originalSchemaAndCountersVerified
      && proof.identity.db === 'dev_vue_m1_source_20260907_02' && proof.faults.length === 2, 'rehearsal_invalid')
  }
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadLearningCompletionCoordinator(root)
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'journal')
    const baseStore = plan.store(connection)
    const store = { ...baseStore, async tableHash(name) {
      const hash = await baseStore.tableHash(name)
      if (database !== 'dev_vue_m1_source_20260907_02' || !['learning_courses','learning_lessons','learning_media_references','learning_progress'].includes(name)) return hash
      const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
      return recoveryLearningDefinitionHash(database, name, row['Create Table'])
    } }
    let planned
    try { planned = await coordinateInplaceSchema(store, plan) }
    catch (error) {
      if (error.message === 'inplace_coordinator_schema_conflict') {
        const completed = new Set((await store.history()).filter(row => row.status === 'completed').map(row => row.id))
        const expected = new Map()
        for (const { step, key, before, after } of plan.transitions) {
          if (!expected.has(key)) expected.set(key, { step, value: before })
          if (completed.has(step.id)) expected.set(key, { step, value: after })
        }
        const conflicts = []
        for (const [key, { step, value }] of expected) {
          const actual = step.column ? await store.column(step.table, step.column) : await store.tableHash(step.table)
          if (!(step.column && value !== null ? columnMatches(actual, value) : actual === value)) conflicts.push({ key, expected: value, actual })
        }
        error.schemaConflicts = conflicts
      }
      throw error
    }
    check(plan.steps.length === 64 && planned.steps.slice(0, -2).every(row => row.status === 'completed'), 'prerequisites')
    // Freeze current original and migrated rows alike; the upgrade only adds an audit table.
    const snapshot = async () => {
      const [objects] = await connection.query('SELECT TABLE_NAME name,TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
      const definitions = [], tables = []
      for (const object of objects) {
        if (['database_upgrade_steps_v4', 'learning_progress_changes'].includes(object.name)) continue
        check(object.type === 'BASE TABLE' && /^[a-z][a-z0-9_]*$/.test(object.name), 'object')
        const name = object.name
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
        definitions.push({ name, ddl: row['Create Table'] })
        const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name])
        const [keys] = await connection.execute("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [name])
        check(keys.length > 0, 'primary_required')
        tables.push({ name, columns: columns.map(row => row.name), primary: keys.map(row => row.name) })
      }
      return { definitions, rows: await readOriginalRows(connection, tables) }
    }
    const before = await snapshot(), faults = []
    let ddlCount = 0, result
    const wrapped = { ...store, execute: async sql => {
      const step = plan.steps.slice(-2).find(step => step.sql === sql)
      check(step, 'unexpected_ddl')
      await store.execute(sql); ddlCount++
      if (injectAfterDdl) { faults.push(step.id); throw Error('learning_completion_upgrade_injected') }
    } }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await coordinateInplaceSchema(wrapped, plan, { apply }); break }
      catch (error) {
        if (!injectAfterDdl || error.message !== 'learning_completion_upgrade_injected') throw error
        const recovery = await coordinateInplaceSchema(store, plan)
        check(recovery.steps.find(row => row.id === faults.at(-1))?.status === 'reconcile', 'recovery_state')
      }
    }
    check(result, 'unfinished')
    if (injectAfterDdl) check(ddlCount === 2 && new Set(faults).size === 2, 'fault_not_exercised')
    if (apply) {
      const repeated = await coordinateInplaceSchema(wrapped, plan, { apply: true })
      check(repeated.steps.every(row => row.status === 'completed'), 'repeat')
    }
    const after = await snapshot()
    check(JSON.stringify(before) === JSON.stringify(after), 'protected_data_changed')
    return { kind: 'learning-completion-upgrade/v1', identity, apply, schemaSteps: plan.steps.length, ddlCount, faults,
      result, protectedTableCount: before.rows.length, protectedRows: before.rows, originalAndMigratedRowsVerified: true,
      originalSchemaAndCountersVerified: true, repeated: apply, currentDevVueWritten: apply && database === 'dev_vue',
      businessWriteEntrypointEnabled: false }
  })
}
