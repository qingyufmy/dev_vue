import mysql from 'mysql2/promise'
import { config as loadDotEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function configurationError(code) {
  throw Object.assign(new Error(code), { code })
}

export function normalizeDatabaseQiniuConfig(values = {}) {
  const accessKey = String(values.access_key || '').trim()
  const secretKey = String(values.secret_key || '').trim()
  const bucket = String(values.bucket || '').trim()
  const region = String(values.region || '').trim()
  const rawDomain = String(values.domain || '').trim()
  if (!accessKey || !secretKey || !bucket || !region || !rawDomain) {
    configurationError('release_qiniu_database_configuration_missing')
  }
  let domain
  try {
    const url = new URL(rawDomain.includes('://') ? rawDomain : `https://${rawDomain}`)
    if (url.protocol !== 'https:' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
      configurationError('release_qiniu_database_domain_invalid')
    }
    domain = url.origin
  } catch (error) {
    if (error?.code) throw error
    configurationError('release_qiniu_database_domain_invalid')
  }
  return {
    QINIU_ACCESS_KEY:accessKey,
    QINIU_SECRET_KEY:secretKey,
    QINIU_BUCKET:bucket,
    QINIU_DOMAIN:domain,
    QINIU_REGION:region,
  }
}

export async function loadDatabaseQiniuConfig() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
  loadDotEnv({ path:path.resolve(scriptDirectory, '../../server/.env'), quiet:true })
  const { decryptCredential, isEncryptedEnvelope } = await import('../../server/ai-credential.js')
  const connection = await mysql.createConnection({
    host:process.env.MYSQL_HOST,
    port:Number(process.env.MYSQL_PORT || 3306),
    user:process.env.MYSQL_USER,
    password:process.env.MYSQL_PASSWORD,
    database:process.env.MYSQL_DATABASE,
    charset:'utf8mb4',
    connectTimeout:60_000,
  })
  try {
    const [rows] = await connection.query(
      "SELECT `key`, `value` FROM system_config WHERE category = 'qiniu'",
    )
    const values = Object.fromEntries(rows.map(row => {
      const value = String(row.value ?? '')
      return [row.key, value && isEncryptedEnvelope(value) ? decryptCredential(value) : value]
    }))
    return normalizeDatabaseQiniuConfig(values)
  } finally {
    await connection.end()
  }
}
