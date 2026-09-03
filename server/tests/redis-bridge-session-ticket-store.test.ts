import type { Redis } from 'ioredis'
import { describe, expect, it } from 'vitest'
import { RedisBridgeSessionTicketStore } from '../src/modules/bridge/index.js'

class MemoryRedis {
  private readonly values = new Map<string, string>()

  async set(key: string, value: string) {
    if (this.values.has(key)) return null
    this.values.set(key, value)
    return 'OK'
  }

  async eval(_script: string, _keyCount: number, key: string) {
    const value = this.values.get(key) ?? null
    this.values.delete(key)
    return value
  }
}

describe('RedisBridgeSessionTicketStore', () => {
  it('binds and consumes a short session ticket exactly once', async () => {
    const redis = new MemoryRedis() as unknown as Redis
    const store = new RedisBridgeSessionTicketStore(redis)
    const claims = {
      userId: 7,
      installationId: 'installation-1',
      profileId: 'default',
      generation: 2,
    }
    const issued = await store.issue(claims)
    expect(issued.token).toMatch(/^bst_[A-Za-z0-9_-]{43}$/)
    expect(issued.expiresInSeconds).toBe(30)
    await expect(store.consume(issued.token)).resolves.toEqual(claims)
    await expect(store.consume(issued.token)).rejects.toMatchObject({
      code: 'bridge_session_token_expired',
      status: 401,
    })
  })

  it('rejects malformed tickets before Redis access', async () => {
    const redis = new MemoryRedis() as unknown as Redis
    const store = new RedisBridgeSessionTicketStore(redis)
    await expect(store.consume('not-a-ticket')).rejects.toMatchObject({
      code: 'bridge_session_token_invalid',
      status: 401,
    })
  })
})
