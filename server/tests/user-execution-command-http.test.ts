import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import type { UserExecutionCommandService } from '../src/modules/execution/application/user-execution-command-service.js'
import { UserExecutionCommandError } from '../src/modules/execution/domain/user-execution-command.js'
import { userExecutionCommandRoutes } from '../src/modules/execution/transport/http/user-execution-command-routes.js'

const body = { command_type: 'close_position', ticket: '9001', expected_state: {
  account_revision: '2', positions_revision: '3', pending_orders_revision: '4', quote_revision: '5',
  contract_revision: '6', risk_revision: '7', resource_revision: '11',
} }
async function fixture() {
  const result = { operation: { id: 'op-1', kind: 'user_execution_command', status: 'queued', parentOperationId: null,
    distributionId: null, acceptedAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    completedAt: null, resourceId: 'cmd-1', errorCode: null, revision: 1 }, command: { commandType: 'close_position' } }
  const execute = vi.fn().mockResolvedValue(result)
  const assertWrite = vi.fn().mockResolvedValue({ userId: 7 })
  const app = Fastify()
  await app.register(userExecutionCommandRoutes, { prefix: '/api/v4', service: { execute } as unknown as UserExecutionCommandService,
    auth: { assertWrite, async authenticate() { return { userId: 7 } } } })
  const send = (payload: unknown = body, headers = {}, suffix = '') => app.inject({ method: 'POST',
    url: '/api/v4/trading-accounts/42/execution-commands' + suffix, payload: payload as object,
    headers: { 'idempotency-key': 'command-request-0001', 'x-csrf-token': 'csrf-token-1234567890', ...headers } })
  return { app, execute, assertWrite, send, result }
}
it('accepts the canonical body, preserving identity, key and exact revision text', async () => {
  const f = await fixture(); try {
    const r = await f.send()
    expect(r.statusCode).toBe(202); expect(r.headers['cache-control']).toBe('no-store')
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, accountId: '42', idempotencyKey: 'command-request-0001',
      expected: expect.objectContaining({ resourceRevision: '11' }), commandType: 'close_position' }))
  } finally { await f.app.close() }
})
it('checks authentication first and rejects unknown fields and alternate command shapes before execution', async () => {
  const f = await fixture(); try {
    f.assertWrite.mockRejectedValueOnce(new AuthError('csrf_invalid', 403))
    expect((await f.send({})).statusCode).toBe(403)
    for (const payload of [{ ...body, actor: 1 }, { ...body, command_type: 'other' },
      { commandType: 'close_position', ticket: '9001', expected: body.expected_state },
      { ...body, expected_state: { ...body.expected_state, resource_revision: 11 } }]) {
      expect((await f.send(payload)).statusCode).toBe(400)
    }
    expect((await f.send(body, {}, '?actor=2')).statusCode).toBe(400)
    expect((await f.send(body, { 'idempotency-key': '' })).statusCode).toBe(428)
    expect(f.execute).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})
it('retains conflict details and returns uncertainty after malformed committed output', async () => {
  const f = await fixture(); try {
    f.execute.mockRejectedValueOnce(new UserExecutionCommandError('user_command_expected_state_stale', 409, { resource: 'positions' }))
    const conflict = await f.send()
    expect(conflict.statusCode).toBe(409); expect(conflict.json().errors).toEqual([{ field: 'resource', code: 'user_command_expected_state_stale', message: 'positions' }])
    f.execute.mockResolvedValueOnce({ ...f.result, operation: { ...f.result.operation, status: 'private-invalid' } })
    const r = await f.send()
    expect(r.statusCode).toBe(503); expect(r.json().code).toBe('user_command_commit_unknown')
    expect(r.body).not.toContain('private-invalid'); expect(f.execute).toHaveBeenCalledTimes(2)
  } finally { await f.app.close() }
})
it('maps all six canonical command variants without losing explicit removal flags or decimal strings', async () => {
  const f = await fixture(); try {
    const { resource_revision: _resource, ...expected } = body.expected_state
    const cases = [
      { payload: { command_type: 'market_order', side: 'buy', symbol: 'XAUUSD', volume: '0.01', stop_loss: '2490', reference_price: '2500', expected_state: expected },
        parameters: { volume: '0.01', stopLoss: '2490', referencePrice: '2500' } },
      { payload: { command_type: 'pending_order', order_type: 'buy_limit', symbol: 'XAUUSD', volume: '0.01', stop_loss: '2480', reference_price: '2500', price: '2490', expected_state: expected },
        parameters: { orderType: 'buy_limit', price: '2490', volume: '0.01' } },
      { payload: { command_type: 'modify_position', ticket: '9001', remove_stop_loss: true, take_profit: '2510', expected_state: body.expected_state },
        parameters: { ticket: '9001', removeStopLoss: true, takeProfit: '2510' } },
      { payload: body, parameters: { ticket: '9001' } },
      { payload: { command_type: 'modify_order', ticket: '9001', price: '2491', remove_expiration: true, expected_state: body.expected_state },
        parameters: { ticket: '9001', price: '2491', removeExpiration: true } },
      { payload: { command_type: 'cancel_order', ticket: '9001', expected_state: body.expected_state }, parameters: { ticket: '9001' } },
    ]
    for (const { payload, parameters } of cases) {
      const r = await f.send(payload)
      expect(r.statusCode, payload.command_type).toBe(202)
      expect(f.execute).toHaveBeenLastCalledWith(expect.objectContaining({ commandType: payload.command_type,
        parameters: expect.objectContaining(parameters) }))
    }
    expect(f.execute).toHaveBeenCalledTimes(6)
  } finally { await f.app.close() }
})
