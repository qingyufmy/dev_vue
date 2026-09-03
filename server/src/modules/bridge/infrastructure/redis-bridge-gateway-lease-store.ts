import type { Redis } from 'ioredis'
import type { BridgeGatewayLeaseStore } from '../application/bridge-gateway-ports.js'
import { BridgeGatewayError, type BridgeGatewayRoute } from '../domain/bridge-gateway.js'

const CLAIM = `
local userKey=KEYS[1]
local profileKey=KEYS[2]
local accountKey=KEYS[3]
local connectionKey=KEYS[4]
local now=tonumber(ARGV[1])
local expires=tonumber(ARGV[2])
local ttl=expires-now
local capacity=tonumber(ARGV[3])
local member=ARGV[4]
local connectionId=ARGV[5]
local routeJson=ARGV[6]
redis.call('ZREMRANGEBYSCORE',userKey,'-inf',now)
local replaced=redis.call('GET',profileKey)
if replaced and not redis.call('ZSCORE',userKey,string.match(member,'^[^|]+') .. '|' .. replaced) then replaced='' end
local accountRaw=redis.call('GET',accountKey)
if accountRaw then
  local accountRoute=cjson.decode(accountRaw)
  if accountRoute.connectionId ~= connectionId then
    replaced=accountRoute.connectionId
    redis.call('ZREM',userKey,accountRoute.terminalProfileId .. '|' .. accountRoute.connectionId)
  end
end
if replaced and replaced ~= connectionId then redis.call('ZREM',userKey,string.match(member,'^[^|]+') .. '|' .. replaced) end
if (not replaced or replaced == '') and redis.call('ZCARD',userKey) >= capacity then return {0,''} end
redis.call('ZADD',userKey,expires,member)
redis.call('SET',profileKey,connectionId,'PX',ttl)
redis.call('SET',accountKey,routeJson,'PX',ttl)
redis.call('SET',connectionKey,routeJson,'PX',ttl)
redis.call('PEXPIRE',userKey,ttl)
return {1,replaced or ''}
`

const RENEW = `
if redis.call('GET',KEYS[2]) ~= ARGV[1] then return 0 end
local accountRaw=redis.call('GET',KEYS[3])
if not accountRaw or cjson.decode(accountRaw).connectionId ~= ARGV[1] then return 0 end
redis.call('ZADD',KEYS[1],ARGV[2],ARGV[3])
redis.call('PEXPIRE',KEYS[1],ARGV[4])
redis.call('PEXPIRE',KEYS[2],ARGV[4])
redis.call('PEXPIRE',KEYS[3],ARGV[4])
redis.call('PEXPIRE',KEYS[4],ARGV[4])
return 1
`

const RELEASE = `
if redis.call('GET',KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('ZREM',KEYS[1],ARGV[2])
redis.call('DEL',KEYS[2])
local accountRaw=redis.call('GET',KEYS[3])
if accountRaw and cjson.decode(accountRaw).connectionId == ARGV[1] then redis.call('DEL',KEYS[3]) end
redis.call('DEL',KEYS[4])
return 1
`

export class RedisBridgeGatewayLeaseStore implements BridgeGatewayLeaseStore {
  constructor(private readonly redis: Redis, private readonly prefix = 'aurum:v4:bridge:gateway') {}

  async claim(input: Parameters<BridgeGatewayLeaseStore['claim']>[0]) {
    const route = input.route; const now = Date.now(); const ttl = input.ttlSeconds * 1000
    const result = await this.redis.eval(CLAIM, 4,
      this.userKey(route.userId), this.profileKey(route.userId, route.terminalProfileId), this.accountKey(route.accountId), this.connectionKey(route.connectionId),
      String(now), String(now + ttl), String(input.capacity), this.member(route), route.connectionId, JSON.stringify(route)) as [number, string]
    if (Number(result[0]) !== 1) throw new BridgeGatewayError('bridge_capacity_exceeded', 409)
    const replaced = String(result[1] ?? '')
    return { replacedConnectionId: replaced || null }
  }

  async renew(route: BridgeGatewayRoute, ttlSeconds: number) {
    const ttl = ttlSeconds * 1000
    const result = await this.redis.eval(RENEW, 4,
      this.userKey(route.userId), this.profileKey(route.userId, route.terminalProfileId), this.accountKey(route.accountId), this.connectionKey(route.connectionId),
      route.connectionId, String(Date.now() + ttl), this.member(route), String(ttl))
    return Number(result) === 1
  }

  async release(route: BridgeGatewayRoute) {
    await this.redis.eval(RELEASE, 4,
      this.userKey(route.userId), this.profileKey(route.userId, route.terminalProfileId), this.accountKey(route.accountId), this.connectionKey(route.connectionId),
      route.connectionId, this.member(route))
  }

  async current(accountId: string) {
    const raw = await this.redis.get(this.accountKey(accountId))
    if (!raw) return null
    try {
      const route = JSON.parse(raw) as BridgeGatewayRoute
      const profileConnection = await this.redis.get(this.profileKey(route.userId, route.terminalProfileId))
      return profileConnection === route.connectionId ? route : null
    } catch { throw new BridgeGatewayError('bridge_route_storage_invalid', 503) }
  }

  private userKey(userId: number) { return `${this.prefix}:user:${userId}:connections` }
  private profileKey(userId: number, profileId: string) { return `${this.prefix}:user:${userId}:profile:${profileId}` }
  private accountKey(accountId: string) { return `${this.prefix}:account:${accountId}` }
  private connectionKey(connectionId: string) { return `${this.prefix}:connection:${connectionId}` }
  private member(route: BridgeGatewayRoute) { return `${route.terminalProfileId}|${route.connectionId}` }
}
