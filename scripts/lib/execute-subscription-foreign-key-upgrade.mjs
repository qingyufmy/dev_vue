import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { loadSubscriptionForeignKeyCoordinator } from './inplace-subscription-foreign-key-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { modelCapacitySnapshot } from './model-capacity-snapshot.mjs'
import { removeSubscriptionForeignKeyDefinitions, subscriptionForeignKeys } from './inplace-subscription-foreign-key-schema.mjs'

const root = new URL('../../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`subscription_fk_${code}`) }
export async function executeSubscriptionForeignKeyUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database), 'scope')
  check(!injectAfterDdl || apply && database === 'dev_vue_m1_source_20260907_02', 'fault_scope')
  if (apply && database === 'dev_vue') {
    const bytes = await readFile(new URL('docs/migration/dev-vue-subscription-foreign-key-rehearsal-20260908.json', root))
    check(sha256(bytes) === 'bc20a31386ff4984d2db02b6a83ef2d28043fa6b600a37288bdc489d28f5f575', 'rehearsal_hash')
    const proof = JSON.parse(bytes)
    check(proof.kind === 'subscription-foreign-key-upgrade/v1' && proof.schemaSteps === 147 && proof.ddlCount + proof.reconciledAtStart.length === 2
      && proof.repeated && proof.grantsRestored && !proof.currentDevVueWritten && proof.protectedDataSchemaCountersUnchanged
      && proof.identity.db === 'dev_vue_m1_source_20260907_02' && proof.faults.length === 2, 'rehearsal_invalid')
  }
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.sql_mode sql_mode')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  check(identity.sql_mode.split(',').some(value => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(value)), 'strict_mode_required')
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadSubscriptionForeignKeyCoordinator(root), additions = plan.transitions.slice(145)
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'journal')
    const store = plan.store(connection), initial = await coordinateInplaceSchema(store, plan)
    check(plan.steps.length === 147 && initial.steps.slice(0, 145).every(row => row.status === 'completed'), 'prerequisites')
    for (const [table, column, parent] of subscriptionForeignKeys) {
      const [[row]] = await connection.query('SELECT COUNT(*) invalid FROM \x60' + table + '\x60 c LEFT JOIN \x60' + parent + '\x60 p ON p.id=c.\x60' + column + '\x60 WHERE c.\x60' + column + '\x60 IS NOT NULL AND p.id IS NULL')
      check(Number(row.invalid) === 0, 'orphans')
    }
    const before = await protectedSnapshot(connection, additions)
    const reconciledAtStart = initial.steps.filter(row => row.status === 'reconcile').map(row => row.id)
    const faults = injectAfterDdl ? [...reconciledAtStart] : []
    let ddlCount = 0, result
    const writer = { ...store, async execute(sql) {
      const step = plan.steps.slice(145).find(row => row.sql === sql)
      check(step, 'unexpected_ddl')
      await store.execute(sql); ddlCount++
      if (injectAfterDdl) { faults.push(step.id); throw Error('subscription_fk_injected') }
    } }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await coordinateInplaceSchema(writer, plan, { apply }); break }
      catch (error) {
        if (!injectAfterDdl || error.message !== 'subscription_fk_injected') throw error
        const recovery = await coordinateInplaceSchema(store, plan)
        check(recovery.steps.find(row => row.id === faults.at(-1))?.status === 'reconcile', 'reconcile')
      }
    }
    check(result, 'unfinished')
    if (injectAfterDdl) check(ddlCount + reconciledAtStart.length === 2 && new Set(faults).size === 2, 'faults_missing')
    if (apply) check((await coordinateInplaceSchema(writer, plan, { apply: true })).steps.every(row => row.status === 'completed'), 'repeat')
    const after = await protectedSnapshot(connection, additions)
    check(JSON.stringify(before) === JSON.stringify(after), 'protected_changed')
    return { kind: 'subscription-foreign-key-upgrade/v1', identity, apply, schemaSteps: plan.steps.length, ddlCount, reconciledAtStart, faults, result,
      protectedTableCount: before.rows.length, protectedRows: before.rows, protectedDataSchemaCountersUnchanged: true,
      numericComparison: 'full_decimal_text_and_null', repeated: apply,
      currentDevVueWritten: apply && database === 'dev_vue', runtimeEnabled: false }
  })
}

async function protectedSnapshot(connection, additions) {
  const snapshot = await modelCapacitySnapshot(connection, [])
  for (const row of snapshot.definitions) {
    row.ddl = removeSubscriptionForeignKeyDefinitions(row.name, row.ddl, additions)
  }
  return snapshot
}
