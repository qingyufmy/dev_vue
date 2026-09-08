import { Readable } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { sha256 } from '../scripts/lib/v4-migration-plan.mjs'
const state = vi.hoisted(() => ({ snapshot: null }))
vi.mock('../scripts/lib/mysql-account-root-snapshot.mjs', () => ({ readAccountRootSnapshot: async () => state.snapshot }))
import { verifyCurrentWaveState } from '../scripts/lib/current-account-wave-state.mjs'
function fixture() {
  const ledger = ['data_migration_runs', 'data_migration_checkpoints', 'data_migration_batches', 'data_migration_id_maps', 'data_migration_row_receipts', 'data_migration_source_rows']
  const build = ['trading_accounts_v4_build', 'user_trading_account_settings_v4_build', 'trading_account_ownership_intervals_v4_build', 'trading_account_ownerships_v4_build']
  const names = ['users', ...ledger, ...build]
  state.snapshot = { tables: names.map(name => ({ name, rows: 0, rowsSha256: sha256(''), ddl: name })),
    metadata: new Map(names.map(name => [name, { columns: ['id'], primary: ['id'], metadata: [{ column_name: 'id', data_type: 'int' }] }])) }
  const baseline = { tables: state.snapshot.tables.map(({ name, rows, rowsSha256, ddl }) => ({ name, rows, rowsSha256, ddlSha256: sha256(ddl) })) }
  const actual = new Map(build.map(name => [name, []]))
  const connection = { connection: { query: () => ({ stream: () => Readable.from([]) }) }, query: async sql => {
    const table = /FROM `([^`]+)`/.exec(sql)[1]; return [actual.get(table)]
  } }
  const prepared = [{ batches: [{ rows: [{ payload: { entity: { id: '1' }, settings: { id: '1' }, interval: { id: '1' }, grant: { id: '1' } } }] }] }]
  return { baseline, actual, connection, prepared, verify: complete => verifyCurrentWaveState(connection, baseline, ['run-one', 'run-two'], prepared, complete) }
}
test('allows empty partial projections but requires all rows at completion', async () => {
  const f = fixture(); await expect(f.verify(false)).resolves.toMatchObject({ protectedTables: 1, priorLedgerTablesPreserved: 6 })
  await expect(f.verify(true)).rejects.toThrow()
})
test('rejects unexpected target rows before adding anything', async () => {
  const f = fixture(); f.actual.set('trading_accounts_v4_build', [{ id: '2' }]); await expect(f.verify(false)).rejects.toThrow()
})
test('rejects altered target fields on an expected key', async () => {
  const f = fixture(); f.actual.set('trading_accounts_v4_build', [{ id: '1', other: 'changed' }]); await expect(f.verify(false)).rejects.toThrow()
})
test('accepts exact completed projections', async () => {
  const f = fixture(); for (const name of f.actual.keys()) f.actual.set(name, [{ id: '1' }]); await expect(f.verify(true)).resolves.toBeDefined()
})
test('rejects altered protected rows', async () => {
  const f = fixture(); state.snapshot.tables[0].rowsSha256 = sha256('changed'); await expect(f.verify(false)).rejects.toThrow()
})
test('rejects missing historical ledger rows', async () => {
  const f = fixture(); f.baseline.tables.find(table => table.name === 'data_migration_runs').rows = 1; await expect(f.verify(false)).rejects.toThrow()
})
test('database-derived generated columns do not become writable projection fields', async () => {
  const f = fixture()
  for (const name of f.actual.keys()) f.actual.set(name, [{ id: '1' }])
  state.snapshot.metadata.get('trading_account_ownership_intervals_v4_build').metadata.push({ column_name: 'open_owner_account_id', data_type: 'int', extra: 'VIRTUAL GENERATED' })
  const original = f.connection.query
  f.connection.query = async sql => {
    const result = await original(sql)
    if (sql.includes('open_owner_account_id')) result[0][0].open_owner_account_id = '1'
    return result
  }
  await expect(f.verify(true)).resolves.toBeDefined()
})
