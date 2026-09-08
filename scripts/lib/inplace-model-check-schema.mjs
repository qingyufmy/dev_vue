import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { loadDefaultNormalizationCoordinator } from './inplace-default-normalization-schema.mjs'

const checks = [
  { table: 'ai_model_profiles', name: 'chk_v4_model_profiles_owner', expression: "(scope='platform' AND owner_user_id=0) OR (scope='user' AND owner_user_id>0)",
    line: "  CONSTRAINT `chk_v4_model_profiles_owner` CHECK ((((`scope` = _utf8mb4'platform') and (`owner_user_id` = 0)) or ((`scope` = _utf8mb4'user') and (`owner_user_id` > 0))))" },
  { table: 'platform_model_usage_policy', name: 'chk_v4_model_policy_singleton', expression: 'id=1',
    line: '  CONSTRAINT `chk_v4_model_policy_singleton` CHECK ((`id` = 1))' },
]
export async function modelCheckTransitions(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-model-check-source-20260908.json', root))
  if (sha256(bytes) !== '78e204225026b32498389ae1ceddac91bb5afa7c5f7b7bd5032a72a3691f030a') throw Error('model_check_source_hash')
  const source = JSON.parse(bytes)
  if (source.schemaSteps !== 131 || source.databaseWrites !== 0 || source.models.invalid !== '0' || source.policy.invalid !== '0') throw Error('model_check_source_invalid')
  return checks.map((check, index) => {
    const beforeDefinition = source.definitions.find(row => row.name === check.table).sql
    if (/CONSTRAINT /.test(beforeDefinition)) throw Error('model_check_existing_constraint')
    const afterDefinition = beforeDefinition.replace(/\n\) ENGINE=/, ',\n' + check.line + '\n) ENGINE=')
    const before = tableDefinitionHash(beforeDefinition), after = tableDefinitionHash(afterDefinition)
    if (before === after) throw Error('model_check_definition')
    const value = { id: `inplace_026_0${index + 1}_${check.name}`, table: check.table,
      sql: `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`, beforeHash: before, afterHash: after }
    return { step: { ...value, checksum: sha256(JSON.stringify(value)) }, key: check.table, before, after,
      beforeDefinition, afterDefinition, constraintLine: check.line }
  })
}
export function removeModelCheckDefinition(ddl, transition) {
  const lines = ddl.split('\n'), index = lines.indexOf(transition.constraintLine)
  if (index === -1) return ddl
  if (index < 1 || !lines[index - 1].endsWith(',') || !lines[index + 1]?.startsWith(') ENGINE=')) throw Error('model_check_layout')
  lines.splice(index, 1); lines[index - 1] = lines[index - 1].slice(0, -1)
  return lines.join('\n')
}
export async function loadModelCheckCoordinator(root) {
  const additions = await modelCheckTransitions(root)
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/030_model_integrity_checks.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(additions.map(row => row.step.sql))) throw Error('model_check_sql_drift')
  const prior = await loadDefaultNormalizationCoordinator(root)
  return { ...prior, steps: [...prior.steps, ...additions.map(row => row.step)], transitions: [...prior.transitions, ...additions],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (!checks.some(row => row.table === name)) return base.tableHash(name)
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
        return tableDefinitionHash(row['Create Table'])
      } }
    } }
}
