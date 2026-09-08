import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'

const permitted = new Set(['AURUM_V4_RUNTIME_ENABLED', 'V4_RUNTIME_HOST', 'V4_API_PORT', 'V4_SECURE_COOKIES',
  'REDIS_HOST', 'REDIS_PORT', 'REDIS_DB', 'REDIS_PASSWORD', 'AUTH_ORIGIN', 'WWW_ORIGIN', 'TRADE_ORIGIN', 'ADMIN_ORIGIN',
  'AUTH_CSRF_SECRET', 'AUTH_BFF_EXCHANGE_SECRET', 'AUTH_ID_TOKEN_PRIVATE_KEY_PEM', 'AUTH_ID_TOKEN_KEY_ID'])

export function localAccountEnvironment(base, local) {
  assert.ok(Object.keys(local).every(key => permitted.has(key)), 'local_account_config_key')
  assert.equal(base.MYSQL_DATABASE, 'dev_vue', 'local_account_database')
  for (const [key, value] of Object.entries({ AURUM_V4_RUNTIME_ENABLED: 'true', V4_RUNTIME_HOST: '127.0.0.1',
    V4_API_PORT: '3010', V4_SECURE_COOKIES: 'false', REDIS_HOST: '127.0.0.1', REDIS_PORT: '16379', REDIS_DB: '0',
    AUTH_ORIGIN: 'http://localhost:4176', WWW_ORIGIN: 'http://localhost:3100',
    TRADE_ORIGIN: 'http://localhost:4174', ADMIN_ORIGIN: 'http://localhost:4175' })) {
    assert.equal(local[key], value, 'local_account_endpoint')
  }
  for (const key of ['REDIS_PASSWORD', 'AUTH_CSRF_SECRET', 'AUTH_BFF_EXCHANGE_SECRET']) {
    assert.ok(typeof local[key] === 'string' && local[key].length >= 32, 'local_account_secret_missing')
  }
  assert.ok(local.AUTH_ID_TOKEN_PRIVATE_KEY_PEM && local.AUTH_ID_TOKEN_KEY_ID, 'local_account_signing_key_missing')
  return { ...base, ...local, NODE_ENV: 'development' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 3 && isAbsolute(process.argv[2]), 'local_account_config_path')
  const base = parse(await readFile(new URL('../server/.env', import.meta.url)))
  const local = parse(await readFile(process.argv[2]))
  Object.assign(process.env, localAccountEnvironment(base, local))
  console.log('Starting local account API on 127.0.0.1:3010 with loopback Redis; MySQL configuration retained')
  await import('../server/dist-v4/entrypoints/api-v4.js')
}
