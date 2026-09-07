import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { schemaFingerprint } from '../scripts/lib/v4-schema-fingerprint.mjs'
import { loadLearningHistoricalSchema, readRestoredLearningSchema } from '../scripts/lib/learning-restored-schema.mjs'

const schema = { charset_name: 'utf8mb4', collation_name: 'utf8mb4_general_ci' }
const ddl = "CREATE TABLE `sample` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `label` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci"
const definitions = [{ name: 'sample', ddl }]
const backup = { schemaSha256: schemaFingerprint(schema, definitions).sha256 }
const directories = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
const connection = (actual, extra = []) => ({ async query(sql) {
  if (sql.startsWith('SELECT DEFAULT')) return [[schema]]
  if (sql.startsWith('SELECT TABLE_NAME')) return [[...['sample', 'database_upgrade_steps_v4', ...extra].map(name => ({ name, type: 'BASE TABLE' }))]]
  return [[{ 'Create Table': actual }]]
} })
const read = (actual, extra) => readRestoredLearningSchema(connection(actual, extra), { backup, definitions, excluded: [] })

describe('restored learning schema admission', () => {
  it('accepts equivalent charset rendering, reports counters, and preserves raw-state differences', async () => {
    const a = await read(ddl)
    const b = await read(ddl.replace('COLLATE utf8mb4_general_ci DEFAULT', 'CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT').replace('AUTO_INCREMENT=9', 'AUTO_INCREMENT=3'))
    expect(b.currentHash).not.toBe(a.currentHash)
    expect(b.counterDifferences).toEqual([{ table: 'sample', historical: '9', restored: '3' }])
  })
  it.each([ddl.replace('varchar(20)', 'varchar(30)'), ddl.replace('DEFAULT NULL', "DEFAULT 'changed'")])('rejects real schema changes', async actual => {
    await expect(read(actual)).rejects.toThrow('learning_history_structure_changed')
  })
  it('rejects an unexpected table', async () => {
    await expect(read(ddl, ['unreviewed'])).rejects.toThrow('learning_history_table_set')
  })
  it('binds parsed definitions to the full backup bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'learning-schema-')); directories.push(directory)
    const path = join(directory, 'backup.sql'), sql = `${ddl};\nINSERT INTO sample VALUES (1,NULL);\n`
    await writeFile(path, sql)
    const proof = { rawSql: { bytes: String(Buffer.byteLength(sql)), sha256: createHash('sha256').update(sql).digest('hex') }, parity: { tableCount: 1 } }
    expect(await loadLearningHistoricalSchema(path, proof)).toEqual(definitions)
    await writeFile(path, sql.replace('(1,NULL)', '(2,NULL)'))
    await expect(loadLearningHistoricalSchema(path, proof)).rejects.toThrow('learning_history_sql_hash')
  })
})
