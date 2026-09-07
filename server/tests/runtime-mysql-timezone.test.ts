import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ createPool: vi.fn(), on: vi.fn() }))
vi.mock('mysql2', () => ({ default: { createPool: mocks.createPool } }))
import { createMysqlPool } from '../src/bootstrap/runtime-resources.js'
beforeEach(() => { vi.clearAllMocks(); mocks.createPool.mockReturnValue({ on: mocks.on, promise: vi.fn() }) })
it('queues UTC SQL session initialization before allowing pool work, and closes on initialization failure', () => {
  createMysqlPool({ host: 'localhost', port: 3306, user: 'test', password: '', database: 'test', poolSize: 1 })
  expect(mocks.createPool).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'Z' }))
  expect(mocks.on.mock.calls[0]![0]).toBe('connection')
  const connection = { query: vi.fn(), destroy: vi.fn() }
  mocks.on.mock.calls[0]![1](connection)
  expect(connection.query.mock.calls[0]![0]).toBe("SET SESSION time_zone = '+00:00'")
  connection.query.mock.calls[0]![1](null)
  expect(connection.destroy).not.toHaveBeenCalled()
  connection.query.mock.calls[0]![1](new Error('session initialization failed'))
  expect(connection.destroy).toHaveBeenCalledOnce()
})
