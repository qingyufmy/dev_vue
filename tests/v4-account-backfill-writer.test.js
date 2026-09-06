import { expect, it } from 'vitest'
import { hash, canonical } from '../scripts/lib/v4-backfill-contract.mjs'
import { planAccountIdMappings } from '../scripts/lib/v4-account-id-mapping.mjs'
import { createAccountBackfill } from '../scripts/lib/v4-account-backfill-writer.mjs'
import { executeBackfillBatch } from '../scripts/lib/v4-backfill-runner.mjs'
function fixture(batchSize = 1) {
  const rows = ['2', '10'].map((id, i) => ({ id, user_id: String(i + 1), broker_server: 'Broker', login_account: '00123', nickname: i ? null : "O'Brien",
    margin_mode: 'hedging', review_status: 'approved', observe_status: 'active', is_deleted: '0', created_at: `2026-09-0${i + 1} 08:00:00`,
    updated_at: `2026-09-0${i + 3} 08:00:00`, observed_until: null, identity_verified_at: null, first_verified_at: null, anomaly_code: null }))
  const evidence = row => ({ ...row, sourceHash: hash(row) })
  const input = { accounts: rows.map(row => evidence({ id: row.id, userId: row.user_id, server: row.broker_server, login: row.login_account })),
    terminals: rows.map(row => evidence({ id: 'terminal' + row.id, userId: row.user_id, platform: 'mt5', server: row.broker_server, login: row.login_account })),
    bindings: [evidence({ server: 'BROKER', login: '00123', currentUserId: '1', currentAccountId: '2', currency: 'USD' })] }
  const plan = planAccountIdMappings('fixture', input, ['2', '10'])
  return createAccountBackfill(rows, plan, { userIds: new Set(['1', '2']), timeBasis: { sourceTable: 'trading_accounts', offsetMinutes: 480, evidenceId: 'fixture-only' } }, { batchSize })
}
function database() {
  const data = new Map(), calls = []
  return { data, calls, async execute(sql, values) {
    calls.push({ sql, values })
    const table = /(?:FROM|INTO) `([^`]+)`/.exec(sql)[1]
    if (sql.startsWith('INSERT')) {
      const columns = /\(([^)]+)\) VALUES/.exec(sql)[1].split(',').map(value => value.replaceAll('`', ''))
      const row = Object.fromEntries(columns.map((name, i) => [name, values[i]]))
      const key = table + ':' + (row.id ?? `${row.user_id}:${row.trading_account_id}`)
      if (data.has(key)) throw new Error('duplicate')
      data.set(key, row); return [{ affectedRows: 1 }]
    }
    const row = data.get(table + ':' + values.join(':'))
    if (!row) return [[]]
    return [[Object.fromEntries(Object.entries(row).map(([name, value]) => [name, name.endsWith('_utc') && value !== null ? value + '000' : value]))]]
  } }
}
it('computes shared entities before pagination and preserves final logical mapping references', () => {
  const a = fixture(1), b = fixture(2)
  expect(a.batches).toHaveLength(2); expect(b.batches).toHaveLength(1)
  expect(a.transformHash).toBe(b.transformHash)
  expect(a.batches[0].rows[0].payload.entity).toEqual(a.batches[1].rows[0].payload.entity)
  expect(a.batches[0].rows[0].payload.entity.updated_at_utc).toBe('2026-09-04 00:00:00.000')
  expect(a.batches[1].startCursor).toEqual(a.batches[0].endCursor)
  expect(a.batches[1].rows[0].idMaps[0].target).toEqual({ table: 'trading_accounts', pk: [{ type: 'integer', value: '2' }] })
})
it('inserts a shared entity once, preserves exact settings, and only writes physical working tables', async () => {
  const { batches, writer } = fixture(), db = database()
  for (const batch of batches) await writer.write(db, batch.rows[0])
  await writer.write(db, batches[0].rows[0])
  const inserts = db.calls.filter(call => call.sql.startsWith('INSERT'))
  expect(inserts).toHaveLength(3); expect(db.data.size).toBe(3)
  expect(inserts.every(call => /INTO `(?:trading_accounts|user_trading_account_settings)_v4_build`/.test(call.sql))).toBe(true)
  expect(db.calls.every(call => !call.sql.includes("O'Brien"))).toBe(true)
  expect(db.calls.filter(call => call.sql.startsWith('SELECT')).every(call => call.sql.endsWith('FOR UPDATE'))).toBe(true)
  expect(db.data.get('user_trading_account_settings_v4_build:2:2').nickname).toBeNull()
})
it('rejects conflicting existing content without UPDATE or replacement', async () => {
  const { batches, writer } = fixture(), db = database()
  await writer.write(db, batches[0].rows[0])
  db.data.get('trading_accounts_v4_build:2').currency = 'EUR'
  const previous = db.calls.length
  await expect(writer.write(db, batches[1].rows[0])).rejects.toThrow('account_writer_target_conflict')
  expect(db.calls.slice(previous).every(call => call.sql.startsWith('SELECT'))).toBe(true)
})
it('rejects modified returned payload even if its public checksum is recalculated', async () => {
  const { batches, writer } = fixture(), db = database(), row = batches[0].rows[0]
  row.payload.settings.hidden = '1'; row.transformedHash = hash({ payload: row.payload, targets: row.targets })
  await expect(writer.write(db, row)).rejects.toThrow('account_writer_row_mismatch')
  expect(db.calls).toHaveLength(0)
})
it('detects storage coercion in the actual post-insert readback', async () => {
  const { batches, writer } = fixture(), db = database(), execute = db.execute.bind(db)
  db.execute = async (sql, values) => {
    const result = await execute(sql, values)
    if (sql.startsWith('SELECT') && result[0].length) result[0][0].account_login = '123'
    return result
  }
  await expect(writer.write(db, batches[0].rows[0])).rejects.toThrow('account_writer_readback_mismatch')
  expect(canonical(batches[0].rows[0].payload.entity)).toContain('00123')
})
it('commits business rows, mappings and receipts together and rolls all back on a later row failure', async () => {
  const built = fixture(2), batch = built.batches[0]
  const spec = { runId: '11111111-1111-1111-1111-111111111111', admission: { approved: true, blockers: [] },
    bindings: { logicalSourceId: 'fixture', sourceDatabase: 'dev_vue', mirrorDatabase: 'frozen', snapshotHash: 'a'.repeat(64),
      targetServerUuid: '22222222-2222-2222-2222-222222222222', targetDatabase: 'dev_vue', schemaHash: 'b'.repeat(64),
      manifestHash: 'c'.repeat(64), transformHash: built.transformHash, streams: [built.stream], storageMode: 'inplace-account-v1' } }
  let state = { business: [], maps: [], receipts: [], batch: null, checkpoint: { sequence: 0, cursor: null, processedRows: '0' } }, fail = true
  const repository = { async transaction(work) {
    const next = structuredClone(state), db = database()
    for (const [key, value] of next.business) db.data.set(key, value)
    const execute = db.execute.bind(db)
    db.execute = async (sql, values) => {
      if (fail && sql.startsWith('INSERT INTO `user_trading_account_settings_v4_build`') && values[0] === '2') throw new Error('fixture_late_failure')
      return execute(sql, values)
    }
    const result = await work({ connection: db,
      targetIdentity: async () => ({ serverUuid: spec.bindings.targetServerUuid, database: 'dev_vue', schemaHash: spec.bindings.schemaHash, storageMode: 'inplace-account-v1' }),
      findRun: async () => ({ bindings: spec.bindings, bindingsHash: hash(spec.bindings) }),
      findBatch: async () => next.batch, findCheckpoint: async () => next.checkpoint,
      insertBatch: async (_run, value) => { next.batch = value }, findReceipt: async () => null,
      findMapping: async (_source, mapping) => next.maps.find(item => canonical(item.sourcePk) === canonical(mapping.sourcePk)),
      insertMapping: async (_run, _source, mapping) => { next.maps.push(mapping) },
      insertReceipt: async (_run, _stream, _batch, row) => { next.receipts.push(row.sourceHash) },
      advanceCheckpoint: async (_run, _stream, _previous, sequence, cursor, processedRows) => { next.checkpoint = { sequence, cursor, processedRows } },
    })
    next.business = [...db.data]; state = next; return result
  } }
  await expect(executeBackfillBatch(repository, spec, batch, built.writer)).rejects.toThrow('fixture_late_failure')
  expect(state).toMatchObject({ business: [], maps: [], receipts: [], batch: null, checkpoint: { sequence: 0 } })
  fail = false
  await expect(executeBackfillBatch(repository, spec, batch, built.writer)).resolves.toMatchObject({ status: 'committed', rows: 2 })
  expect(state.business).toHaveLength(3); expect(state.maps).toHaveLength(2); expect(state.receipts).toHaveLength(2)
  expect(state.checkpoint.processedRows).toBe('2')
  const saved = canonical(state)
  await executeBackfillBatch(repository, spec, batch, built.writer)
  expect(canonical(state)).toBe(saved)
})
