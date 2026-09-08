import Fastify from 'fastify'
import { readFile } from 'node:fs/promises'
import { registerApiV4Routes } from '../server/dist-v4/transport/api-v4-route-registrar.js'
import { cookieNameForClient } from '../server/dist-v4/modules/auth/index.js'
import { createAuthHttp } from '../server/dist-v4/modules/auth/composition.js'
import { createAuditModule } from '../server/dist-v4/modules/audit/composition.js'
import { compareApiRoutes } from './lib/api-route-coverage.mjs'

const document = JSON.parse(await readFile(new URL('../contracts/openapi-v4.json', import.meta.url), 'utf8'))
const app = Fastify({ exposeHeadRoutes: false }), routes = []
app.addHook('onRoute', route => {
  for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
    routes.push({ method, path: route.url, schemas: Object.keys(route.schema ?? {}).sort() })
  }
})
// No listener, database, Redis or provider is created. Any accidental use case invocation fails.
const unavailable = () => { throw new Error('route_inventory_must_not_invoke_business_services') }
const stub = new Proxy({}, { get: (_target, name) => name === 'then' ? undefined : unavailable })
const services = Object.fromEntries([
  'learning', 'learningCompletion', 'bridgeCredentials', 'bridgePairing', 'trading', 'connectionCapacity',
  'inference', 'strategies', 'risk', 'reviews', 'execution', 'userExecution', 'executionDistribution',
  'tradeHistory', 'tradeAuth', 'settingReader', 'settings', 'referralRules', 'observerManagement', 'observerAdminAuth',
].map(name => [name, stub]))
services.auth = { cookieName: cookieNameForClient }
services.authHttp = createAuthHttp(services.auth, false)
services.auditHttp = createAuditModule({ ownsAccount: unavailable, list: unavailable, find: unavailable }, { authenticate: unavailable }).http
try {
  await registerApiV4Routes(app, services, { wwwOrigin: 'https://www.example.test', tradeOrigin: 'https://trade.example.test',
    adminOrigin: 'https://admin.example.test', secureCookies: false })
  await app.ready()
  const result = compareApiRoutes(document, routes)
  console.log(JSON.stringify({ ...result, scope: 'Actual Fastify registration with offline adapters; no request/response equivalence or business readiness claim.' }, null, 2))
  if (['missing', 'undocumented', 'parameterNameDifferences', 'duplicateContractRoutes', 'duplicateRuntimeRoutes',
    'missingOperationIds', 'duplicateOperationIds'].some(field => result[field].length)) process.exitCode = 1
} finally { await app.close() }
