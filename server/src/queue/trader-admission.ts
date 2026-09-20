import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'

// Admission controls resource use only. The database account fence remains authoritative.
const acquire = `
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
if redis.call('EXISTS',KEYS[1])==1 then return 0 end
if redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[2]) then return 0 end
redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[3])
redis.call('ZADD',KEYS[2],now+tonumber(ARGV[3]),ARGV[1])
redis.call('PEXPIRE',KEYS[2],ARGV[3])
return 1`
const renew = `
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
redis.call('PEXPIRE',KEYS[1],ARGV[2])
redis.call('ZADD',KEYS[2],now+tonumber(ARGV[2]),ARGV[1])
redis.call('PEXPIRE',KEYS[2],ARGV[2])
return 1`
const release = `
if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]) end
redis.call('ZREM',KEYS[2],ARGV[1])
return 1`

export class TraderAdmission {
  constructor(private readonly redis: Pick<Redis, 'eval'>, private readonly prefix: string,
    private readonly perUser: number, private readonly leaseMs = 60_000) {
    if (!Number.isSafeInteger(perUser) || perUser < 1 || perUser > 32 || leaseMs < 3000) throw Error('trader_admission_config_invalid')
  }

  async enter(userId: number, accountId: string) {
    const keys = [`${this.prefix}:trader-admission:account:${accountId}`, `${this.prefix}:trader-admission:user:${userId}`]
    const token = randomUUID()
    if (Number(await this.redis.eval(acquire, 2, ...keys, token, this.perUser, this.leaseMs)) !== 1) return null
    let pending = Promise.resolve(), lost = false
    const timer = setInterval(() => {
      pending = pending.then(async () => {
        if (Number(await this.redis.eval(renew, 2, ...keys, token, this.leaseMs)) !== 1) lost = true
      }).catch(() => { lost = true })
    }, Math.floor(this.leaseMs / 3))
    timer.unref()
    return { get lost() { return lost }, close: async () => {
      clearInterval(timer)
      await pending
      await this.redis.eval(release, 2, ...keys, token)
    } }
  }
}
