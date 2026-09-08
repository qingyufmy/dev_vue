import { expect, it } from 'vitest'
import { localAccountEnvironment } from '../scripts/run-local-account-api.mjs'

const base = { MYSQL_DATABASE: 'dev_vue', MYSQL_HOST: 'database-host', MYSQL_PASSWORD: 'database-secret', REDIS_HOST: 'old-cache' }
const local = { AURUM_V4_RUNTIME_ENABLED: 'true', V4_RUNTIME_HOST: '127.0.0.1', V4_API_PORT: '3010', V4_SECURE_COOKIES: 'false',
  REDIS_HOST: '127.0.0.1', REDIS_PORT: '16379', REDIS_DB: '0', REDIS_PASSWORD: 'x'.repeat(32),
  AUTH_ORIGIN: 'http://localhost:4176', WWW_ORIGIN: 'http://localhost:3100', TRADE_ORIGIN: 'http://localhost:4174', ADMIN_ORIGIN: 'http://localhost:4175',
  AUTH_CSRF_SECRET: 'c'.repeat(32), AUTH_BFF_EXCHANGE_SECRET: 'b'.repeat(32), AUTH_ID_TOKEN_PRIVATE_KEY_PEM: 'validated-by-signer', AUTH_ID_TOKEN_KEY_ID: 'local' }
it('preserves the existing database configuration while isolating the local cache and auth origins', () => {
  const result = localAccountEnvironment(base, local)
  expect(result.MYSQL_HOST).toBe(base.MYSQL_HOST); expect(result.MYSQL_PASSWORD).toBe(base.MYSQL_PASSWORD)
  expect(result.REDIS_HOST).toBe('127.0.0.1'); expect(result.NODE_ENV).toBe('development')
  expect(base.REDIS_HOST).toBe('old-cache')
})
it.each([{ MYSQL_DATABASE: 'other' }, { REDIS_HOST: 'remote' }, { V4_RUNTIME_HOST: '0.0.0.0' },
  { AUTH_ORIGIN: 'https://external.test' }, { REDIS_PASSWORD: '' }, { AUTH_ID_TOKEN_PRIVATE_KEY_PEM: '' }])('rejects unsafe local override %j', patch => {
  expect(() => localAccountEnvironment(base, { ...local, ...patch })).toThrow()
})
it('rejects a different base database', () => {
  expect(() => localAccountEnvironment({ ...base, MYSQL_DATABASE: 'production' }, local)).toThrow('local_account_database')
})
