import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import Redis from 'ioredis'
import {createBridgeGatewayLeases} from '../../server/dist-v4/modules/bridge/composition.js'
import {developmentRedisConnection} from './development-redis.mjs'

export async function withReferenceGatewayLease(route,work) {
  const config=await developmentRedisConnection()
  assert.equal(config.host,'192.168.1.254')
  const keyPrefix=`reference-portfolio-${randomUUID()}:`
  const cache=new Redis({...config,keyPrefix,lazyConnect:true,maxRetriesPerRequest:1})
  cache.on('error',()=>{})
  const leases=createBridgeGatewayLeases(cache)
  const prefix='aurum:v4:bridge:gateway'
  const keys=[`${prefix}:user:${route.userId}:connections`,`${prefix}:user:${route.userId}:profile:${route.terminalProfileId}`,
    `${prefix}:account:${route.accountId}`,`${prefix}:connection:${route.connectionId}`]
  try{
    await cache.connect()
    assert.equal(await leases.current(route.accountId),null)
    assert.deepEqual(await leases.claim({route,capacity:1,ttlSeconds:30}),{replacedConnectionId:null})
    assert.deepEqual(await leases.current(route.accountId),route)
    return await work(leases)
  }finally{
    try{
      assert.equal(cache.status,'ready','reference_redis_cleanup_connection_unavailable')
      await leases.release(route)
      await cache.del(...keys)
      assert.equal(await cache.exists(...keys),0)
    }finally{cache.disconnect()}
  }
}
