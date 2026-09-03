import type { Redis } from 'ioredis'
import { ConnectionCapacityExceededError, type ConnectionLeaseStore } from '../application/trading-ports.js'

const CLAIM_SCRIPT = `
local setKey = KEYS[1]
local accountKey = KEYS[2]
local now = tonumber(ARGV[1])
local expires = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', setKey, '-inf', now)
local replaced = redis.call('GET', accountKey)
if not replaced and redis.call('ZCARD', setKey) >= capacity then return {0, redis.call('ZCARD', setKey), ''} end
if replaced then redis.call('ZREM', setKey, replaced) end
redis.call('ZADD', setKey, expires, member)
redis.call('SET', accountKey, member, 'PX', expires - now)
redis.call('PEXPIRE', setKey, expires - now)
return {1, redis.call('ZCARD', setKey), replaced or ''}
`
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
`
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
return 1
`

export class RedisConnectionLeaseStore implements ConnectionLeaseStore {
  constructor(private readonly redis: Redis, private readonly prefix = 'aurum:v4:bridge:leases') {}
  async claim(input: Parameters<ConnectionLeaseStore['claim']>[0]) {
    const now = Date.now(); const member = `${input.accountId}|${input.connectionEpoch}`
    const result = await this.redis.eval(CLAIM_SCRIPT, 2, this.userKey(input.userId), this.accountKey(input.userId, input.accountId), String(now), String(now + input.ttlSeconds * 1000), String(input.capacity), member) as [number, number, string]
    if (Number(result[0]) !== 1) throw new ConnectionCapacityExceededError()
    const replaced = String(result[2] ?? '')
    return { active: Number(result[1]), replacedEpoch: replaced ? replaced.split('|').at(-1) ?? null : null }
  }
  async renew(userId: number, accountId: string, epoch: string, ttlSeconds: number) {
    const member = `${accountId}|${epoch}`; const ttlMilliseconds = ttlSeconds * 1000
    const renewed = await this.redis.eval(RENEW_SCRIPT, 2, this.userKey(userId), this.accountKey(userId, accountId), member, String(Date.now() + ttlMilliseconds), String(ttlMilliseconds))
    return Number(renewed) === 1
  }
  async release(userId: number, accountId: string, epoch: string) {
    const member = `${accountId}|${epoch}`
    await this.redis.eval(RELEASE_SCRIPT, 2, this.userKey(userId), this.accountKey(userId, accountId), member)
  }
  async count(userId: number) {
    const key = this.userKey(userId); await this.redis.zremrangebyscore(key, '-inf', Date.now()); return this.redis.zcard(key)
  }
  private userKey(userId: number) { return `${this.prefix}:user:${userId}` }
  private accountKey(userId: number, accountId: string) { return `${this.prefix}:user:${userId}:account:${accountId}` }
}
