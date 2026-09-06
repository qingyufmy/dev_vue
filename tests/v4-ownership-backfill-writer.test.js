import { expect, it } from 'vitest'
import { createOwnershipBackfill } from '../scripts/lib/v4-ownership-backfill-writer.mjs'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
const options = { logicalSourceId: 'fixture', accountMap: new Map([
  ['1', { targetAccountId: '10', brokerServerKey: 'BROKER', accountLogin: '00123' }],
]), userIds: new Set(['1', '2']), timeBasis: { sourceTable: 'mt5_account_ownership_history', offsetMinutes: 0, evidenceId: 'fixture-only' } }
const interval = (id, user, start, end) => ({ id, broker_server_key: 'BROKER', login_account: '00123', user_id: user, trading_account_id: '1',
  started_at: `2020-01-0${start} 00:00:00`, ended_at: end ? `2020-01-0${end} 00:00:00` : null, end_reason: end ? 'transfer' : null,
  created_at: `2020-01-0${start} 00:00:00`, updated_at: `2020-01-0${end ?? start} 00:00:00` })
const rows = [interval('1', '1', 1, 2), interval('2', '2', 2, 3), interval('3', '1', 3, null)]
const build = (input = rows, batchSize = 1) => createOwnershipBackfill(input, options, { batchSize, expectedSourceIds: rows.map(row => row.id) })
function store() {
  const state = new Map(), calls = []
  return { state, calls, async execute(sql, values) {
    calls.push(sql)
    const table = /(?:FROM|INTO) `([^`]+)`/.exec(sql)[1]
    if (sql.startsWith('INSERT')) {
      const names = /\(([^)]+)\) VALUES/.exec(sql)[1].split(',').map(name => name.replaceAll('`', ''))
      const row = Object.fromEntries(names.map((name, i) => [name, values[i]]))
      if (table === 'trading_account_ownerships_v4_build') {
        const parent = state.get('trading_account_ownership_intervals_v4_build:' + row.interval_id)
        if (!parent || parent.user_id !== row.user_id || parent.trading_account_id !== row.trading_account_id || parent.role !== row.role) throw Error('fixture_fk_failed')
      }
      const key = table + ':' + (row.id ?? `${row.user_id}:${row.trading_account_id}:${row.role}`)
      if (state.has(key)) throw Error('fixture_duplicate')
      state.set(key, row); return [{ affectedRows: 1 }]
    }
    const row = state.get(table + ':' + values.join(':'))
    return [row ? [Object.fromEntries(Object.entries(row).map(([name, value]) => [name, name.endsWith('_utc') && value !== null ? value + '000' : value]))] : []]
  } }
}
it('does not issue an intermediate grant and associates each final grant with its own interval', async () => {
  const built = build(), db = store()
  expect(built.batches[0].rows[0].payload.grant).toBeNull()
  expect(built.grantCount).toBe(2)
  for (const batch of built.batches) await built.writer.write(db, batch.rows[0])
  expect(db.state.size).toBe(5)
  expect(db.state.get('trading_account_ownerships_v4_build:1:10:owner').revoked_at_utc).toBeNull()
  expect(db.state.get('trading_account_ownerships_v4_build:2:10:owner').revoked_at_utc).toBe('2020-01-03 00:00:00.000')
  expect(built.batches.flatMap(batch => batch.rows).map(row => row.payload.provenance.source)).toEqual(rows)
})
it('uses the same complete-history result for every page size and input order', () => {
  const a = build(), b = build([...rows].reverse(), 3)
  expect(a.transformHash).toBe(b.transformHash)
  expect(a.batches.flatMap(batch => batch.rows)).toEqual(b.batches[0].rows)
  expect(() => build(rows.slice(1))).toThrow('ownership_writer_source_incomplete')
})
it('preserves zero-length evidence without overwriting an open owner grant', () => {
  const input = [interval('1', '1', 1, null), interval('2', '1', 2, 2)]
  const built = createOwnershipBackfill(input, options, { expectedSourceIds: ['1', '2'] })
  expect(built.batches[0].rows[0].payload.grant.revoked_at_utc).toBeNull()
  expect(built.batches[0].rows[1].payload.grant).toBeNull()
})
it('reuses identical committed rows and refuses a conflicting existing grant', async () => {
  const built = build(), db = store(), row = built.batches[2].rows[0]
  await built.writer.write(db, row)
  const inserts = db.calls.filter(sql => sql.startsWith('INSERT')).length
  await built.writer.write(db, row)
  expect(db.calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(inserts)
  db.state.get('trading_account_ownerships_v4_build:1:10:owner').revoked_at_utc = '2020-01-04 00:00:00.000'
  await expect(built.writer.write(db, row)).rejects.toThrow('account_writer_target_conflict')
})
it('rejects public payload tampering before SQL even with a recalculated checksum', async () => {
  const built = build(), db = store(), row = built.batches[2].rows[0]
  row.payload.grant.user_id = '2'; row.transformedHash = hash({ payload: row.payload, targets: row.targets })
  await expect(built.writer.write(db, row)).rejects.toThrow('ownership_writer_row_mismatch')
  expect(db.calls).toHaveLength(0)
})
