import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { hash, canonical, BackfillError, requireBackfill as check } from './lib/v4-backfill-contract.mjs'
import { planAccountIdMappings } from './lib/v4-account-id-mapping.mjs'
import { createOwnershipBackfill } from './lib/v4-ownership-backfill-writer.mjs'
import { createAccountBackfill } from './lib/v4-account-backfill-writer.mjs'
import { MysqlInplaceAccountBackfillRepository, readInplaceAccountTargetIdentity } from './lib/mysql-inplace-account-backfill.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from './lib/v4-backfill-runner.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnEvidence, readOriginalRows, verifyOriginalSchema } from './lib/inplace-column-evidence.mjs'
import { foundationNames } from './lib/inplace-foundation-upgrade.mjs'
import { accountBuildNames } from './lib/inplace-account-build.mjs'

const runId = 'eeeeeeee-2026-4906-8000-000000000014', logicalSourceId = 'ownership-writer-rehearsal-v1'
const ledgerTables = ['data_migration_runs', 'data_migration_checkpoints', 'data_migration_batches', 'data_migration_id_maps', 'data_migration_row_receipts']
let control, pool
try {
  const [base, output] = process.argv.slice(2)
  check(process.platform === 'linux' && process.getuid() === 0 && process.argv.length === 4
    && /^\/www\/backup\/aurum-v4\/m1\/\d{8}-\d{2}$/.test(base)
    && output === `${base}/ownership-writer-rehearsal/receipt.json`, 'rehearsal_scope_invalid')
  const backup = JSON.parse(await readFile(`${base}/artifacts/receipt.json`, 'utf8'))
  const columns = JSON.parse(await readFile(`${base}/column-rehearsal/receipt.json`, 'utf8'))
  validateColumnEvidence(backup, columns)
  const fd = Number(process.env.V4_BACKUP_CREDENTIAL_FD)
  check(Number.isInteger(fd) && fd >= 3, 'rehearsal_credential_invalid')
  const config = JSON.parse(await readFile(`/proc/self/fd/${fd}`, 'utf8'))
  const { default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href)
  const options = { ...config, database: backup.target, dateStrings: true, jsonStrings: true, timezone: 'Z',
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectionLimit: 2 }
  control = await mysql.createConnection(options)
  await control.query("SET SESSION time_zone='+00:00'")
  const report = await withInplaceUpgradeLock(control, backup.target, async () => {
    const identity = await readInplaceAccountTargetIdentity(control)
    check(identity.database === backup.target && identity.database !== backup.source && identity.serverUuid === backup.serverUuid, 'rehearsal_target_invalid')
    const count = async table => {
      check([...ledgerTables, ...accountBuildNames].includes(table), 'rehearsal_table_invalid')
      const [[row]] = await control.query(`SELECT COUNT(*) n FROM \`${table}\``); return Number(row.n)
    }
    for (const table of [...ledgerTables, ...accountBuildNames]) check(await count(table) === 0, 'rehearsal_target_not_empty')
    await verifyOriginalSchema(control, backup.schemaSha256, [...foundationNames, ...accountBuildNames])
    check(canonical(await readOriginalRows(control, columns.originalColumns)) === canonical(columns.parity), 'rehearsal_original_data_changed')
    const [users] = await control.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY id LIMIT 2')
    check(users.length === 2, 'rehearsal_users_required')
    const rows = ['2147483646', '2147483647'].map((id, index) => ({ id, user_id: users[index].id,
      broker_server: 'AURUM-REHEARSAL-V1', login_account: '0000013', nickname: index ? null : "fixture O'Brien",
      margin_mode: 'hedging', review_status: 'approved', observe_status: 'active', is_deleted: '0',
      created_at: '2020-01-01 00:00:00', updated_at: '2020-01-02 00:00:00', observed_until: null,
      identity_verified_at: null, first_verified_at: null, anomaly_code: null }))
    const evidence = row => ({ ...row, sourceHash: hash(row) })
    const input = { accounts: rows.map(row => evidence({ id: row.id, userId: row.user_id, server: row.broker_server, login: row.login_account })),
      terminals: rows.map(row => evidence({ id: `fixture-${row.id}`, userId: row.user_id, platform: 'mt5', server: row.broker_server, login: row.login_account })),
      bindings: [evidence({ server: rows[0].broker_server, login: rows[0].login_account, currentUserId: users[0].id, currentAccountId: rows[0].id, currency: 'USD' })] }
    const plan = planAccountIdMappings(logicalSourceId, input, rows.map(row => row.id))
    const built = createAccountBackfill(rows, plan, { userIds: new Set(users.map(user => user.id)),
      timeBasis: { sourceTable: 'trading_accounts', offsetMinutes: 0, evidenceId: 'synthetic-fixture-utc-only' } })
    const spec = { runId, admission: { approved: true, blockers: [] }, bindings: { logicalSourceId,
      sourceDatabase: backup.target, mirrorDatabase: backup.source, targetDatabase: backup.target, targetServerUuid: backup.serverUuid,
      snapshotHash: hash(rows), schemaHash: identity.schemaHash, manifestHash: hash({ fixture: 'account-writer-v1', plan: plan.mappingHash }),
      transformHash: built.transformHash, streams: [built.stream], storageMode: 'inplace-account-v1' } }
    pool = mysql.createPool(options)
    let loseCommit = false, lostCommits = 0
    const repository = new MysqlInplaceAccountBackfillRepository({ async getConnection() {
      const connection = await pool.getConnection()
      return new Proxy(connection, { get(target, property) {
        if (property === 'commit') return async () => {
          await target.commit()
          if (loseCommit) { loseCommit = false; lostCommits++; target.destroy(); throw new Error('synthetic_commit_response_loss') }
        }
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value
      } })
    } })
    await prepareBackfillRun(repository, spec)
    let writes = 0
    const failing = { ...built.writer, async write(connection, row) {
      const value = await built.writer.write(connection, row)
      if (++writes === 2) throw new BackfillError('rehearsal_second_row_failure')
      return value
    } }
    await executeBackfillBatch(repository, spec, built.batches[0], failing).then(() => { throw new Error('rehearsal_fault_missing') }, error => {
      check(error.code === 'rehearsal_second_row_failure', 'rehearsal_unexpected_failure')
    })
    check(writes === 2, 'rehearsal_fault_missing')
    for (const table of [...accountBuildNames, ...ledgerTables.slice(2)]) check(await count(table) === 0, 'rehearsal_rollback_failed')
    loseCommit = true
    await executeBackfillBatch(repository, spec, built.batches[0], built.writer).then(() => { throw new Error('rehearsal_commit_fault_missing') }, error => {
      check(error.code === 'backfill_commit_unknown', 'rehearsal_unknown_not_reported')
    })
    const recovered = await recoverBackfillBatch(repository, spec, built.batches[0])
    check(lostCommits === 1 && recovered.status === 'committed', 'rehearsal_recovery_failed')
    const repeat = await executeBackfillBatch(repository, spec, built.batches[0], { ...built.writer, write() { throw new Error('rehearsal_replayed_writer') } })
    check(repeat.status === 'committed' && await count('trading_accounts_v4_build') === 1
      && await count('user_trading_account_settings_v4_build') === 2 && await count('data_migration_id_maps') === 2
      && await count('data_migration_row_receipts') === 2 && await count('data_migration_batches') === 1, 'rehearsal_count_mismatch')
    // An additional transaction checks every committed business field using the writer's exact readback.
    await repository.transaction(async tx => { for (const row of built.batches[0].rows) await built.writer.write(tx.connection, row) })
    const historyRows = [
      { id: '1', user: users[0].id, start: 1, end: 2 },
      { id: '2', user: users[1].id, start: 2, end: 3 },
      { id: '3', user: users[0].id, start: 3, end: null },
    ].map(item => ({ id: item.id, broker_server_key: rows[0].broker_server, login_account: rows[0].login_account,
      user_id: item.user, trading_account_id: rows[0].id, started_at: `2020-02-0${item.start} 00:00:00`,
      ended_at: item.end ? `2020-02-0${item.end} 00:00:00` : null, end_reason: item.end ? 'transfer' : null,
      created_at: `2020-02-0${item.start} 00:00:00`, updated_at: `2020-02-0${item.end ?? item.start} 00:00:00` }))
    const ownership = createOwnershipBackfill(historyRows, { logicalSourceId, accountMap: plan.ownershipMap,
      userIds: new Set(users.map(user => user.id)), timeBasis: { sourceTable: 'mt5_account_ownership_history', offsetMinutes: 0, evidenceId: 'synthetic-fixture-utc-only' } },
      { expectedSourceIds: ['1', '2', '3'] })
    const ownershipSpec = { ...spec, runId: 'eeeeeeee-2026-4906-8000-000000000015', bindings: { ...spec.bindings,
      snapshotHash: hash(historyRows), transformHash: ownership.transformHash, streams: [ownership.stream] } }
    await prepareBackfillRun(repository, ownershipSpec)
    let ownershipWrites = 0
    await executeBackfillBatch(repository, ownershipSpec, ownership.batches[0], { ...ownership.writer, async write(connection, row) {
      const result = await ownership.writer.write(connection, row)
      if (++ownershipWrites === 3) throw new BackfillError('rehearsal_ownership_failure')
      return result
    } }).then(() => { throw new Error('rehearsal_ownership_fault_missing') }, error => {
      check(error.code === 'rehearsal_ownership_failure', 'rehearsal_ownership_unexpected_failure')
    })
    check(ownershipWrites === 3 && await count('trading_account_ownership_intervals_v4_build') === 0
      && await count('trading_account_ownerships_v4_build') === 0 && await count('data_migration_id_maps') === 2
      && await count('data_migration_row_receipts') === 2 && await count('data_migration_batches') === 1, 'rehearsal_ownership_rollback_failed')
    loseCommit = true
    await executeBackfillBatch(repository, ownershipSpec, ownership.batches[0], ownership.writer).then(() => { throw new Error('rehearsal_ownership_commit_fault_missing') }, error => {
      check(error.code === 'backfill_commit_unknown', 'rehearsal_ownership_unknown_not_reported')
    })
    check((await recoverBackfillBatch(repository, ownershipSpec, ownership.batches[0])).status === 'committed' && lostCommits === 2, 'rehearsal_ownership_recovery_failed')
    await executeBackfillBatch(repository, ownershipSpec, ownership.batches[0], { ...ownership.writer, write() { throw new Error('rehearsal_ownership_replayed') } })
    check(await count('trading_account_ownership_intervals_v4_build') === 3 && await count('trading_account_ownerships_v4_build') === 2
      && await count('data_migration_id_maps') === 5 && await count('data_migration_row_receipts') === 5, 'rehearsal_ownership_count_mismatch')
    await repository.transaction(async tx => { for (const row of ownership.batches[0].rows) await ownership.writer.write(tx.connection, row) })
    await control.beginTransaction()
    try {
      const ownershipRun = ownershipSpec.runId
      await control.execute('DELETE FROM data_migration_row_receipts WHERE run_id=?', [ownershipRun])
      await control.execute('DELETE FROM data_migration_batches WHERE run_id=?', [ownershipRun])
      await control.execute('DELETE FROM data_migration_checkpoints WHERE run_id=?', [ownershipRun])
      await control.execute('DELETE FROM data_migration_id_maps WHERE created_run_id=? AND logical_source_id=?', [ownershipRun, logicalSourceId])
      await control.execute('DELETE FROM data_migration_runs WHERE id=?', [ownershipRun])
      for (const row of ownership.batches[0].rows) if (row.payload.grant) {
        const grant = row.payload.grant
        await control.execute('DELETE FROM trading_account_ownerships_v4_build WHERE user_id=? AND trading_account_id=? AND role=? AND interval_id=?',
          [grant.user_id, grant.trading_account_id, grant.role, grant.interval_id])
      }
      for (const row of ownership.batches[0].rows) await control.execute('DELETE FROM trading_account_ownership_intervals_v4_build WHERE id=? AND origin_ref=?',
        [row.payload.interval.id, row.payload.interval.origin_ref])
      await control.execute('DELETE FROM data_migration_row_receipts WHERE run_id=?', [runId])
      await control.execute('DELETE FROM data_migration_batches WHERE run_id=?', [runId])
      await control.execute('DELETE FROM data_migration_checkpoints WHERE run_id=?', [runId])
      await control.execute('DELETE FROM data_migration_id_maps WHERE created_run_id=? AND logical_source_id=?', [runId, logicalSourceId])
      await control.execute('DELETE FROM data_migration_runs WHERE id=?', [runId])
      for (const user of users) await control.execute('DELETE FROM user_trading_account_settings_v4_build WHERE trading_account_id=? AND user_id=?', [rows[0].id, user.id])
      const [removed] = await control.execute('DELETE FROM trading_accounts_v4_build WHERE id=? AND broker_server=? AND account_login=?', [rows[0].id, rows[0].broker_server, rows[0].login_account])
      check(removed.affectedRows === 1, 'rehearsal_cleanup_scope_mismatch')
      await control.commit()
    } catch (error) { await control.rollback(); throw error }
    for (const table of [...ledgerTables, ...accountBuildNames]) check(await count(table) === 0, 'rehearsal_cleanup_incomplete')
    await verifyOriginalSchema(control, backup.schemaSha256, [...foundationNames, ...accountBuildNames])
    check(canonical(await readOriginalRows(control, columns.originalColumns)) === canonical(columns.parity), 'rehearsal_original_data_changed')
    check((await readInplaceAccountTargetIdentity(control)).schemaHash === identity.schemaHash, 'rehearsal_schema_changed')
    return { kind: 'dev_vue_ownership_writer_rehearsal', status: 'verified', database: backup.target, serverUuid: backup.serverUuid,
      completedAtUtc: new Date().toISOString(), syntheticSourceRows: 5, committedEntities: 1, committedSettings: 2, committedIntervals: 3, committedGrants: 2, ownershipRollbackVerified: true, ownershipCommitRecoveryVerified: true,
      rollbackVerified: true, committedResponseLossRecovered: true, repeatDidNotInvokeWriter: true, fixtureCleanupVerified: true,
      originalTablesVerified: 165, originalRowsVerified: '271007', historicalTimeBasisConfirmed: false,
      sourceDatabaseWritten: false, temporaryAccountAutoIncrementMayAdvance: true, schemaHash: identity.schemaHash }
  })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? (/^(rehearsal|inplace)_[a-z_]+$/.test(error.message) ? error.message : 'rehearsal_account_writer_failed') }))
  process.exitCode = 1
} finally { if (pool) await pool.end().catch(() => {}); if (control) await control.end().catch(() => {}) }
