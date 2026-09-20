import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createMysqlOpenPositionLifecycleReader } from '../../server/dist-v4/modules/trade-history/composition.js'
import { canonicalEvidence } from '../../server/dist-v4/modules/trade-history/index.js'
import { createMysqlStrategyReferenceSourceReader } from '../../server/dist-v4/modules/inference/composition.js'

export async function verifyOpenPositionLifecycleReference(admin, pool) {
  const at = Date.parse('2026-09-10T00:00:00.000Z')
  const base = { position_id: '97000', symbol: 'XAUUSD', price: '2500' }
  const entry = { ...base, ticket: '97001', order: '98001', type: 'buy', entry: 'in', volume: '1', time_msc: at - 2000 }
  const exit = { ...base, ticket: '97002', order: '98002', type: 'sell', entry: 'out', volume: '0.5', time_msc: at - 1000 }
  async function insert(raw) {
    const evidence = canonicalEvidence(raw), time = new Date(raw.time_msc)
    await admin.execute(`INSERT INTO terminal_history_deals_v4
      (id,trading_account_id,platform,deal_ticket,order_ticket,position_id,symbol,deal_kind,entry_kind,side,
       volume,price,occurred_at_utc,terminal_timezone_offset_minutes,evidence_sha256,evidence_json,
       observed_at_utc,created_at_utc,updated_at_utc)
      VALUES (?,5,'mt5',?,?,?,'XAUUSD','trade',?,?,?,?,?,180,?,?,?,?,?)`,
      [randomUUID(),raw.ticket,raw.order,raw.position_id,raw.entry,raw.type,raw.volume,raw.price,time,evidence.hash,evidence.json,time,time,time])
  }
  await insert(entry)
  const scope = { userId: 7, analysisId: 'reference', analysisStrategyId: '10', symbol: 'XAUUSD', asOf: new Date(at).toISOString() }
  const inventory = { analysisStrategyId: '10', authorization: { userId: 7, accountId: '5', operatorUserId: 7 },
    route: { userId: 7, accountId: '5', platform: 'mt5' }, observedAt: scope.asOf,
    positions: { revision: 1, observedAt: scope.asOf, items: [{ ticket: '97003', positionIdentifier: '97000', accountId: '5', symbol: 'XAUUSD', side: 'buy', volume: '1', revision: 1 }] },
    pendingOrders: { revision: 1, items: [] } }
  let inserted = false
  const reader = createMysqlStrategyReferenceSourceReader(pool,
    () => ({ async read() {
      if (!inserted) { await insert(exit); inserted = true }
      return structuredClone(inventory)
    } }),
    connection => ({ async read() {
      // Establish the actual database snapshot before a second connection commits a backdated deal.
      await connection.execute('SELECT COUNT(*) FROM terminal_history_deals_v4 WHERE trading_account_id=5')
      return { analysisId: scope.analysisId, sourceAccountId: '5' }
    } }), undefined, createMysqlOpenPositionLifecycleReader)
  const first = await reader.read(scope)
  assert.equal(first.positionLifecycles.items[0].lifecycle.status, 'matches_snapshot')
  assert.deepEqual(first.positionLifecycles.items[0].lifecycle.dealTickets, ['97001'])
  inventory.positions.items[0].volume = '0.5'
  const second = await reader.read(scope)
  assert.equal(second.positionLifecycles.items[0].lifecycle.status, 'matches_snapshot')
  assert.deepEqual(second.positionLifecycles.items[0].lifecycle.dealTickets, ['97001','97002'])
  const connection = await pool.getConnection()
  try {
    await connection.query("SET SESSION time_zone='+08:00'")
    const history = createMysqlOpenPositionLifecycleReader(connection)
    const query = { accountId: '5', positionIdentifier: '97000', symbol: 'XAUUSD', side: 'buy', volume: '0.5', observedAtUtcMsc: at }
    assert.deepEqual(await history.read(query), second.positionLifecycles.items[0].lifecycle)
    assert.equal((await history.read({ ...query, volume: '1', observedAtUtcMsc: at-1500 })).status, 'matches_snapshot')
    await admin.execute("UPDATE terminal_history_deals_v4 SET evidence_sha256=REPEAT('f',64) WHERE trading_account_id=5 AND deal_ticket='97001'")
    await assert.rejects(history.read(query), /history_lifecycle_fact_corrupt/)
  } finally { connection.release() }
  return { passed: true, authorization: 'injected-inventory-and-source', actualMysqlSnapshot: true,
    checks: ['concurrent-commit-excluded-from-original-snapshot','new-snapshot-sees-committed-exit','utc-independent-of-session-offset','observation-cutoff','corrupt-evidence-rejected'] }
}
