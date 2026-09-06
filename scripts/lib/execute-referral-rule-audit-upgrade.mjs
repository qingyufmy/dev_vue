import { readFile } from 'node:fs/promises'
import { loadReferralRuleAuditCoordinator } from './inplace-referral-rule-audit-schema.mjs'
import { verifyOriginalSchemaWithReferralRules } from './inplace-referral-rule-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { readOriginalRows, validateColumnEvidence } from './inplace-column-evidence.mjs'
import { verifyInplaceJournal, withInplaceUpgradeLock } from './mysql-inplace-column-store.mjs'
const root = new URL('../../', import.meta.url)
const check = (ok, code) => { if (!ok) throw new Error(code) }

export async function executeReferralRuleAuditUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(database === 'dev_vue' || database === 'dev_vue_m1_source_20260907_02', 'rule_upgrade_scope')
  check(!injectAfterDdl || (apply && database !== 'dev_vue'), 'rule_upgrade_fault_scope')
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root)))
  const evidence = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json', root)))
  validateColumnEvidence(backup, evidence)
  const plan = await loadReferralRuleAuditCoordinator(root)
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === database && identity.uuid === backup.serverUuid, 'rule_upgrade_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'rule_upgrade_journal')
    const store = plan.store(connection)
    const planned = await coordinateInplaceSchema(store, plan)
    check(planned.steps.slice(0, -1).every(step => step.status === 'completed'), 'rule_upgrade_prerequisites')
    const tables = [...new Set(plan.steps.filter(step => !step.column).map(step => step.table))]
    const verifyOriginal = async () => {
      await verifyOriginalSchemaWithReferralRules(connection, backup.schemaSha256, tables, plan.referralRuleReference)
      check(JSON.stringify(await readOriginalRows(connection, evidence.originalColumns)) === JSON.stringify(evidence.parity), 'rule_upgrade_original_rows')
    }
    await verifyOriginal()
    const addedTables = []
    for (const name of tables.filter(name => name !== 'referral_rule_changes')) {
      const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name])
      const [primary] = await connection.execute("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [name])
      addedTables.push({ name, columns: columns.map(row => row.name), primary: primary.map(row => row.name) })
    }
    const protectedBefore = await readOriginalRows(connection, addedTables)
    const readAudit = async () => {
      const [[exists]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', ['referral_rule_changes'])
      if (!Number(exists.n)) return null
      const [rows] = await connection.query('SELECT rule_id,rule_revision,request_id,actor_user_id,previous_rate_bps,rate_bps,previous_enabled,enabled,recorded_at_utc FROM referral_rule_changes ORDER BY rule_id,rule_revision')
      return JSON.stringify(rows)
    }
    const auditBefore = await readAudit()
    let ddlCount = 0, faultObserved = false
    const wrapped = { ...store, execute: async sql => {
      check(sql === plan.steps.at(-1).sql, 'rule_upgrade_unexpected_ddl')
      await store.execute(sql); ddlCount++
      if (injectAfterDdl) throw new Error('rule_upgrade_injected_after_ddl')
    } }
    let result
    try { result = await coordinateInplaceSchema(wrapped, plan, { apply }) }
    catch (error) {
      if (!injectAfterDdl || error.message !== 'rule_upgrade_injected_after_ddl') throw error
      faultObserved = true
      const recovery = await coordinateInplaceSchema(store, plan)
      check(recovery.steps.at(-1).status === 'reconcile', 'rule_upgrade_recovery_state')
      result = await coordinateInplaceSchema(store, plan, { apply: true })
      check(result.steps.at(-1).status === 'reconciled', 'rule_upgrade_recovery_result')
    }
    if (injectAfterDdl) check(faultObserved && ddlCount === 1, 'rule_upgrade_fault_not_exercised')
    if (apply) {
      const repeated = await coordinateInplaceSchema(wrapped, plan, { apply: true })
      check(repeated.steps.every(step => step.status === 'completed'), 'rule_upgrade_repeat')
      const [revisions] = await connection.query('SELECT CAST(revision AS CHAR) revision FROM referral_rules ORDER BY id')
      check(revisions.length === 4 && revisions.every(row => row.revision === '1'), 'rule_upgrade_revision')
    }
    await verifyOriginal()
    check(await readAudit() === (auditBefore ?? (apply ? '[]' : null)), 'rule_upgrade_audit_rows')
    check(JSON.stringify(await readOriginalRows(connection, addedTables)) === JSON.stringify(protectedBefore), 'rule_upgrade_protected_rows')
    return { kind: 'referral-rule-audit-upgrade/v1', identity, apply, schemaSteps: plan.steps.length, result, ddlCount,
      faultObserved, originalRows: backup.parity.rows, protectedBefore, originalRowsVerified: true,
      protectedRowsVerified: true, repeated: apply, businessConsumersSwitched: false }
  })
}
