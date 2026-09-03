import type { ConnectionOptions } from 'bullmq'
import { config as dotenvConfig } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RedisEndpoint {
  host: string
  port: number
  password?: string
  db: number
}

export interface V4RuntimeConfig {
  enabled: boolean
  host: string
  mysql: { host: string; port: number; user: string; password: string; database: string; poolSize: number }
  cacheRedis: RedisEndpoint
  queueRedis: RedisEndpoint & ConnectionOptions
  queuePrefix: string
  bridgeGatewayPort: number
  executionHealthPort: number
  outboxHealthPort: number
  executionConcurrency: number
  executionMagic: number
  executionDeviation: number
}

export function loadServerEnvironment() {
  if (process.env.NODE_ENV === 'test') return
  const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  dotenvConfig({ path: resolve(serverDirectory, '.env') })
}

export function loadV4RuntimeConfig(env: NodeJS.ProcessEnv = process.env): V4RuntimeConfig {
  return {
    enabled: env.AURUM_V4_RUNTIME_ENABLED === 'true',
    host: env.V4_RUNTIME_HOST?.trim() || '127.0.0.1',
    mysql: {
      host: required(env.MYSQL_HOST, 'MYSQL_HOST'),
      port: integer(env.MYSQL_PORT, 3306, 1, 65_535, 'MYSQL_PORT'),
      user: required(env.MYSQL_USER, 'MYSQL_USER'),
      password: requiredValue(env.MYSQL_PASSWORD, 'MYSQL_PASSWORD'),
      database: required(env.MYSQL_DATABASE, 'MYSQL_DATABASE'),
      poolSize: integer(env.V4_MYSQL_POOL_SIZE, 4, 1, 20, 'V4_MYSQL_POOL_SIZE'),
    },
    cacheRedis: redisEndpoint(env, 'REDIS', false),
    queueRedis: redisEndpoint(env, 'QUEUE_REDIS', true),
    queuePrefix: env.V4_QUEUE_PREFIX?.trim() || 'aurum-v4',
    bridgeGatewayPort: integer(env.V4_BRIDGE_GATEWAY_PORT, 3012, 1, 65_535, 'V4_BRIDGE_GATEWAY_PORT'),
    executionHealthPort: integer(env.V4_EXECUTION_HEALTH_PORT, 3021, 1, 65_535, 'V4_EXECUTION_HEALTH_PORT'),
    outboxHealthPort: integer(env.V4_OUTBOX_HEALTH_PORT, 3020, 1, 65_535, 'V4_OUTBOX_HEALTH_PORT'),
    executionConcurrency: integer(env.V4_EXECUTION_CONCURRENCY, 4, 1, 32, 'V4_EXECUTION_CONCURRENCY'),
    executionMagic: integer(env.V4_EXECUTION_MAGIC, 0, 0, 2_147_483_647, 'V4_EXECUTION_MAGIC'),
    executionDeviation: integer(env.V4_EXECUTION_DEVIATION, 20, 0, 100_000, 'V4_EXECUTION_DEVIATION'),
  }
}

export function assertV4RuntimeEnabled(config: V4RuntimeConfig) {
  if (!config.enabled) throw new Error('AURUM_V4_RUNTIME_ENABLED_must_be_true')
}

function redisEndpoint(env: NodeJS.ProcessEnv, prefix: 'REDIS' | 'QUEUE_REDIS', worker: boolean): RedisEndpoint & ConnectionOptions {
  const host = required(env[`${prefix}_HOST`], `${prefix}_HOST`)
  const password = env[`${prefix}_PASSWORD`]
  return {
    host,
    port: integer(env[`${prefix}_PORT`], 6379, 1, 65_535, `${prefix}_PORT`),
    ...(password ? { password } : {}),
    db: integer(env[`${prefix}_DB`], prefix === 'REDIS' ? 0 : 1, 0, 15, `${prefix}_DB`),
    ...(worker ? { maxRetriesPerRequest: null } : {}),
  }
}

function required(value: string | undefined, name: string) {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${name}_required`)
  return normalized
}

function requiredValue(value: string | undefined, name: string) {
  if (value === undefined) throw new Error(`${name}_required`)
  return value
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name}_invalid`)
  return parsed
}
