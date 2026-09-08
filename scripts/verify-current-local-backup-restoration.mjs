import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { equivalentRestoredDdl } from './lib/restore-ddl-equivalence.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const directory = 'D:/dev_codex/.backup-current-20260908-03', target = 'dev_vue_m1_source_20260908_03'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
try {
  assert.equal(process.argv[2], '--read-only-restored-03'); assert.equal(process.argv.length, 3)
  const preparation = await json('docs/architecture/current-account-wave-preparation-20260908.json')
  assert.equal(hash(preparation.frozen), preparation.manifestHash)
  const failure = await json(directory + '/continuation-failure.json')
  assert.equal(failure.stage, 'verify-restored-data'); assert.equal(failure.targetCreationAttempted, true)
  const review = await json(directory + '/continuation-sql-review.json')
  assert.equal(review.kind, 'v4_backup_sql_review/v2')
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root'); assert.equal(credentials.port, 13316)
  const read = async database => {
    const c = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: 'root', password: credentials.password,
      database, timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
    try {
      const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid')
      assert.equal(identity.db, database); assert.equal(identity.uuid, preparation.frozen.targetIdentity.serverUuid)
      await c.query("SET SESSION time_zone='+00:00'")
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      const snapshot = await readAccountRootSnapshot(c)
      const [columns] = await c.query('SELECT TABLE_NAME tableName,COLUMN_NAME name,ORDINAL_POSITION ordinalPosition,COLUMN_DEFAULT defaultValue,IS_NULLABLE nullable,DATA_TYPE dataType,COLUMN_TYPE columnType,CHARACTER_SET_NAME characterSet,COLLATION_NAME collation,COLUMN_KEY columnKey,EXTRA extra,COLUMN_COMMENT comment,GENERATION_EXPRESSION generationExpression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION')
      await c.rollback(); return { snapshot, columns }
    } finally { c.destroy() }
  }
  const source = await read('dev_vue'), restored = await read(target)
  assert.deepEqual(source.columns, restored.columns)
  const compact = tables => tables.map(({ name, rows, rowsSha256, ddl }) => ({ name, rows, rowsSha256, ddlSha256: sha256(ddl) }))
  assert.deepEqual(compact(source.snapshot.tables), preparation.frozen.tables)
  assert.deepEqual(restored.snapshot.tables.map(table => table.name), source.snapshot.tables.map(table => table.name))
  const differences = []
  for (let index = 0; index < source.snapshot.tables.length; index++) {
    const a = source.snapshot.tables[index], b = restored.snapshot.tables[index]
    assert.equal(a.rows, b.rows); assert.equal(a.rowsSha256, b.rowsSha256)
    const comparison = equivalentRestoredDdl(a.ddl, b.ddl, source.columns.filter(column => column.tableName === a.name))
    assert.equal(comparison.equivalent, true)
    if (comparison.differences.length) differences.push({ table: a.name, differences: comparison.differences })
  }
  for (const tool of preparation.frozen.tools) assert.equal(sha256(await readFile(tool.path)), tool.sha256)
  const tools = await Promise.all(['scripts/verify-current-local-backup-restoration.mjs', 'scripts/lib/restore-ddl-equivalence.mjs',
    'scripts/continue-current-local-backup-restore.mjs', 'scripts/lib/v4-backup-sql-scope-v2.mjs'].map(async path => ({ path, sha256: sha256(await readFile(path)) })))
  const receipt = { kind: 'current-local-backup-restoration/v2', status: 'verified', observedAt: new Date().toISOString(), source: 'dev_vue', target,
    serverUuid: preparation.frozen.targetIdentity.serverUuid, preparationManifestHash: preparation.manifestHash,
    tableCount: restored.snapshot.tables.length, totalRows: restored.snapshot.tables.reduce((sum, table) => sum + BigInt(table.rows), 0n).toString(),
    sourceTablesSha256: hash(preparation.frozen.tables), restoredTablesSha256: hash(compact(restored.snapshot.tables)), columnsSha256: hash(source.columns),
    completeRowParity: true, completeColumnMetadataParity: true, semanticDdlParity: true, byteIdenticalDdl: differences.length === 0,
    ddlRenderingDifferences: differences, artifact: await json(directory + '/encrypted-artifact.json'), tools,
    currentDevVueWrites: 0, currentDatabaseUpgraded: false, scope: 'Read-only full row/column verification. Only exact redundant utf8mb4 charset rendering is accepted; original raw DDL hashes remain distinct.' }
  await writeFile(directory + '/semantic-restoration-receipt.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(receipt))
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: 'current_restore_verification_failed' })); process.exitCode = 1
}
