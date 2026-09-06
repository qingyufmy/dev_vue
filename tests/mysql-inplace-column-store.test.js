import { expect, it } from 'vitest'
import { withInplaceUpgradeLock } from '../scripts/lib/mysql-inplace-column-store.mjs'

function connection(acquired = 1, released = 1) {
  const calls = []
  return { calls, query: async () => [[{ db: 'dev_vue', id: 7 }]],
    execute: async sql => {
      calls.push(sql)
      return [[sql.includes('GET_LOCK') ? { acquired } : { released }]]
    } }
}
it('does not enter the upgrade when another process holds its lock', async () => {
  const c = connection(0)
  let entered = false
  await expect(withInplaceUpgradeLock(c, 'dev_vue', async () => { entered = true })).rejects.toThrow('inplace_upgrade_busy')
  expect(entered).toBe(false)
  expect(c.calls).toHaveLength(1)
})
it('releases the lock after work fails and preserves the original error', async () => {
  const c = connection(1, 0)
  await expect(withInplaceUpgradeLock(c, 'dev_vue', async () => { throw new Error('ddl_response_lost') })).rejects.toThrow('ddl_response_lost')
  expect(c.calls[1]).toContain('RELEASE_LOCK')
})
it('reports lock loss even when the callback returned successfully', async () => {
  await expect(withInplaceUpgradeLock(connection(1, 0), 'dev_vue', async () => 1)).rejects.toThrow('inplace_upgrade_lock_lost')
})
