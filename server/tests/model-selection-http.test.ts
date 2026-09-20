import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { modelSelectionRoutes } from '../src/modules/inference/transport/http/model-selection-routes.js'

it('checks the session and exact write contract before selecting a model', async () => {
  const state = { selected_model_profile_id: '3', items: [{ id: '3', name: 'Shared', scope: 'platform' as const, available: true, reason: null }] }
  const read = vi.fn().mockResolvedValue(state), select = vi.fn().mockResolvedValue(state)
  const authenticate = vi.fn().mockResolvedValue({ userId: 7 }), assertWrite = vi.fn().mockResolvedValue({ userId: 7 })
  const app = Fastify()
  await app.register(modelSelectionRoutes, { prefix: '/api/v4', service: { read, select }, auth: { authenticate, assertWrite } })
  try {
    expect((await app.inject('/api/v4/model-selection')).json().data).toEqual(state)
    const write = { method: 'PUT' as const, url: '/api/v4/model-selection', headers: { 'x-csrf-token': 'csrf-token-123456789' } }
    expect((await app.inject({ ...write, payload: { model_profile_id: '3', expected_model_profile_id: '1', user_id: 99 } })).statusCode).toBe(400)
    expect(select).not.toHaveBeenCalled()
    const result = await app.inject({ ...write, payload: { model_profile_id: '3', expected_model_profile_id: '1' } })
    expect(result.statusCode, result.body).toBe(200)
    expect(select).toHaveBeenCalledWith(7, '3', '1')
    expect(assertWrite).toHaveBeenCalledTimes(2)
  } finally { await app.close() }
})
