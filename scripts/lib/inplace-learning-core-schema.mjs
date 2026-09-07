import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadSettingRequestCoordinator } from './inplace-setting-request-schema.mjs'
import { orderedSchemaStep } from './inplace-ordered-schema-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export async function loadLearningCoreCoordinator(root) {
  const proofRaw = await readFile(new URL('docs/migration/dev-vue-learning-schema-probe-20260907.json', root), 'utf8')
  if (sha256(proofRaw) !== '3ca71758e47e6dfc44991b8013f862741017d66be1694051a09df66c08e5578d') throw Error('inplace_learning_proof_hash')
  const proof = JSON.parse(proofRaw)
  const raw = await readFile(new URL('server/db/migrations/inplace/022_learning_core.sql', root), 'utf8')
  const tables = ['learning_courses', 'learning_lessons', 'learning_media_references', 'learning_progress']
  if (proof.kind !== 'learning-schema-probe/v1' || proof.identity.db !== 'dev_vue_m1_a'
    || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104' || proof.sourceSqlSha256 !== sha256(raw)
    || proof.acceptedRows !== 4 || proof.rejected.length !== 18 || !proof.exactPrecision || !proof.overDurationPreserved || !proof.rolledBack
    || proof.currentDevVueWritten !== false || proof.definitions.length !== 4 || !tables.every(table => proof.counts[table] === 0)) throw Error('inplace_learning_reference_invalid')
  for (const file of proof.toolManifest) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').includes('..')
      || sha256(await readFile(new URL(file.path, root))) !== file.sha256) throw Error('inplace_learning_reference_tools')
  }
  const statements = splitSqlStatements(raw)
  if (statements.length !== 4) throw Error('inplace_learning_sql')
  const additions = tables.map((table, index) => {
    const definition = proof.definitions[index]
    if (definition.table !== table || !definition.ddl.startsWith(`CREATE TABLE \`${table}\` (`)
      || !statements[index].startsWith(`CREATE TABLE ${table} (`)) throw Error('inplace_learning_definition')
    return orderedSchemaStep({ id: `inplace_019_0${index + 1}_${table}`, table, sql: definition.ddl,
      beforeHash: null, afterHash: tableDefinitionHash(definition.ddl) })
  })
  const prior = await loadSettingRequestCoordinator(root)
  return { referralRuleReference: prior.referralRuleReference, steps: [...prior.steps, ...additions],
    transitions: [...prior.transitions, ...additions.map(step => ({ step, key: step.table, before: null, after: step.afterHash }))],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (!tables.includes(name)) return base.tableHash(name)
        const [found] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
        if (!found.length) return null
        if (found.length !== 1 || found[0].type !== 'BASE TABLE') throw Error('inplace_learning_table_conflict')
        const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
        if (triggers.length) throw Error('inplace_learning_trigger_conflict')
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
        return tableDefinitionHash(row['Create Table'])
      } }
    } }
}
