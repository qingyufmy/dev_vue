import mysql from 'mysql2'
import type { Pool } from 'mysql2/promise'
import { Redis } from 'ioredis'
import type { RedisEndpoint, V4BaseRuntimeConfig } from './runtime-config.js'

export function createMysqlPool(config: V4BaseRuntimeConfig['mysql']): Pool {
  const pool = mysql.createPool({
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
  // Driver timezone controls serialization only; SQL NOW/defaults use the session timezone.
  // The connection event runs before the first borrower, so initialization is queued first.
  pool.on('connection', (connection) => {
    connection.query("SET SESSION time_zone = '+00:00'", (error) => {
      if (error) connection.destroy()
    })
  })
  return pool.promise()
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
