import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadTradingContextChanges } from './inplace-trading-context-changes.mjs'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'

export async function loadObserverRegistrySeed(root) {
  const prior = await loadTradingContextChanges(root)
  assert.equal(prior.steps.length, 165)
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/042_observer_registry_seed.sql', root), 'utf8'))
  assert.deepEqual(statements, ['INSERT INTO observer_management_registry (id,revision) VALUES (1,0)'])
  const body = { id: 'inplace_042_01_observer_management_registry_seed', sql: statements[0],
    protocol: 'observer-registry-seed/v1', priorRegistryHash: hash(prior.steps.map(({ id, checksum }) => ({ id, checksum }))) }
  return { prior, step: { ...body, checksum: hash(body) } }
}

// Caller holds the database upgrade advisory lock. Runtime management takes the same registry row lock.
// Seed and ledger commit atomically; an uncertain commit is inspected, never repaired by resetting revision.
export async function coordinateObserverRegistrySeed(connection, plan, { apply = false, beforeCommit = async () => {} } = {}) {
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.beginTransaction()
  try {
    const [history] = await connection.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id LIMIT 1001')
    const byId = new Map(history.map(row => [row.id, row]))
    assert.ok(history.length <= 1000 && history.length === byId.size && history.every(row => row.status === 'completed'), 'observer_seed_history_invalid')
    assert.ok(plan.prior.steps.every(step => byId.get(step.id)?.checksum === step.checksum), 'observer_seed_prior_history_invalid')
    const recorded = byId.get(plan.step.id)
    assert.ok(!recorded || recorded.checksum === plan.step.checksum, 'observer_seed_checksum_invalid')
    const [rows] = await connection.query('SELECT id,CAST(revision AS CHAR) revision FROM observer_management_registry WHERE id=1 FOR UPDATE')
    assert.ok(rows.length <= 1, 'observer_seed_registry_invalid')
    const existing = rows[0]
    if (existing) assert.ok(existing.id === 1 && /^(0|[1-9][0-9]*)$/.test(existing.revision)
      && BigInt(existing.revision) < BigInt(Number.MAX_SAFE_INTEGER), 'observer_seed_revision_invalid')
    assert.ok(!recorded || existing, 'observer_seed_completed_row_missing')
    const [counts] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM observer_sources) sources,
      (SELECT COUNT(*) FROM observer_channels) channels,
      (SELECT COUNT(*) FROM observer_channel_accesses) grants,
      (SELECT COUNT(*) FROM observer_management_operations) operations,
      (SELECT COUNT(*) FROM outbox_events WHERE aggregate_type='observer_management' OR event_type='observer.authorization.changed') events`)
    if (!existing) assert.ok(Object.values(counts[0]).every(value => String(value) === '0'), 'observer_seed_missing_with_history')
    const result = { state: recorded ? 'complete' : 'pending', inserted: false, journalWritten: false,
      revision: existing?.revision ?? null, counts: counts[0], priorHistoryHash: hash(history), completedSteps: history.length }
    if (apply && !recorded) {
      if (!existing) { await connection.query(plan.step.sql); result.inserted = true; result.revision = '0' }
      await connection.execute(`INSERT INTO database_upgrade_steps_v4
        (id,checksum_sha256,status,started_at_utc,completed_at_utc) VALUES (?,?,'completed',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
      [plan.step.id, plan.step.checksum])
      result.journalWritten = true; result.completedSteps++; result.state = 'complete'
      await beforeCommit()
      await connection.commit()
    } else await connection.rollback()
    return result
  } catch (error) { await connection.rollback().catch(() => {}); throw error }
}
