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

export interface V4BaseRuntimeConfig {
  enabled: boolean
  host: string
  mysql: { host: string; port: number; user: string; password: string; database: string; poolSize: number }
  cacheRedis: RedisEndpoint
}

export interface V4RuntimeConfig extends V4BaseRuntimeConfig {
  queueRedis: RedisEndpoint & ConnectionOptions
  queuePrefix: string
  bridgeGatewayPort: number
  executionHealthPort: number
  outboxHealthPort: number
  executionConcurrency: number
  executionMagic: number
  executionDeviation: number
  analysisSchedulerHealthPort: number
  analysisHealthPort: number
  traderHealthPort: number
  riskHealthPort: number
  reviewHealthPort: number
  historySchedulerHealthPort: number
  analysisSchedulePollMs: number
  analysisScheduleBatchSize: number
  analysisConcurrency: number
  traderConcurrency: number
  riskConcurrency: number
  reviewConcurrency: number
  historySchedulePollMs: number
  historyScheduleBatchSize: number
  modelDefaultTimeoutMs: number
  modelMaxAttempts: number
  modelRecoveryBatchSize: number
  modelUsageReservationMaxAgeMs: number
  allowPrivateModelEndpoints: boolean
}

export interface V4ApiRuntimeConfig {
  port: number
  secureCookies: boolean
  auth: {
    authOrigin: string
    wwwOrigin: string
    tradeOrigin: string
    adminOrigin: string
    csrfSecret: string
    bffExchangeSecret: string
    idTokenPrivateKeyPem: string
    idTokenKeyId: string
  }
}

export interface V4BrowserRealtimeConfig {
  port: number
  secureCookies: boolean
  tradeOrigin: string
}

export function loadServerEnvironment() {
  if (process.env.NODE_ENV === 'test') return
  const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  dotenvConfig({ path: resolve(serverDirectory, '.env') })
}

export function loadV4RuntimeConfig(env: NodeJS.ProcessEnv = process.env): V4RuntimeConfig {
  return {
    ...loadV4BaseRuntimeConfig(env),
    queueRedis: redisEndpoint(env, 'QUEUE_REDIS', true),
    queuePrefix: env.V4_QUEUE_PREFIX?.trim() || 'aurum-v4',
    bridgeGatewayPort: integer(env.V4_BRIDGE_GATEWAY_PORT, 3012, 1, 65_535, 'V4_BRIDGE_GATEWAY_PORT'),
    executionHealthPort: integer(env.V4_EXECUTION_HEALTH_PORT, 3021, 1, 65_535, 'V4_EXECUTION_HEALTH_PORT'),
    outboxHealthPort: integer(env.V4_OUTBOX_HEALTH_PORT, 3020, 1, 65_535, 'V4_OUTBOX_HEALTH_PORT'),
    executionConcurrency: integer(env.V4_EXECUTION_CONCURRENCY, 4, 1, 32, 'V4_EXECUTION_CONCURRENCY'),
    executionMagic: integer(env.V4_EXECUTION_MAGIC, 0, 0, 2_147_483_647, 'V4_EXECUTION_MAGIC'),
    executionDeviation: integer(env.V4_EXECUTION_DEVIATION, 20, 0, 100_000, 'V4_EXECUTION_DEVIATION'),
    analysisSchedulerHealthPort: integer(env.V4_ANALYSIS_SCHEDULER_HEALTH_PORT, 3022, 1, 65_535, 'V4_ANALYSIS_SCHEDULER_HEALTH_PORT'),
    analysisHealthPort: integer(env.V4_ANALYSIS_HEALTH_PORT, 3023, 1, 65_535, 'V4_ANALYSIS_HEALTH_PORT'),
    traderHealthPort: integer(env.V4_TRADER_HEALTH_PORT, 3024, 1, 65_535, 'V4_TRADER_HEALTH_PORT'),
    riskHealthPort: integer(env.V4_RISK_HEALTH_PORT, 3025, 1, 65_535, 'V4_RISK_HEALTH_PORT'),
    reviewHealthPort: integer(env.V4_REVIEW_HEALTH_PORT, 3026, 1, 65_535, 'V4_REVIEW_HEALTH_PORT'),
    historySchedulerHealthPort: integer(env.V4_HISTORY_SCHEDULER_HEALTH_PORT, 3027, 1, 65_535, 'V4_HISTORY_SCHEDULER_HEALTH_PORT'),
    analysisSchedulePollMs: integer(env.V4_ANALYSIS_SCHEDULE_POLL_MS, 1_000, 100, 60_000, 'V4_ANALYSIS_SCHEDULE_POLL_MS'),
    analysisScheduleBatchSize: integer(env.V4_ANALYSIS_SCHEDULE_BATCH_SIZE, 100, 1, 500, 'V4_ANALYSIS_SCHEDULE_BATCH_SIZE'),
    analysisConcurrency: integer(env.V4_ANALYSIS_CONCURRENCY, 2, 1, 16, 'V4_ANALYSIS_CONCURRENCY'),
    traderConcurrency: integer(env.V4_TRADER_CONCURRENCY, 4, 1, 32, 'V4_TRADER_CONCURRENCY'),
    riskConcurrency: integer(env.V4_RISK_CONCURRENCY, 8, 1, 64, 'V4_RISK_CONCURRENCY'),
    reviewConcurrency: integer(env.V4_REVIEW_CONCURRENCY, 1, 1, 4, 'V4_REVIEW_CONCURRENCY'),
    historySchedulePollMs: integer(env.V4_HISTORY_SCHEDULE_POLL_MS, 5_000, 1_000, 60_000, 'V4_HISTORY_SCHEDULE_POLL_MS'),
    historyScheduleBatchSize: integer(env.V4_HISTORY_SCHEDULE_BATCH_SIZE, 20, 1, 100, 'V4_HISTORY_SCHEDULE_BATCH_SIZE'),
    modelDefaultTimeoutMs: integer(env.V4_MODEL_DEFAULT_TIMEOUT_MS, 120_000, 1_000, 600_000, 'V4_MODEL_DEFAULT_TIMEOUT_MS'),
    modelMaxAttempts: integer(env.V4_MODEL_MAX_ATTEMPTS, 2, 1, 3, 'V4_MODEL_MAX_ATTEMPTS'),
    modelRecoveryBatchSize: integer(env.V4_MODEL_RECOVERY_BATCH_SIZE, 50, 1, 500, 'V4_MODEL_RECOVERY_BATCH_SIZE'),
    modelUsageReservationMaxAgeMs: integer(env.V4_MODEL_USAGE_RESERVATION_MAX_AGE_MS, 1_800_000, 60_000, 86_400_000, 'V4_MODEL_USAGE_RESERVATION_MAX_AGE_MS'),
    allowPrivateModelEndpoints: booleanValue(env.AI_ALLOW_PRIVATE_MODEL_ENDPOINTS, false, 'AI_ALLOW_PRIVATE_MODEL_ENDPOINTS'),
  }
}

export function loadV4BaseRuntimeConfig(env: NodeJS.ProcessEnv = process.env): V4BaseRuntimeConfig {
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
  }
}

export function assertV4RuntimeEnabled(config: Pick<V4BaseRuntimeConfig, 'enabled'>) {
  if (!config.enabled) throw new Error('AURUM_V4_RUNTIME_ENABLED_must_be_true')
}

export function loadV4ApiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): V4ApiRuntimeConfig {
  return {
    port: integer(env.V4_API_PORT, 3010, 1, 65_535, 'V4_API_PORT'),
    secureCookies: booleanValue(env.V4_SECURE_COOKIES, true, 'V4_SECURE_COOKIES'),
    auth: {
      authOrigin: exactOrigin(env.AUTH_ORIGIN, 'AUTH_ORIGIN'),
      wwwOrigin: exactOrigin(env.WWW_ORIGIN, 'WWW_ORIGIN'),
      tradeOrigin: exactOrigin(env.TRADE_ORIGIN, 'TRADE_ORIGIN'),
      adminOrigin: exactOrigin(env.ADMIN_ORIGIN, 'ADMIN_ORIGIN'),
      csrfSecret: required(env.AUTH_CSRF_SECRET, 'AUTH_CSRF_SECRET'),
      bffExchangeSecret: required(env.AUTH_BFF_EXCHANGE_SECRET, 'AUTH_BFF_EXCHANGE_SECRET'),
      idTokenPrivateKeyPem: required(env.AUTH_ID_TOKEN_PRIVATE_KEY_PEM, 'AUTH_ID_TOKEN_PRIVATE_KEY_PEM').replace(/\\n/g, '\n'),
      idTokenKeyId: required(env.AUTH_ID_TOKEN_KEY_ID, 'AUTH_ID_TOKEN_KEY_ID'),
    },
  }
}

export function loadV4BrowserRealtimeConfig(env: NodeJS.ProcessEnv = process.env): V4BrowserRealtimeConfig {
  return {
    port: integer(env.V4_BROWSER_REALTIME_PORT, 3011, 1, 65_535, 'V4_BROWSER_REALTIME_PORT'),
    secureCookies: booleanValue(env.V4_SECURE_COOKIES, true, 'V4_SECURE_COOKIES'),
    tradeOrigin: exactOrigin(env.TRADE_ORIGIN, 'TRADE_ORIGIN'),
  }
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

function booleanValue(value: string | undefined, fallback: boolean, name: string) {
  if (value === undefined || value.trim() === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name}_invalid`)
}

function exactOrigin(value: string | undefined, name: string) {
  const origin = new URL(required(value, name))
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error(`${name}_invalid`)
  }
  return origin.origin
}
