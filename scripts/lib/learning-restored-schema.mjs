import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { schemaFingerprint } from './v4-schema-fingerprint.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { originalDefinition } from './inplace-column-evidence.mjs'
import { originalUserDefaultDefinition } from './inplace-user-defaults.mjs'
import { originalReferralRuleDefinition } from './inplace-referral-rule-schema.mjs'

const check = (value, code) => { if (!value) throw Error(code) }

export async function loadLearningHistoricalSchema(path, backup) {
  const digest = createHash('sha256'), definitions = []
  let bytes = 0, lines = null, name
  const stream = createReadStream(path)
  stream.on('data', chunk => { digest.update(chunk); bytes += chunk.length })
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (line.startsWith('CREATE TABLE `')) {
      check(lines === null, 'learning_history_nested_definition')
      const match = /^CREATE TABLE `([a-z][a-z0-9_]*)` \($/.exec(line)
      check(match, 'learning_history_definition')
      name = match[1]; lines = [line]
    } else if (lines) {
      lines.push(line)
      if (line.startsWith(') ENGINE=')) {
        check(line.endsWith(';'), 'learning_history_definition')
        definitions.push({ name, ddl: lines.join('\n').slice(0, -1) }); lines = null
      }
    }
  }
  check(lines === null && String(bytes) === backup.rawSql.bytes && digest.digest('hex') === backup.rawSql.sha256,
    'learning_history_sql_hash')
  check(definitions.length === backup.parity.tableCount, 'learning_history_table_count')
  return definitions
}

// Only this recovery rehearsal accepts equivalent SHOW CREATE rendering. The
// historical SQL must first reproduce the exact frozen fingerprint. Every raw
// current definition is then frozen to detect changes during the rehearsal.
export async function readRestoredLearningSchema(connection, { backup, definitions, reference, excluded }) {
  const [[schema]] = await connection.query('SELECT DEFAULT_CHARACTER_SET_NAME charset_name,DEFAULT_COLLATION_NAME collation_name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()')
  check(schemaFingerprint(schema, definitions).sha256 === backup.schemaSha256, 'learning_history_schema_hash')
  const [tables] = await connection.query('SELECT TABLE_NAME name,TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')
  const expected = new Set([...definitions.map(row => row.name), ...excluded, 'database_upgrade_steps_v4'])
  check(tables.length === expected.size && tables.every(row => row.type === 'BASE TABLE' && expected.has(row.name)), 'learning_history_table_set')
  const current = [], counterDifferences = []
  for (const source of definitions) {
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${source.name}\``)
    const ddl = row['Create Table']
    let legacy = originalDefinition(source.name, ddl)
    if (source.name === 'users') legacy = originalUserDefaultDefinition(legacy)
    if (source.name === 'referral_rules') legacy = originalReferralRuleDefinition(legacy, reference)
    check(tableDefinitionHash(legacy) === tableDefinitionHash(source.ddl), 'learning_history_structure_changed')
    const counter = value => / AUTO_INCREMENT=(\d+)/.exec(value)?.[1] ?? null
    if (counter(source.ddl) !== counter(ddl)) counterDifferences.push({ table: source.name, historical: counter(source.ddl), restored: counter(ddl) })
    current.push({ name: source.name, ddl })
  }
  return { currentHash: schemaFingerprint(schema, current).sha256, counterDifferences }
}
