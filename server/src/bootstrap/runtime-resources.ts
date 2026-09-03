import mysql, { type Pool } from 'mysql2/promise'
import { Redis } from 'ioredis'
import type { RedisEndpoint, V4RuntimeConfig } from './runtime-config.js'

export function createMysqlPool(config: V4RuntimeConfig['mysql']): Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.poolSize,
    maxIdle: config.poolSize,
    idleTimeout: 60_000,
    queueLimit: config.poolSize * 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    timezone: 'Z',
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  })
}

export function createCacheRedis(config: RedisEndpoint): Redis {
  return new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  })
}

export async function connectCacheRedis(redis: Redis) {
  if (redis.status === 'wait') await redis.connect()
  await redis.ping()
}
