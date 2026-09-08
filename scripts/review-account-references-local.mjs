import { open, readFile, readdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readAccountBackfillV2Identity } from './lib/mysql-account-backfill-v2.mjs'
import { planAccountIdMappings } from './lib/v4-account-id-mapping.mjs'
import { inspectAccountJson, accountRootSourceReferences } from './lib/account-reference-review.mjs'

const root = new URL('../', import.meta.url), check = value => { if (!value) throw Error('account_reference_review_failed') }
const quote = value => { check(/^[a-z][a-z0-9_]*$/.test(value)); return `\`${value}\`` }
let connection, output
try {
  const [mode, destination] = process.argv.slice(2)
  check(mode === '--read-only' && isAbsolute(destination) && process.argv.length === 4)
  output = await open(destination, 'wx', 0o600)
  const env = await loadSettingsMigrationEnvironment(root); check(env.MYSQL_DATABASE === 'dev_vue' && env.MYSQL_USER === 'dev_vue')
  connection = await mysql.createConnection({ ...settingsMigrationConnectionOptions(env), jsonStrings: true, connectTimeout: 5000, multipleStatements: false })
  await connection.query("SET SESSION time_zone='+00:00'")
  const report = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      const identity = await readAccountBackfillV2Identity(connection)
      check(identity.serverUuid === 'ac423207-6ef3-11f1-b302-000c29fda104')
      const [accounts] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) userId,broker_server server,login_account login FROM trading_accounts ORDER BY id')
      const [terminals] = await connection.query('SELECT terminal_instance_id id,CAST(user_id AS CHAR) userId,platform,broker_server server,login_account login FROM bridge_v3_terminal_sessions ORDER BY terminal_instance_id')
      const [bindings] = await connection.query('SELECT broker_server_key server,login_account login,CAST(current_user_id AS CHAR) currentUserId,CAST(current_trading_account_id AS CHAR) currentAccountId,account_currency currency FROM mt5_account_bindings ORDER BY broker_server_key,login_account')
      const input = Object.fromEntries(Object.entries({ accounts, terminals, bindings }).map(([key, values]) => [key, values.map(row => ({ ...row, sourceHash: hash({ ...row }) }))]))
      const plan = planAccountIdMappings('dev_vue', input, accounts.map(row => row.id))
      const sourceIds = new Set(accounts.map(row => row.id)), mergedIds = new Set(plan.settings.filter(row => row.sourceAccountId !== row.targetAccountId).map(row => row.sourceAccountId))
      const [columns] = await connection.query("SELECT TABLE_NAME tableName,COLUMN_NAME columnName,DATA_TYPE dataType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION")
      const [foreignKeys] = await connection.query("SELECT TABLE_NAME tableName,COLUMN_NAME columnName,CONSTRAINT_NAME constraintName FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='trading_accounts' ORDER BY TABLE_NAME,ORDINAL_POSITION")
      const relational = []
      for (const column of columns.filter(row => /(?:^|_)(?:trading_account_id|account_id)$/.test(row.columnName))) {
        const predicate = ids => ids.size ? `CAST(${quote(column.columnName)} AS CHAR) IN (${[...ids].map(() => '?').join(',')})` : 'FALSE'
        const [[counts]] = await connection.execute(`SELECT COUNT(*) totalRows,COUNT(${quote(column.columnName)}) nonNullRows,COALESCE(SUM(${predicate(sourceIds)}),0) sourceMatches,COALESCE(SUM(${predicate(mergedIds)}),0) mergedMatches FROM ${quote(column.tableName)}`, [...sourceIds, ...mergedIds])
        relational.push({ ...column, ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])),
          declaredOldRootFk: foreignKeys.some(fk => fk.tableName === column.tableName && fk.columnName === column.columnName) })
      }
      const json = []; let totalBytes = 0
      for (const column of columns.filter(row => row.dataType === 'json' || (['text', 'mediumtext', 'longtext', 'varchar'].includes(row.dataType) && /(json|payload|metadata|context|params|config|result|snapshot)/i.test(row.columnName)))) {
        const [[size]] = await connection.query(`SELECT COUNT(${quote(column.columnName)}) rowsCount,COALESCE(SUM(OCTET_LENGTH(${quote(column.columnName)})),0) bytes,COALESCE(MAX(OCTET_LENGTH(${quote(column.columnName)})),0) maxBytes FROM ${quote(column.tableName)}`)
        const entry = { ...column, rows: Number(size.rowsCount), bytes: Number(size.bytes), status: 'scanned', documentsWithMergedIds: 0,
          invalidJson: 0, encodedJson: 0, limited: 0, references: 0, sourceMatches: 0, mergedMatches: 0, otherValues: 0, unsafeNumbers: 0 }
        if (Number(size.maxBytes) > 32 * 1024 * 1024 || totalBytes + entry.bytes > 512 * 1024 * 1024) entry.status = 'size-limit-not-scanned'
        else {
          totalBytes += entry.bytes
          const stream = connection.connection.query(`SELECT ${quote(column.columnName)} value FROM ${quote(column.tableName)} WHERE ${quote(column.columnName)} IS NOT NULL`).stream({ highWaterMark: 16 })
          let read = 0
          for await (const row of stream) {
            const result = inspectAccountJson(typeof row.value === 'string' ? row.value : JSON.stringify(row.value), sourceIds, mergedIds)
            read++; if (result.mergedMatches) entry.documentsWithMergedIds++
            for (const [key, value] of Object.entries(result)) entry[key] += value
          }
          check(read === entry.rows)
        }
        json.push(entry)
      }
      return { identity, mappingHash: plan.mappingHash, sourceAccounts: sourceIds.size, mergedSourceIds: mergedIds.size, foreignKeys, relational, json }
    } finally { await connection.rollback() }
  })
  const sources = []
  async function scan(directory) {
    for (const entry of await readdir(new URL(directory + '/', root), { withFileTypes: true })) {
      const path = directory + '/' + entry.name
      if (entry.isDirectory()) await scan(path)
      else if (entry.name.endsWith('.ts')) {
        const bytes = await readFile(new URL(path, root)), references = accountRootSourceReferences(bytes.toString('utf8'), path)
        if (references.length) sources.push({ path, sha256: sha256(bytes), references })
      }
    }
  }
  await scan('server/src')
  const legacy = []
  for (const path of ['server/admin/user-deletion.js', 'server/routes/ai/risk-state.js', 'server/routes/ai/strategy-ownership.js', 'server/migrations.js']) {
    const bytes = await readFile(new URL(path, root))
    legacy.push({ path, sha256: sha256(bytes), references: accountRootSourceReferences(bytes.toString('utf8'), path) })
  }
  const tools = await Promise.all(['scripts/review-account-references-local.mjs', 'scripts/lib/account-reference-review.mjs'].map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
  const receipt = { kind: 'account-reference-review/v1', observedAt: new Date().toISOString(), databaseWrites: 0, ...report, sources, legacy, tools,
    limitations: ['Name-based account references are candidates, not approved ID rewrites.', 'JSON scan covers typed JSON, named text candidates and legacy gzip-base64; arbitrary text, other encodings and semantic generic IDs require further review.', 'Source literal scan does not prove runtime process state or complete dynamically composed SQL.'] }
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ relational: report.relational.length, relationalMerged: report.relational.filter(row => row.mergedMatches).length,
    jsonColumns: report.json.length, jsonMerged: report.json.filter(row => row.mergedMatches).length, jsonSkipped: report.json.filter(row => row.status !== 'scanned').length, sourceFiles: sources.length }))
} catch { console.error(JSON.stringify({ code: 'account_reference_review_failed' })); process.exitCode = 1 }
finally { if (connection) await connection.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
