import { expect, test } from 'vitest'
import { withAccountSourceFreeze } from '../scripts/lib/account-source-freeze.mjs'
const sources = ['bridge_v3_terminal_sessions', 'mt5_account_bindings', 'mt5_account_ownership_history', 'trading_accounts', 'users']
function fake() {
  const events = [], state = { held: true, rollbackFails: false, missingKey: false }
  return { events, state, connection: {
    async query(sql) {
      if (sql.startsWith('SELECT DATABASE()')) return [[{ db: 'dev_vue', uuid: 'ac423207-6ef3-11f1-b302-000c29fda104', connectionId: 1 }]]
      if (sql.includes('information_schema.STATISTICS')) return [sources.filter(name => !state.missingKey || name !== 'users').map(tableName => ({ tableName, columnName: 'id', ordinalPosition: 1 }))]
      events.push(sql); return [[{ id: 1 }]]
    },
    async execute() { return [[{ n: state.held ? 1 : 0 }]] },
    async beginTransaction() { events.push('begin') },
    async rollback() { events.push('rollback'); if (state.rollbackFails) throw Error('network') },
    destroy() { events.push('destroy') },
  } }
}
test('releases range locks when the protected operation fails', async () => {
  const f = fake()
  await expect(withAccountSourceFreeze(f.connection, 'dev_vue', async () => { throw Error('operation_failed') })).rejects.toThrow('operation_failed')
  expect(f.events.at(-1)).toBe('rollback')
  expect(f.events.filter(event => event.endsWith('FOR SHARE'))).toHaveLength(5)
})
test('refuses work after the locking transaction is lost', async () => {
  const f = fake(); f.state.held = false
  let invoked = false
  await expect(withAccountSourceFreeze(f.connection, 'dev_vue', async () => { invoked = true })).rejects.toThrow('transaction_lost')
  expect(invoked).toBe(false); expect(f.events.at(-1)).toBe('rollback')
})
test('a retained guard cannot be used after release', async () => {
  const f = fake(); let held
  await withAccountSourceFreeze(f.connection, 'dev_vue', async guard => { held = guard })
  await expect(held.assertHeld()).rejects.toThrow('released')
})
test('destroy releases the connection when rollback fails', async () => {
  const f = fake(); f.state.rollbackFails = true
  await expect(withAccountSourceFreeze(f.connection, 'dev_vue', async () => {})).rejects.toThrow('release_failed')
  expect(f.events.at(-1)).toBe('destroy')
})
test('rejects missing primary keys before beginning a transaction', async () => {
  const f = fake(); f.state.missingKey = true
  await expect(withAccountSourceFreeze(f.connection, 'dev_vue', async () => {})).rejects.toThrow('primary_key_required')
  expect(f.events).not.toContain('begin')
})
