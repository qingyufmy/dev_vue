import { readFile, open } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { requireBackfill as check } from './lib/v4-backfill-contract.mjs'

const root = new URL('../', import.meta.url)
let connection, output
try {
  const [flag, path] = process.argv.slice(2)
  if (flag === '--help' && process.argv.length === 3) {
    console.log('node scripts/audit-legacy-time-local.mjs --write <absolute-private-report.json>')
  } else {
    check(flag === '--write' && process.argv.length === 4 && isAbsolute(path), 'legacy_time_arguments')
    const location = relative(fileURLToPath(root), resolve(path))
    check(location.startsWith(`..${sep}`) || isAbsolute(location), 'legacy_time_private_output')
    output = await open(path, 'wx', 0o600)
    const env = await loadSettingsMigrationEnvironment(root)
    check(env.MYSQL_DATABASE === 'dev_vue', 'legacy_time_database')
    connection = await mysql.createConnection(settingsMigrationConnectionOptions(env))
    await connection.query("SET SESSION time_zone='+00:00'")
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION READ ONLY')
    const [[identity]] = await connection.query('SELECT DATABASE() database_name, @@server_uuid server_uuid, @@session.time_zone session_timezone')
    const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root)))
    check(identity.server_uuid === backup.serverUuid && identity.database_name === 'dev_vue', 'legacy_time_identity')
    const pairs = []
    // Identifiers are fixed here, never supplied by the caller or a source row.
    for (const table of ['ai_signals', 'trade_audit_logs']) {
      const [columns] = await connection.execute(`SELECT COLUMN_NAME name, DATA_TYPE type FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME IN ('created_at','created_at_utc_msc')`, [table])
      if (columns.length !== 2 || columns.find(row => row.name === 'created_at')?.type !== 'datetime') {
        pairs.push({ table, status: 'unavailable', columns }); continue
      }
      const [[coverage]] = await connection.query(`SELECT COUNT(*) total,
        SUM(created_at IS NOT NULL AND created_at_utc_msc BETWEEN 1 AND 253402300799999) paired,
        MIN(created_at) first_wall_clock, MAX(created_at) last_wall_clock FROM ${table}`)
      const [groups] = await connection.query(`SELECT DATE_FORMAT(created_at,'%Y-%m') wall_clock_month,
        ROUND(TIMESTAMPDIFF(MICROSECOND, FROM_UNIXTIME(created_at_utc_msc/1000), created_at)/60000000) offset_minutes,
        COUNT(*) total,
        MAX(ABS(TIMESTAMPDIFF(MICROSECOND, FROM_UNIXTIME(created_at_utc_msc/1000), created_at)/1000000
          - ROUND(TIMESTAMPDIFF(MICROSECOND, FROM_UNIXTIME(created_at_utc_msc/1000), created_at)/60000000)*60)) max_residual_seconds
        FROM ${table} WHERE created_at IS NOT NULL AND created_at_utc_msc BETWEEN 1 AND 253402300799999
        GROUP BY wall_clock_month, offset_minutes ORDER BY wall_clock_month, offset_minutes`)
      pairs.push({ table, status: 'observed', coverage, groups })
    }
    await connection.rollback()
    const report = { kind: 'legacy-time-pair-audit/v1', capturedAtUtc: new Date().toISOString(), identity, pairs,
      databaseWrites: false, historicalDeploymentProven: false, pairedEpochsMayBeDerivedByMigration159: true,
      limitation: 'Migration 159 derives some epochs from Beijing DATETIME. Pair agreement is not independent historical clock proof; do not infer offsets for other tables or unpaired history.' }
    await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync()
    console.log(JSON.stringify({ status: 'audited', pairs, databaseWrites: false }))
  }
} catch (error) {
  console.error(JSON.stringify({ code: /^(legacy_time|settings_environment)_[a-z_]+$/.test(error.message) ? error.message : 'legacy_time_audit_failed' }))
  process.exitCode = 1
} finally { await connection?.rollback().catch(() => {}); await connection?.end(); await output?.close() }
