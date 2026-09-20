import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { BackfillError, hash } from './v4-backfill-contract.mjs'
import { createStrategySourceBatch } from './strategy-source-batch.mjs'
import { MysqlBackfillRepository } from './v4-backfill-mysql-repository.mjs'
import { legacyStrategyFields } from './v4-strategy-source-review.mjs'
import { strategyRoleLegacyIdentity } from './strategy-role-legacy-identity.mjs'
import { createStrategySourceWriter } from './mysql-strategy-source-writer.mjs'
import { compileStrategy } from '../../server/dist-v4/modules/strategies/application/strategy-service.js'

export async function verifyStrategySourceWriteReference(connection, pool) {
  const [[database]] = await connection.query('SELECT DATABASE() name')
  assert.match(database.name, /^dev_vue_strategy_ref_[0-9a-f]{32}$/)
  const ledger = await readFile(new URL('../../server/db/migrations/20260906_025_data_migration_batch_ledger.sql', import.meta.url), 'utf8')
  for (const sql of splitSqlStatements(ledger)) await connection.query(sql)
  await connection.query(await readFile(new URL('../../server/db/migrations/inplace/005_source_row_evidence.sql', import.meta.url), 'utf8'))
  // A complete named-column fixture, not evidence of legacy schema restoration.
  await connection.query(`CREATE TABLE auto_prompt_types (${legacyStrategyFields.map(field =>
    field === 'id' ? 'id BIGINT UNSIGNED PRIMARY KEY' : `\`${field}\` LONGTEXT NULL`).join(',')}) ENGINE=InnoDB`)
  const source = Object.fromEntries(legacyStrategyFields.map(field => [field, null]))
  source.id = '21'; source.version = '44'; source.system_prompt = 'legacy fixture'
  source.symbols_json = '["EURUSD","XAUUSD"]'
  await connection.execute(`INSERT INTO auto_prompt_types (${legacyStrategyFields.map(field => `\`${field}\``).join(',')})
    VALUES (${legacyStrategyFields.map(() => '?').join(',')})`, legacyStrategyFields.map(field => source[field]))
  const roles = Object.fromEntries(['analysis', 'trader'].map((kind, index) => {
    const identity = strategyRoleLegacyIdentity(source.id, source.version, kind), time = '2026-09-09 00:00:00.123'
    const compiled = compileStrategy(kind, 'source reference', {}), id = String(30001 + index), versionId = String(40001 + index)
    return [kind, { strategy: { id, kind, scope: 'platform', owner_user_id: null, name: 'source reference', description: '', status: 'draft',
      active_version_id: versionId, revision: '1', legacy_source_table: identity.sourceTable, legacy_id: identity.strategy.legacyId,
      created_at_utc: time, updated_at_utc: time, deleted_at_utc: null },
    version: { id: versionId, strategy_id: id, version_number: source.version, prompt_text: 'source reference', prompt_sha256: compiled.promptHash,
      input_contract_version: compiled.inputContractVersion, output_contract_version: compiled.outputContractVersion, config_json: compiled.normalizedConfig,
      created_by_user_id: '7', legacy_source_table: identity.sourceTable, legacy_id: identity.version.legacyId, created_at_utc: time } }]
  }))
  const entry = { source, sourceHash: hash(source), roles }, runId = randomUUID()
  const writer = createStrategySourceWriter([entry], { logicalSourceId: 'reference', runId })
  const repository = new MysqlBackfillRepository(pool)
  await repository.transaction(tx => tx.insertRun(runId, { reference: true }, hash({ reference: true })))
  const counts = async () => {
    const [[rows]] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM strategies WHERE id IN (30001,30002)) strategies,
      (SELECT COUNT(*) FROM strategy_versions WHERE id IN (40001,40002)) versions,
      (SELECT COUNT(*) FROM data_migration_id_maps) maps`)
    return { ...rows }
  }
  await assert.rejects(repository.transaction(async tx => {
    const insert = tx.insertMapping.bind(tx); let written = 0
    tx.insertMapping = async (...args) => { await insert(...args); if (++written === 2) throw new BackfillError('injected_map_failure') }
    return writer.write(tx, entry)
  }), { code: 'injected_map_failure' })
  assert.deepEqual(await counts(), { strategies: 0, versions: 0, maps: 0 })
  await connection.execute('UPDATE auto_prompt_types SET title=? WHERE id=?', ['changed', source.id])
  await assert.rejects(repository.transaction(tx => writer.write(tx, entry)), { code: 'strategy_source_changed' })
  assert.deepEqual(await counts(), { strategies: 0, versions: 0, maps: 0 })
  await connection.execute('UPDATE auto_prompt_types SET title=NULL WHERE id=?', [source.id])
  let loseAck = true
  const uncertain = new MysqlBackfillRepository({ async getConnection() {
    const db = await pool.getConnection()
    return new Proxy(db, { get(target, key) {
      if (key === 'commit') return async () => { await target.commit(); if (loseAck) { loseAck = false; throw Error('injected_ack_loss') } }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
  } })
  await assert.rejects(uncertain.transaction(tx => writer.write(tx, entry)), { code: 'backfill_commit_unknown' })
  assert.deepEqual(await counts(), { strategies: 2, versions: 2, maps: 4 })
  const replays = await Promise.all([repository.transaction(tx => writer.write(tx, entry)), repository.transaction(tx => writer.write(tx, entry))])
  assert.ok(replays.every(result => result.inserted === 0 && result.mappingsInserted === 0))
  await repository.transaction(tx => writer.write(tx, entry, { verifyOnly: true }))
  assert.deepEqual(await counts(), { strategies: 2, versions: 2, maps: 4 })
  const batchEntry = structuredClone(entry)
  batchEntry.source.id = '22'; batchEntry.sourceHash = hash(batchEntry.source)
  for (const kind of ['analysis', 'trader']) {
    const identity = strategyRoleLegacyIdentity('22', '44', kind), role = batchEntry.roles[kind]
    role.strategy.id = String(BigInt(role.strategy.id) + 1000n)
    role.version.id = String(BigInt(role.version.id) + 1000n)
    role.version.strategy_id = role.strategy.id; role.strategy.active_version_id = role.version.id
    role.strategy.legacy_id = identity.strategy.legacyId; role.version.legacy_id = identity.version.legacyId
  }
  await connection.execute(`INSERT INTO auto_prompt_types (${legacyStrategyFields.map(field => `\`${field}\``).join(',')})
    VALUES (${legacyStrategyFields.map(() => '?').join(',')})`, legacyStrategyFields.map(field => batchEntry.source[field]))
  const batchRun = randomUUID(), bindings = { logicalSourceId: 'reference', fixture: true }
  const batch = createStrategySourceBatch([batchEntry], { runId: batchRun, logicalSourceId: 'reference', bindings, sequence: 1, startCursor: null })
  await repository.transaction(async tx => {
    await tx.insertRun(batchRun, bindings, hash(bindings)); await tx.insertCheckpoint(batchRun, batch.streamId)
  })
  await assert.rejects(repository.transaction(async tx => {
    const execute = tx.connection.execute.bind(tx.connection)
    tx.connection.execute = async (...args) => {
      const result = await execute(...args)
      if (args[0].includes('INSERT INTO data_migration_source_rows')) throw new BackfillError('injected_archive_failure')
      return result
    }
    try { return await batch.execute(tx) } finally { tx.connection.execute = execute }
  }), { code: 'injected_archive_failure' })
  const [[rolledBack]] = await connection.execute(`SELECT
    (SELECT COUNT(*) FROM strategies WHERE id IN (31001,31002)) strategies,
    (SELECT COUNT(*) FROM strategy_versions WHERE id IN (41001,41002)) versions,
    (SELECT COUNT(*) FROM data_migration_id_maps WHERE created_run_id=?) maps,
    (SELECT COUNT(*) FROM data_migration_batches WHERE run_id=?) batches,
    (SELECT COUNT(*) FROM data_migration_row_receipts WHERE run_id=?) receipts,
    (SELECT COUNT(*) FROM data_migration_source_rows WHERE run_id=?) archives`, [batchRun,batchRun,batchRun,batchRun])
  assert.deepEqual({ ...rolledBack }, { strategies: 0, versions: 0, maps: 0, batches: 0, receipts: 0, archives: 0 })
  loseAck = true
  await assert.rejects(uncertain.transaction(tx => batch.execute(tx)), { code: 'backfill_commit_unknown' })
  assert.equal((await repository.transaction(tx => batch.execute(tx))).replayed, true)
  const checkpoint = await repository.transaction(tx => tx.findCheckpoint(batchRun, batch.streamId))
  assert.equal(checkpoint.sequence, 1); assert.equal(checkpoint.processedRows, '1')
  await connection.execute("UPDATE data_migration_source_rows SET source_payload_json=JSON_OBJECT('corrupted',true) WHERE run_id=?", [batchRun])
  await assert.rejects(repository.transaction(tx => batch.execute(tx)), { code: 'strategy_batch_evidence_conflict' })
  return { mapFailureRolledBackAllRows: true, sourceDriftRejected: true, committedAckLossRecovered: true,
    concurrentReplayInserted: 0, sourceFixture: 'named-columns-longtext',
    batch: { archiveFailureRolledBackSixTables: true, committedAckLossReplayed: true, checkpointRows: checkpoint.processedRows, corruptedArchiveRejected: true } }
}
