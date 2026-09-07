import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { orderedSchemaStep } from './inplace-ordered-schema-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { loadLearningCoreCoordinator } from './inplace-learning-core-schema.mjs'

export async function loadLearningCompletionCoordinator(root) {
  const rawProof = await readFile(new URL('docs/migration/dev-vue-learning-completion-probe-20260907.json', root), 'utf8')
  if (sha256(rawProof) !== 'bee9b08f24368300bec22bc398c9b2f721eca84f2e5f91f56f1472811be85070') throw Error('inplace_completion_proof_hash')
  const proof = JSON.parse(rawProof)
  const source = await readFile(new URL('server/db/migrations/inplace/023_learning_progress_changes.sql', root), 'utf8')
  const correction = await readFile(new URL('server/db/migrations/inplace/024_learning_request_key_preservation.sql', root), 'utf8')
  if (proof.kind !== 'learning-completion-probe/v1' || !proof.verified || !proof.fixtureCleanupVerified || !proof.grantsRestored
    || proof.currentDevVueWritten !== false || proof.identity.db !== 'dev_vue_m1_source_20260907_02'
    || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104' || proof.sourceSqlSha256 !== sha256(source)
    || proof.correctionSqlSha256 !== sha256(correction) || !proof.concurrentSingleWinner || !proof.exactPrecisionAndOverDuration
    || !proof.commitUnknownRecovered || !proof.auditRollbackVerified || !proof.acceptedConstraintRow || proof.rejectedConstraints.length !== 6) {
    throw Error('inplace_completion_proof_invalid')
  }
  const table = 'learning_progress_changes'
  const first = orderedSchemaStep({ id: 'inplace_020_01_learning_progress_changes', table,
    sql: proof.initialDefinition, beforeHash: null, afterHash: tableDefinitionHash(proof.initialDefinition) })
  const statements = splitSqlStatements(correction)
  if (statements.length !== 1 || statements[0] !== 'ALTER TABLE learning_progress_changes\n  MODIFY request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL') throw Error('inplace_completion_correction_scope')
  // An exact, evidence-bound widening. Do not broaden the generic CREATE/FK helper.
  const value = { id: 'inplace_020_02_learning_request_key_preservation', table, sql: statements[0],
    beforeHash: first.afterHash, afterHash: tableDefinitionHash(proof.definition) }
  if (value.beforeHash === value.afterHash) throw Error('inplace_completion_no_change')
  const second = Object.freeze({ ...value, checksum: sha256(JSON.stringify(value)) })
  const prior = await loadLearningCoreCoordinator(root), additions = [first, second]
  return { ...prior, steps: [...prior.steps, ...additions],
    transitions: [...prior.transitions, ...additions.map(step => ({ step, key: table, before: step.beforeHash, after: step.afterHash }))],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (name !== table) return base.tableHash(name)
        const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])
        if (!tables.length) return null
        if (tables.length !== 1 || tables[0].type !== 'BASE TABLE') throw Error('inplace_completion_table_conflict')
        const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [table])
        if (triggers.length) throw Error('inplace_completion_trigger_conflict')
        const [[row]] = await connection.query('SHOW CREATE TABLE learning_progress_changes')
        return tableDefinitionHash(row['Create Table'])
      } }
    } }
}
