import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadSettingsCoordinator } from './inplace-settings-schema.mjs'
import { orderedSchemaStep } from './inplace-ordered-schema-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export async function loadSettingRequestCoordinator(root) {
  const proofRaw = await readFile(new URL('docs/migration/dev-vue-setting-management-probe-20260907.json', root), 'utf8')
  if (sha256(proofRaw) !== '813d23cd2d6594e89cb470393f0db493cf26061375ff46ba73f060edb41d2967') throw Error('inplace_setting_request_proof_hash')
  const proof = JSON.parse(proofRaw)
  const raw = await readFile(new URL('server/db/migrations/inplace/021_system_setting_requests.sql', root), 'utf8')
  if (proof.kind !== 'setting-management-probe/v1' || proof.identity.db !== 'dev_vue_m1_a'
    || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104' || proof.schema.sqlSha256 !== sha256(raw)
    || !proof.realCommitThenInjectedFailure || !proof.recoveredWithoutRewrite || !proof.concurrentSameRequestOneWrite
    || !proof.historicalReceiptRecovered || !proof.payloadConflictRejected || !proof.revokedAdminRejected
    || proof.invalidConstraintsRejected !== 3 || !proof.fixturesCleaned
    || !proof.schema.createTable.startsWith('CREATE TABLE `system_setting_requests` (')) throw Error('inplace_setting_request_reference_invalid')
  const statements = splitSqlStatements(raw)
  if (statements.length !== 1) throw new Error('inplace_setting_request_sql_invalid')
  const step = orderedSchemaStep({ id: 'inplace_018_01_system_setting_requests', table: 'system_setting_requests',
    sql: proof.schema.createTable, beforeHash: null, afterHash: tableDefinitionHash(proof.schema.createTable) })
  const prior = await loadSettingsCoordinator(root)
  return { referralRuleReference: prior.referralRuleReference, steps: [...prior.steps, step], transitions: [...prior.transitions, { step, key: step.table, before: null, after: step.afterHash }],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (name !== step.table) return base.tableHash(name)
        const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
        if (!tables.length) return null
        if (tables.length !== 1 || tables[0].type !== 'BASE TABLE') throw new Error('inplace_setting_request_table_conflict')
        const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
        if (triggers.length) throw new Error('inplace_setting_request_trigger_conflict')
        const [[row]] = await connection.query('SHOW CREATE TABLE `system_setting_requests`')
        return tableDefinitionHash(row['Create Table'])
      } }
    } }
}
