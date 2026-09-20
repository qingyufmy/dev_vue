import { createCanonicalSubscriptionSourceBatch } from './subscription-canonical-source-batch.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { BackfillError, hash } from './v4-backfill-contract.mjs'
import { legacyStrategyFields, legacySubscriptionFields } from './v4-strategy-source-review.mjs'
import { MysqlBackfillRepository } from './v4-backfill-mysql-repository.mjs'
import { createSubscriptionSourceWriter } from './mysql-subscription-source-writer.mjs'
import { subscriptionBuildFixture } from './subscription-build-writer-reference.mjs'
import { createSubscriptionSourceBatch } from './subscription-source-batch.mjs'

export async function verifySubscriptionSourceWriteReference(connection, pool, { canonical = false } = {}) {
  const [[scope]] = await connection.query('SELECT DATABASE() db')
  assert.match(scope.db, /^dev_vue_strategy_ref_[0-9a-f]{32}$/)
  const sourceTable = canonical ? 'strategy_subscriptions_legacy_v3' : 'strategy_subscriptions'
  const targetName = table => canonical ? table.replace(/_v4_build$/, '') : table
  if (canonical) {
    const names = ['strategy_subscriptions', 'subscription_schedules', 'subscription_execution_preferences']
    const [present] = await connection.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')
    const available = new Set(present.map(row => row.name))
    for (const name of names) assert.ok(available.has(name + '_v4_build'))
    await connection.query('RENAME TABLE ' + names.flatMap(name => [
      ...(available.has(name) ? ['`' + name + '` TO `' + name + '_reference_original`'] : []),
      '`' + name + '_v4_build` TO `' + name + '`',
    ]).join(', '))
  }

  const [[rawStrategy]] = await connection.query(`SELECT ${legacyStrategyFields.map(field => `CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')} FROM auto_prompt_types WHERE id=21`)
  const strategySource = { ...rawStrategy }
  const source = Object.fromEntries(legacySubscriptionFields.map(field => [field, null]))
  Object.assign(source, { id: '31', user_id: '7', trading_account_id: '9', strategy_id: '21', symbols_json: null,
    execution_enabled: '0', is_deleted: '0', take_profit_mode: 'standard', created_at: '2026-09-09 00:00:00.123', updated_at: '2026-09-09 00:00:00.123' })
  const projections = ['EURUSD', 'XAUUSD'].map((symbol, i) => subscriptionBuildFixture('30001', '40001', {
    id: String(91001 + i), standard_symbol: symbol, legacy_id: `31:${symbol}`, trader_strategy_id: '30002', trader_strategy_version_id: '40002' }))
  const entry = { source, sourceHash: hash(source), strategySource, strategySourceHash: hash(strategySource), projections }
  const runId = randomUUID(), logicalSourceId = 'reference'
  const sourceFixtures = [source]
  let drift = false, loseAck = false
  const repository = new MysqlBackfillRepository({ async getConnection() {
    const db = await pool.getConnection()
    try {
      // Shadow only the legacy subscription source, whose runtime name is already used by V4 in this reference database.
      await db.query(`CREATE TEMPORARY TABLE ${sourceTable} (${legacySubscriptionFields.map(field =>
        field === 'id' ? 'id BIGINT UNSIGNED PRIMARY KEY' : `\`${field}\` LONGTEXT NULL`).join(',')}) ENGINE=InnoDB`)
      for (const sourceFixture of sourceFixtures) {
        const row = { ...sourceFixture, ...(drift ? { is_deleted: '1' } : {}) }
        await db.execute(`INSERT INTO ${sourceTable} (${legacySubscriptionFields.map(field => `\`${field}\``).join(',')})
          VALUES (${legacySubscriptionFields.map(() => '?').join(',')})`, legacySubscriptionFields.map(field => row[field]))
      }
      return new Proxy(db, { get(target, key) {
        // End the session on every return so its source shadow cannot leak to another pooled caller.
        if (key === 'release') return () => target.destroy()
        if (key === 'commit') return async () => { await target.commit(); if (loseAck) { loseAck = false; throw Error('injected_ack_loss') } }
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
      } })
    } catch (error) { db.destroy(); throw error }
  } })
  const writer = createSubscriptionSourceWriter([entry], { runId, logicalSourceId, namespace: canonical ? 'canonical' : 'build' })
  await repository.transaction(async tx => {
    await tx.insertRun(runId, { reference: true }, hash({ reference: true }))
    await tx.insertMapping(runId, logicalSourceId, { entityKind: 'trading_account', sourceTable: 'trading_accounts',
      sourcePk: [{ type: 'integer', value: '9' }], target: { table: 'trading_accounts', pk: [{ type: 'integer', value: '5' }] } })
  })
  const counts = async () => {
    const result = []
    for (const [table, key] of [['strategy_subscriptions_v4_build', 'id'], ['subscription_schedules_v4_build', 'subscription_id'],
      ['subscription_execution_preferences_v4_build', 'subscription_id']]) {
      const [[row]] = await connection.query(`SELECT COUNT(*) n FROM ${targetName(table)} WHERE ${key} IN (91001,91002)`); result.push(Number(row.n))
    }
    const [[maps]] = await connection.execute("SELECT COUNT(*) n FROM data_migration_id_maps WHERE created_run_id=? AND entity_kind LIKE 'subscription-%'", [runId])
    return [...result, Number(maps.n)]
  }
  const checks = []
  drift = true
  await assert.rejects(repository.transaction(tx => writer.write(tx, entry)), { code: 'subscription_source_changed' })
  drift = false
  assert.deepEqual(await counts(), [0, 0, 0, 0]); checks.push('source-drift-no-target-writes')
  await assert.rejects(repository.transaction(async tx => {
    const find = tx.findMapping.bind(tx)
    tx.findMapping = async (logical, mapping) => mapping.entityKind === 'trading_account' ? null : find(logical, mapping)
    return writer.write(tx, entry)
  }), { code: 'subscription_source_parent_mapping_conflict' })
  assert.deepEqual(await counts(), [0, 0, 0, 0]); checks.push('missing-account-map-no-target-writes')
  await assert.rejects(repository.transaction(async tx => {
    const insert = tx.insertMapping.bind(tx)
    tx.insertMapping = async (...args) => { await insert(...args); throw new BackfillError('injected_subscription_map_failure') }
    return writer.write(tx, entry)
  }), { code: 'injected_subscription_map_failure' })
  assert.deepEqual(await counts(), [0, 0, 0, 0]); checks.push('map-failure-rolls-back-six-target-rows')
  loseAck = true
  await assert.rejects(repository.transaction(tx => writer.write(tx, entry)), { code: 'backfill_commit_unknown' })
  assert.deepEqual(await counts(), [2, 2, 2, 2])
  const replay = await repository.transaction(tx => writer.write(tx, entry, { verifyOnly: true }))
  assert.equal(replay.inserted, 0); assert.equal(replay.mappingsInserted, 0)
  assert.ok(replay.idMaps.every(mapping => mapping.sourcePk[0].value === '31' && mapping.target.table === 'strategy_subscriptions'))
  assert.equal(new Set(replay.idMaps.map(mapping => mapping.entityKind)).size, 2)
  checks.push('commit-ack-loss-recovered-with-two-symbol-maps')
  const concurrent = await Promise.all([repository.transaction(tx => writer.write(tx, entry)), repository.transaction(tx => writer.write(tx, entry))])
  assert.ok(concurrent.every(result => result.inserted === 0 && result.mappingsInserted === 0))
  checks.push('concurrent-committed-replay-no-duplicates')
  const [[secondStrategy]] = await connection.query(`SELECT ${legacyStrategyFields.map(field => `CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')} FROM auto_prompt_types WHERE id=22`)
  const batchEntry = structuredClone(entry)
  batchEntry.source.id = '32'; batchEntry.source.strategy_id = '22'; batchEntry.sourceHash = hash(batchEntry.source)
  batchEntry.strategySource = { ...secondStrategy }; batchEntry.strategySourceHash = hash(batchEntry.strategySource)
  for (const [i, projection] of batchEntry.projections.entries()) {
    Object.assign(projection.subscription, { id: String(92001 + i), legacy_id: `32:${projection.subscription.standard_symbol}`,
      analysis_strategy_id: '31001', analysis_strategy_version_id: '41001', trader_strategy_id: '31002', trader_strategy_version_id: '41002' })
    projection.schedule.subscription_id = projection.subscription.id
    projection.preferences.subscription_id = projection.subscription.id
  }
  sourceFixtures.push(batchEntry.source)
  const batchRun = randomUUID(), bindings = { logicalSourceId, fixture: true }
  const batch = (canonical ? createCanonicalSubscriptionSourceBatch : createSubscriptionSourceBatch)([batchEntry], { runId: batchRun, logicalSourceId, bindings, sequence: 1, startCursor: null })
  await repository.transaction(async tx => {
    await tx.insertRun(batchRun, bindings, hash(bindings)); await tx.insertCheckpoint(batchRun, batch.streamId)
  })
  await assert.rejects(repository.transaction(async tx => {
    const execute = tx.connection.execute.bind(tx.connection)
    tx.connection.execute = async (...args) => {
      const result = await execute(...args)
      if (args[0].includes('INSERT INTO data_migration_source_rows')) throw new BackfillError('injected_subscription_archive_failure')
      return result
    }
    try { return await batch.execute(tx) } finally { tx.connection.execute = execute }
  }), { code: 'injected_subscription_archive_failure' })
  const [[rolledBack]] = await connection.execute(`SELECT
    (SELECT COUNT(*) FROM ${targetName('strategy_subscriptions_v4_build')} WHERE id IN (92001,92002)) subscriptions,
    (SELECT COUNT(*) FROM ${targetName('subscription_schedules_v4_build')} WHERE subscription_id IN (92001,92002)) schedules,
    (SELECT COUNT(*) FROM ${targetName('subscription_execution_preferences_v4_build')} WHERE subscription_id IN (92001,92002)) preferences,
    (SELECT COUNT(*) FROM data_migration_id_maps WHERE created_run_id=?) maps,
    (SELECT COUNT(*) FROM data_migration_batches WHERE run_id=?) batches,
    (SELECT COUNT(*) FROM data_migration_row_receipts WHERE run_id=?) receipts,
    (SELECT COUNT(*) FROM data_migration_source_rows WHERE run_id=?) archives`, [batchRun, batchRun, batchRun, batchRun])
  assert.ok(Object.values(rolledBack).every(count => Number(count) === 0))
  const before = await repository.transaction(tx => tx.findCheckpoint(batchRun, batch.streamId))
  assert.equal(before.sequence, 0); assert.equal(before.processedRows, '0')
  checks.push('archive-failure-rolls-back-seven-tables-and-checkpoint')
  loseAck = true
  await assert.rejects(repository.transaction(tx => batch.execute(tx)), { code: 'backfill_commit_unknown' })
  assert.equal((await repository.transaction(tx => batch.execute(tx))).replayed, true)
  const checkpoint = await repository.transaction(tx => tx.findCheckpoint(batchRun, batch.streamId))
  assert.equal(checkpoint.sequence, 1); assert.equal(checkpoint.processedRows, '1')
  assert.deepEqual(checkpoint.cursor, [{ type: 'integer', value: '32' }])
  checks.push('batch-ack-loss-replays-one-source-row-and-six-targets')
  if (canonical) {
    const [[receipt]] = await connection.execute('SELECT targets_json FROM data_migration_row_receipts WHERE run_id=?', [batchRun])
    const targets = typeof receipt.targets_json === 'string' ? JSON.parse(receipt.targets_json) : receipt.targets_json
    assert.equal(targets.length, 6)
    assert.deepEqual([...new Set(targets.map(row => row.table))].sort(), ['strategy_subscriptions', 'subscription_execution_preferences', 'subscription_schedules'].sort())
    checks.push('canonical-receipts-reference-existing-three-target-tables')
  }

  await connection.execute('UPDATE data_migration_checkpoints SET sequence_number=0 WHERE run_id=? AND stream_id=?', [batchRun, batch.streamId])
  await assert.rejects(repository.transaction(tx => batch.execute(tx)), { code: 'subscription_batch_checkpoint_conflict' })
  await connection.execute('UPDATE data_migration_checkpoints SET sequence_number=1 WHERE run_id=? AND stream_id=?', [batchRun, batch.streamId])
  checks.push('committed-receipt-with-regressed-checkpoint-rejected')
  await connection.execute("UPDATE data_migration_source_rows SET source_payload_json=JSON_OBJECT('corrupted',true) WHERE run_id=?", [batchRun])
  await assert.rejects(repository.transaction(tx => batch.execute(tx)), { code: 'subscription_batch_evidence_conflict' })
  checks.push('changed-source-archive-rejected-on-replay')
  return { passed: true, namespace: canonical ? 'canonical' : 'build', checks, sourceFixture: 'session-local named legacy columns; strategy source and ID maps use real reference tables',
    targetRows: 12, subscriptionMaps: 4, batchSourceRows: checkpoint.processedRows, historicalBackfillProven: false }
}
