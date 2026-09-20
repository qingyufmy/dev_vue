import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { ExecutionError, ExecutionService, type ApprovedRiskExecutionSource, type ExecutionRepository, type Operation, type PersistPreparedExecutionInput } from '../src/modules/execution/index.js'
import { executionRoutes } from '../src/modules/execution/transport/http/execution-routes.js'

const operation: Operation = {
  id: 'op-1', userId: 42, accountId: '7', kind: 'risk_decision_execution', status: 'queued',
  sourceType: 'risk_decision', sourceId: 'risk-1', idempotencyScope: 'risk_decision', idempotencyKey: 'risk_decision:risk-1',
  requestHash: 'a'.repeat(64), resourceType: 'execution_intent', resourceId: 'intent-1', errorCode: null,
  acceptedAt: '2026-09-03T08:00:00.000Z', updatedAt: '2026-09-03T08:00:00.000Z', completedAt: null, revision: 1,
  intentIds: ['intent-1'],
}

class ReadRepository implements ExecutionRepository {
  async replayPreparedExecution() { return null }
  async loadApprovedRiskSource(): Promise<ApprovedRiskExecutionSource | null> { return null }
  async persistPreparedExecution(_input: PersistPreparedExecutionInput): Promise<never> { throw new ExecutionError('not_used', 500) }
  async getOperation(userId: number, operationId: string) { return userId === 42 && operationId === operation.id ? operation : null }
  async expirePrepared() { return [] }
}

describe('Stage 12E persistence and transport boundaries', () => {
  it('authenticates before request validation and hides malformed operation output', async () => {
    const repo = new ReadRepository()
    const getOperation = vi.spyOn(repo, 'getOperation')
    const authenticate = vi.fn().mockResolvedValue({ userId: 42 })
    const app = Fastify()
    await app.register(executionRoutes, { prefix: '/api/v4', service: new ExecutionService(repo), auth: { authenticate } })
    try {
      authenticate.mockRejectedValueOnce(new AuthError('auth_session_invalid', 401))
      const denied = await app.inject('/api/v4/operations/op-1?actor=2')
      expect(denied.statusCode).toBe(401)
      expect(denied.headers['content-type']).toContain('application/problem+json')
      expect(denied.headers['cache-control']).toBe('no-store')
      expect((await app.inject('/api/v4/operations/op-1?actor=2')).statusCode).toBe(400)
      expect(getOperation).not.toHaveBeenCalled()
      getOperation.mockResolvedValueOnce({ ...operation, status: 'private-invalid-status' } as unknown as Operation)
      const invalid = await app.inject('/api/v4/operations/op-1')
      expect(invalid.statusCode).toBe(503)
      expect(invalid.json().code).toBe('api_response_invalid')
      expect(invalid.body).not.toContain('private-invalid-status')
      expect(getOperation).toHaveBeenCalledWith(42, 'op-1')
    } finally { await app.close() }
  })
  it('exposes only the current user operation through the V4 HTTP contract', async () => {
    const app = Fastify({ logger: false })
    await app.register(executionRoutes, { prefix: '/api/v4', service: new ExecutionService(new ReadRepository()), auth: { async authenticate() { return { userId: 42 } } } })
    const found = await app.inject({ method: 'GET', url: '/api/v4/operations/op-1' })
    expect(found.statusCode).toBe(200)
    expect(found.json().data).toEqual({ operation_id: 'op-1', kind: 'risk_decision_execution', status: 'queued', accepted_at: operation.acceptedAt, updated_at: operation.updatedAt, completed_at: null, resource_id: 'intent-1', error_code: null, revision: '1', parent_operation_id: null, distribution_id: null, result_summary: null })
    const missing = await app.inject({ method: 'GET', url: '/api/v4/operations/op-2' })
    expect(missing.statusCode).toBe(404)
    await app.close()
  })

  it('creates append-only side-by-side V4 execution tables without touching legacy rows or Bridge', async () => {
    const migration = await readFile(new URL('../db/migrations/20260903_009_execution_intents_and_reservations.sql', import.meta.url), 'utf8')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS operations')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS execution_intents')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS risk_reservations_v4')
    expect(migration).toContain('reserved_risk_amount')
    expect(migration).toContain('reserved_risk_percent')
    expect(migration).toContain('risk_decision_revision')
    expect(migration).toContain('account_risk_revision')
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM|UPDATE order_intents|UPDATE risk_reservations\b/i)
    expect(migration).not.toMatch(/bridge_commands|command\.request|OrderSend/i)
  })

  it('keeps the MySQL preparation transaction free of terminal and network calls and writes one small outbox invalidation', async () => {
    const repository = await readFile(new URL('../src/modules/execution/infrastructure/mysql-execution-repository.ts', import.meta.url), 'utf8')
    expect(repository).toContain("'operation.changed'")
    expect(repository).toContain("status IN ('active','committed') FOR UPDATE")
    expect(repository).toContain('FOR UPDATE')
    expect(repository).not.toMatch(/bridge|fetch\(|axios|websocket|ordersend/i)
  })

  it('publishes the Stage 12E operation contract while keeping action payloads off realtime', async () => {
    const openapi = await readFile(new URL('../../contracts/openapi-v4.json', import.meta.url), 'utf8')
    const realtime = await readFile(new URL('../../contracts/realtime-v4.schema.json', import.meta.url), 'utf8')
    expect(openapi).toContain('stage-12s-authoritative-trade-history')
    expect(openapi).toContain('/operations/{operation_id}')
    expect(realtime).toContain('operation.changed')
    expect(realtime).not.toContain('expected_state_sha256')
    expect(realtime).not.toContain('reserved_risk_amount')
  })
})
