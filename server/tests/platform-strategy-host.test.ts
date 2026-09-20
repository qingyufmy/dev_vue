import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { registerApiV4Routes, type ApiV4RouteServices } from '../src/transport/api-v4-route-registrar.js'

it('registers platform strategies on the admin host rather than the trade host', async () => {
  const empty = async () => {}
  const services = { authHttp: empty, settingsHttp: empty, referralRulesHttp: empty, observerManagementHttp: empty,
    bridgeHttp: empty, tradingHttp: empty, marketHttp: empty, inferenceHttp: empty, strategiesHttp: empty,
    riskHttp: empty, reviewsHttp: empty, executionHttp: empty, tradeHistoryHttp: empty, auditHttp: empty,
    platformStrategiesHttp: async (app: ReturnType<typeof Fastify>) => { app.get('/api/v4/admin/strategies', async () => ({ ok: true })) },
  } as unknown as ApiV4RouteServices
  const app = Fastify()
  await registerApiV4Routes(app, services, { tradeOrigin: 'http://localhost:4174', adminOrigin: 'http://localhost:4175' })
  try {
    expect((await app.inject({ url: '/api/v4/admin/strategies', headers: { host: 'localhost:4175' } })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v4/admin/strategies', headers: { host: 'localhost:4174' } })).statusCode).toBe(421)
  } finally { await app.close() }
})
