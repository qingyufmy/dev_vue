import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { RiskService } from '../src/modules/risk/application/risk-service.js'
import type { RiskRepository } from '../src/modules/risk/application/risk-ports.js'
import { MysqlRiskRepository } from '../src/modules/risk/infrastructure/mysql-risk-repository.js'
import { riskRoutes } from '../src/modules/risk/transport/http/risk-routes.js'

it('returns unconfirmed for an absent exact receipt without creating another operation', async () => {
  const lookup = vi.fn(async () => null)
  const service = new RiskService({ getManualReleaseByIdempotency: lookup } as unknown as RiskRepository)
  expect(await service.manualReleaseReceipt(42, '7', 'original-key')).toEqual({ state: 'unconfirmed', release: null })
  expect(lookup).toHaveBeenCalledWith(42, '7', 'original-key')
  await expect(service.manualReleaseReceipt(42, '7', 'bad')).rejects.toMatchObject({ code: 'idempotency_key_invalid' })
  expect(lookup).toHaveBeenCalledTimes(1)
})

it('returns the exact stored operation, including expiry, and refuses cross-scope repository results', async () => {
  const release = { userId: 42, accountId: '7', id: 'original-release', status: 'expired' }
  const lookup = vi.fn(async () => ({ release, requestHash: 'original-hash' }))
  const service = new RiskService({ getManualReleaseByIdempotency: lookup } as unknown as RiskRepository)
  expect(await service.manualReleaseReceipt(42, '7', 'original-key')).toEqual({ state: 'confirmed', release })
  for (const [userId, accountId] of [[43, '7'], [42, '8']] as const) {
    await expect(service.manualReleaseReceipt(userId, accountId, 'original-key')).rejects.toMatchObject({ code: 'risk_account_forbidden' })
  }
})

it('rejects revoked ownership before loading even an absent receipt', async () => {
  const execute = vi.fn(async () => [[]])
  const repository = new MysqlRiskRepository({ execute } as unknown as Pool, () => { throw Error('unexpected write') })
  await expect(repository.getManualReleaseByIdempotency(42, '7', 'original-key')).rejects.toMatchObject({ code: 'risk_account_forbidden' })
  expect(execute).toHaveBeenCalledTimes(1)
})

it('exposes unconfirmed through the generated contract and rejects missing keys before lookup', async () => {
  const lookup = vi.fn(async () => null)
  const service = new RiskService({ getManualReleaseByIdempotency: lookup } as unknown as RiskRepository)
  const app = Fastify()
  await app.register(riskRoutes, { prefix: '/api/v4', service,
    auth: { authenticate: async () => ({ userId: 42 }), assertWrite: async () => { throw Error('unexpected write') } } })
  try {
    const path = '/api/v4/risk-accounts/7/manual-release-receipt'
    const missing = await app.inject({ url: path })
    expect(missing.statusCode).toBe(400)
    expect(lookup).not.toHaveBeenCalled()
    const response = await app.inject({ url: path + '?idempotency_key=original-key' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({ data: { state: 'unconfirmed', release: null } })
    expect(lookup).toHaveBeenCalledWith(42, '7', 'original-key')
  } finally { await app.close() }
})
