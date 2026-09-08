import { createMarketHttp } from '../server/dist-v4/modules/market/composition.js'
import { createTradeHistoryHttp } from '../server/dist-v4/modules/trade-history/composition.js'
import { createReviewHttp } from '../server/dist-v4/modules/reviews/composition.js'
import { createStrategyHttp } from '../server/dist-v4/modules/strategies/composition.js'
import { createInferenceHttp } from '../server/dist-v4/modules/inference/composition.js'
import { createBridgeHttp } from '../server/dist-v4/modules/bridge/composition.js'
import Fastify from 'fastify'
import { createTradingHttp, createObserverManagementHttp } from '../server/dist-v4/modules/trading/composition.js'
import { readFile } from 'node:fs/promises'
import { registerApiV4Routes } from '../server/dist-v4/transport/api-v4-route-registrar.js'
import { cookieNameForClient } from '../server/dist-v4/modules/auth/index.js'
import { createAuthHttp } from '../server/dist-v4/modules/auth/composition.js'
import { createLearningHttp } from '../server/dist-v4/modules/learning/composition.js'
import { createSettingsHttp } from '../server/dist-v4/modules/settings/composition.js'
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
  'bridgeCredentials', 'bridgePairing', 'trading', 'connectionCapacity',
  'inference', 'strategies', 'risk', 'reviews', 'execution', 'userExecution', 'executionDistribution',
  'tradeHistory', 'tradeAuth', 'referralRules', 'observerManagement', 'observerAdminAuth',
].map(name => [name, stub]))
services.inferenceHttp = createInferenceHttp(stub, stub, stub)
services.strategiesHttp = createStrategyHttp(stub, stub)
services.reviewsHttp = createReviewHttp(stub, stub)
services.tradeHistoryHttp = createTradeHistoryHttp(stub, stub)
services.marketHttp = createMarketHttp(stub, stub, stub, stub)
services.bridgeHttp = createBridgeHttp(stub, stub, stub)
services.tradingHttp = createTradingHttp(stub, stub, stub, stub)
services.observerManagementHttp = createObserverManagementHttp(stub, stub)
services.auth = { cookieName: cookieNameForClient }
services.authHttp = createAuthHttp(services.auth, false)
services.learningHttp = createLearningHttp({ read: stub, completion: stub }, services.auth, { wwwOrigin: 'https://www.example.test', secureCookies: false })
services.settingsHttp = createSettingsHttp({ read: stub, write: stub }, stub)
services.auditHttp = createAuditModule({ ownsAccount: unavailable, list: unavailable, find: unavailable }, { authenticate: unavailable }).http
try {
  await registerApiV4Routes(app, services, { tradeOrigin: 'https://trade.example.test', adminOrigin: 'https://admin.example.test' })
  await app.ready()
  const result = compareApiRoutes(document, routes)
  console.log(JSON.stringify({ ...result, scope: 'Actual Fastify registration with offline adapters; no request/response equivalence or business readiness claim.' }, null, 2))
  if (['missing', 'undocumented', 'parameterNameDifferences', 'duplicateContractRoutes', 'duplicateRuntimeRoutes',
    'missingOperationIds', 'duplicateOperationIds'].some(field => result[field].length)) process.exitCode = 1
} finally { await app.close() }
