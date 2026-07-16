// Shared server configuration — single source of truth
import { config as dotenvConfig } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// Load .env from server/ directory BEFORE any config reads
dotenvConfig({ path: resolve(dirname(fileURLToPath(import.meta.url)), '.env') })

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

// Rate limiting
export const API_RATE_LIMIT_MAX = parseInt(process.env.API_RATE_LIMIT_MAX || '2000')
export const AUTH_RATE_LIMIT_MAX = parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20')
export const WRITE_RATE_LIMIT_MAX = parseInt(process.env.WRITE_RATE_LIMIT_MAX || '10')
export const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000') // 15min

// Auth
export const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d'

// Database
export const MYSQL_POOL_SIZE = parseInt(process.env.MYSQL_POOL_SIZE || '10')

// Bridge WebSocket
export const ADMIN_CACHE_TTL_MS = parseInt(process.env.ADMIN_CACHE_TTL_MS || '300000') // 5min

// Captcha
export const CAPTCHA_TTL_MS = parseInt(process.env.CAPTCHA_TTL_MS || '300000') // 5min
