import { describe, expect, it } from 'vitest'
import { withAccountRootWriteFreeze } from '../scripts/lib/account-root-write-freeze.mjs'

function fixture() {
  const state = { names: ['accounts', 'journal'], locked: false, destroyed: false, unlocks: 0, lockFailure: false,
    releaseFailure: false, duration: 'TRANSACTION', lockType: 'SHARED_NO_READ_WRITE', watcherId: 2 }
  const uuid = 'ac423207-6ef3-11f1-b302-000c29fda104'
  const connection = {
    async query(sql) {
      if (sql.startsWith('SELECT DATABASE()')) return [[{ db: 'dev_vue', uuid, connectionId: 1, autoCommit: 1 }]]
      if (sql.includes('information_schema.TABLES')) return [state.names.map(name => ({ name, kind: 'BASE TABLE', engine: 'InnoDB' }))]
      if (sql.startsWith('SET SESSION')) return []
      if (sql.startsWith('LOCK TABLES')) { state.locked = true; if (state.lockFailure) throw Error('acquire_unknown'); return [] }
      if (sql === 'UNLOCK TABLES') { state.unlocks++; if (state.releaseFailure) throw Error('release_unknown'); state.locked = false; return [] }
      throw Error('unexpected_query')
    },
    destroy() { state.destroyed = true },
  }
  const observer = {
    async query() { return [[{ db: 'dev_vue', uuid, connectionId: state.watcherId }]] },
    async execute(_sql, values) {
      expect(values).toEqual(['dev_vue', 1])
      return [state.locked ? state.names.map(name => ({ name, lockType: state.lockType, duration: state.duration })) : []]
    },
  }
  const run = work => withAccountRootWriteFreeze(connection, observer, 'dev_vue', ['accounts', 'journal'], work)
  return { state, run }
}

describe('account root DDL write freeze', () => {
  it('accepts transferred names and releases successful work', async () => {
    const { state, run } = fixture()
    await run(async held => {
      state.names = ['accounts_legacy', 'journal']; state.duration = 'EXPLICIT'
      await held.assertHeld(state.names)
    })
    expect(state.locked).toBe(false); expect(state.unlocks).toBe(1)
  })
  it('releases locks when work fails', async () => {
    const { state, run } = fixture()
    await expect(run(async () => { throw Error('work_failed') })).rejects.toThrow('work_failed')
    expect(state.locked).toBe(false)
  })
  it('releases after an ambiguous acquisition failure', async () => {
    const { state, run } = fixture(); state.lockFailure = true
    await expect(run(async () => {})).rejects.toThrow('acquire_unknown')
    expect(state.locked).toBe(false)
  })
  it('destroys the dedicated connection if release fails', async () => {
    const { state, run } = fixture(); state.releaseFailure = true
    await expect(run(async () => {})).rejects.toThrow('account_root_freeze_release_failed')
    expect(state.destroyed).toBe(true)
  })
  it('rejects missing or weaker metadata locks', async () => {
    for (const change of [state => { state.locked = false }, state => { state.lockType = 'SHARED_READ' }]) {
      const { state, run } = fixture()
      await expect(run(async held => { change(state); await held.assertHeld() })).rejects.toThrow('account_root_freeze_lock_lost')
    }
  })
  it('rejects unexpected table creation during the window', async () => {
    const { state, run } = fixture()
    await expect(run(async held => { state.names.push('extra'); await held.assertHeld() })).rejects.toThrow('account_root_freeze_table_set')
  })
  it('rejects stale guards after release', async () => {
    const { run } = fixture(); let guard
    await run(async held => { guard = held })
    await expect(guard.assertHeld()).rejects.toThrow('account_root_freeze_released')
  })
  it('requires an independent observer', async () => {
    const { state, run } = fixture(); state.watcherId = 1
    await expect(run(async () => {})).rejects.toThrow('account_root_freeze_observer')
    expect(state.unlocks).toBe(0)
  })
})
