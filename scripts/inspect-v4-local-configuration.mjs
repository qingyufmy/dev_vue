import { localAccountEnvironment } from './run-local-account-api.mjs'
import { createPrivateKey } from 'node:crypto'
import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { loadV4RuntimeConfig, loadV4ApiRuntimeConfig, loadV4BrowserRealtimeConfig } from '../server/dist-v4/bootstrap/runtime-config.js'
import { loadCredentialKeyring } from '../server/dist-v4/modules/inference/composition.js'
const [destination, localConfiguration] = process.argv.slice(2)
assert.ok([3,4].includes(process.argv.length) && isAbsolute(destination ?? '') && (localConfiguration === undefined || isAbsolute(localConfiguration)))
const base = parse(await readFile(new URL('../server/.env', import.meta.url)))
const env = localConfiguration ? localAccountEnvironment(base, parse(await readFile(localConfiguration))) : base
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'v4-local-configuration/v1', observedAt: new Date().toISOString(), source: 'server/.env',
  localOverlayValidated: Boolean(localConfiguration), processOverridesVerified: false, servicesStarted: false, checks: {}, missingKeys: [], ready: false }
const groups = { runtime: ['MYSQL_HOST','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','REDIS_HOST','QUEUE_REDIS_HOST'],
  api: ['AUTH_ORIGIN','WWW_ORIGIN','TRADE_ORIGIN','ADMIN_ORIGIN','AUTH_CSRF_SECRET','AUTH_BFF_EXCHANGE_SECRET','AUTH_ID_TOKEN_PRIVATE_KEY_PEM','AUTH_ID_TOKEN_KEY_ID'],
  model: ['AI_CREDENTIAL_KEYS_JSON'] }
for (const [group, keys] of Object.entries(groups)) for (const key of keys) if (env[key] === undefined || !env[key].trim()) report.missingKeys.push({ group, key })
for (const [name, load] of Object.entries({ runtime: loadV4RuntimeConfig, api: loadV4ApiRuntimeConfig, realtime: loadV4BrowserRealtimeConfig, modelKeyring: loadCredentialKeyring })) {
  try { load(env); report.checks[name] = { valid: true } }
  catch (error) { const message = String(error?.message ?? 'configuration_invalid'); report.checks[name] = { valid: false, code: /^[A-Za-z0-9_]{1,128}$/.test(message) ? message : 'configuration_invalid' } }
}
if (report.checks.api.valid) {
  try {
    const config = loadV4ApiRuntimeConfig(env)
    assert.ok(config.auth.csrfSecret.length >= 32 && config.auth.bffExchangeSecret.length >= 32)
    const key = createPrivateKey(config.auth.idTokenPrivateKeyPem)
    assert.equal(key.asymmetricKeyType, 'ec'); assert.equal(key.asymmetricKeyDetails.namedCurve, 'prime256v1')
    report.checks.identityKey = { valid: true }
  } catch { report.checks.identityKey = { valid: false, code: 'identity_key_or_secret_invalid' } }
}
report.runtimeEnabled = env.AURUM_V4_RUNTIME_ENABLED === 'true'
report.targets = { mysqlHost: env.MYSQL_HOST, mysqlDatabase: env.MYSQL_DATABASE, cacheHost: env.REDIS_HOST,
  queueHost: env.QUEUE_REDIS_HOST, queueDb: Number(env.QUEUE_REDIS_DB || 1), queuePrefix: env.V4_QUEUE_PREFIX || 'aurum-v4' }
report.ready = report.runtimeEnabled && Object.values(report.checks).every(check => check.valid)
await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
console.log(JSON.stringify(report))
