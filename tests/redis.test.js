import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  on: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
}

vi.mock('ioredis', () => {
  return { default: vi.fn(() => mockRedis) }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

async function loadModule() {
  process.env.REDIS_HOST = '127.0.0.1'
  const mod = await import('../server/redis.js')
  return mod
}

describe('cacheGetJSON', () => {
  it('key存在时返回解析后的JSON', async () => {
    const { cacheGetJSON } = await loadModule()
    mockRedis.get.mockResolvedValue('{"foo":"bar"}')

    const result = await cacheGetJSON('test-key')

    expect(result).toEqual({ foo: 'bar' })
    expect(mockRedis.get).toHaveBeenCalledWith('test-key')
  })

  it('key不存在时返回null', async () => {
    const { cacheGetJSON } = await loadModule()
    mockRedis.get.mockResolvedValue(null)

    const result = await cacheGetJSON('missing-key')

    expect(result).toBeNull()
  })

  it('Redis不可用时返回null', async () => {
    process.env.REDIS_HOST = undefined
    const { cacheGetJSON } = await import('../server/redis.js')

    const result = await cacheGetJSON('any-key')

    expect(result).toBeNull()
  })
})

describe('cacheSetJSON', () => {
  it('调用set序列化JSON', async () => {
    const { cacheSetJSON } = await loadModule()
    mockRedis.set.mockResolvedValue('OK')

    await cacheSetJSON('my-key', { a: 1 })

    expect(mockRedis.set).toHaveBeenCalledWith('my-key', '{"a":1}')
  })

  it('带TTL时使用EX参数', async () => {
    const { cacheSetJSON } = await loadModule()
    mockRedis.set.mockResolvedValue('OK')

    await cacheSetJSON('ttl-key', 'data', 300)

    expect(mockRedis.set).toHaveBeenCalledWith('ttl-key', '"data"', 'EX', 300)
  })
})

describe('cacheDel', () => {
  it('调用del删除key', async () => {
    const { cacheDel } = await loadModule()
    mockRedis.del.mockResolvedValue(1)

    await cacheDel('del-key')

    expect(mockRedis.del).toHaveBeenCalledWith('del-key')
  })
})
