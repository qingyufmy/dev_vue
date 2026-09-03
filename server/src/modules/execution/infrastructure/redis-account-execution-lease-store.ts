import type { Redis } from 'ioredis'
import type { AccountExecutionLeaseStore } from '../application/execution-dispatch-ports.js'

const RENEW = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end redis.call('PEXPIRE',KEYS[1],ARGV[2]) return 1`
const RELEASE = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end return redis.call('DEL',KEYS[1])`

export class RedisAccountExecutionLeaseStore implements AccountExecutionLeaseStore {
  constructor(private readonly redis: Redis, private readonly prefix = 'aurum:v4:execution:account') {}
  async acquire(accountId: string, owner: string, ttlSeconds: number) {
    return (await this.redis.set(this.key(accountId), owner, 'PX', ttlSeconds * 1000, 'NX')) === 'OK'
  }
  async renew(accountId: string, owner: string, ttlSeconds: number) {
    return Number(await this.redis.eval(RENEW, 1, this.key(accountId), owner, String(ttlSeconds * 1000))) === 1
  }
  async release(accountId: string, owner: string) { await this.redis.eval(RELEASE, 1, this.key(accountId), owner) }
  private key(accountId: string) { return `${this.prefix}:${accountId}` }
}
