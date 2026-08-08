import { beforeEach, describe, expect, it, vi } from 'vitest'

const runner = vi.fn()

vi.mock('../server/db.js', () => ({
  queryOne:vi.fn(),
  queryAll:vi.fn(),
  queryRun:vi.fn(),
  withTransaction:vi.fn(),
  beijingNow:vi.fn(),
  withConnection:vi.fn(async fn => fn(runner)),
}))

import { withMigrationLock } from '../server/migrations.js'

describe('database migration lock', () => {
  beforeEach(() => vi.clearAllMocks())

  it('holds and releases the MySQL advisory lock around migration work', async () => {
    runner
      .mockResolvedValueOnce([[{ acquired:1 }], []])
      .mockResolvedValueOnce([[{ released:1 }], []])
    const migrate = vi.fn(async () => 'done')

    await expect(withMigrationLock(migrate)).resolves.toBe('done')
    expect(migrate).toHaveBeenCalledOnce()
    expect(runner.mock.calls[0][0]).toContain('GET_LOCK')
    expect(runner.mock.calls[0][0]).toContain("CONCAT('wss:mig:', LEFT(SHA2(")
    expect(runner.mock.calls[0][0]).toContain(', 56)')
    expect(runner.mock.calls[1][0]).toContain('RELEASE_LOCK')
  })

  it('fails closed when another instance owns the lock', async () => {
    runner.mockResolvedValueOnce([[{ acquired:0 }], []])

    await expect(withMigrationLock(vi.fn(), { timeoutSeconds:1 }))
      .rejects.toThrow('Could not acquire the database migration lock')
    expect(runner).toHaveBeenCalledOnce()
  })

  it('releases the lock when a migration throws', async () => {
    runner
      .mockResolvedValueOnce([[{ acquired:1 }], []])
      .mockResolvedValueOnce([[{ released:1 }], []])

    await expect(withMigrationLock(async () => { throw new Error('migration failed') }))
      .rejects.toThrow('migration failed')
    expect(runner.mock.calls[1][0]).toContain('RELEASE_LOCK')
  })
})
