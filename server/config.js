// Shared server configuration — single source of truth
import { config as dotenvConfig } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseCorsOrigins as splitCorsOrigins } from './cors-origin.js'

export { isCorsOriginAllowed } from './cors-origin.js'

// Load .env from server/ directory BEFORE any config reads
if (process.env.NODE_ENV !== 'test') {
  dotenvConfig({ path: resolve(dirname(fileURLToPath(import.meta.url)), '.env') })
}
const serverDirectory = dirname(fileURLToPath(import.meta.url))

const secret = process.env.JWT_SECRET
if (!secret) {
  console.error('[FATAL] JWT_SECRET 环境变量未设置，服务无法启动')
  process.exit(1)
}

export const JWT_SECRET = secret
export const DEFAULT_API_BASE_URL = process.env.DEFAULT_API_BASE_URL || 'https://api.deepseek.com'

// Server
export const PORT = parseInt(process.env.PORT || '3000')
export const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '10485760') // 10MB
export const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '10mb'
export const resolvePublicUploadDir = value => resolve(serverDirectory, value || 'uploads')
export const PUBLIC_UPLOAD_DIR = resolvePublicUploadDir(process.env.UPLOAD_DIR)
export const DEFAULT_CORS_ORIGINS = Object.freeze([
  'localhost:3000',
  'localhost:3001',
  'localhost:3005',
  'localhost:8080',
  '127.0.0.1:3000',
  '192.168.1.254',
  'cnfxtrade.com',
])
export function parseCorsOrigins(value = process.env.CORS_ORIGINS) {
  const source = value === undefined ? DEFAULT_CORS_ORIGINS.join(',') : String(value)
  return splitCorsOrigins(source)
}
export const CORS_ORIGINS = Object.freeze(parseCorsOrigins())

// Sensitive-operation rate limiting. General API CC protection is enforced
// at the deployment edge so dashboard polling is not double-limited per IP.
export const AUTH_RATE_LIMIT_MAX = parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20')
export const BRIDGE_AUTH_RATE_LIMIT_MAX = parseInt(process.env.BRIDGE_AUTH_RATE_LIMIT_MAX || '240')
export const BRIDGE_PAIR_START_RATE_LIMIT_WINDOW_MS = parseInt(process.env.BRIDGE_PAIR_START_RATE_LIMIT_WINDOW_MS || '600000')
export const BRIDGE_PAIR_START_RATE_LIMIT_MAX = parseInt(process.env.BRIDGE_PAIR_START_RATE_LIMIT_MAX || '6')
export const WRITE_RATE_LIMIT_MAX = parseInt(process.env.WRITE_RATE_LIMIT_MAX || '10')
export const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000') // 15min

// Auth
export const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d'
export const BRIDGE_REFRESH_TTL_DAYS = Math.min(365, Math.max(7, parseInt(process.env.BRIDGE_REFRESH_TTL_DAYS || '90')))

// The migration advisory lock occupies one pooled connection while migration
// statements use another, so a one-connection pool would deadlock at startup.
export const normalizeMysqlPoolSize = value => Math.max(2, parseInt(value || '10') || 10)
export const MYSQL_POOL_SIZE = normalizeMysqlPoolSize(process.env.MYSQL_POOL_SIZE)

// Bridge WebSocket
export const ADMIN_CACHE_TTL_MS = parseInt(process.env.ADMIN_CACHE_TTL_MS || '300000') // 5min

// Captcha
export const CAPTCHA_TTL_MS = parseInt(process.env.CAPTCHA_TTL_MS || '300000') // 5min
