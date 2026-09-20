import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlSystemTradeAttribution } from '../src/modules/trade-history/infrastructure/mysql-system-trade-attribution.js'

const hooks = vi.hoisted(() => ({ verify: null as null | ((facts: never[]) => Promise<boolean>),
  ready: { status: 'ready_as_of', taskId: 'task', completionHash: 'completion', evidence: {
    recordId: 'record', userId: 7, revision: 2, evidenceHash: 'hash' } } as Record<string, unknown> }))
vi.mock('../src/modules/trade-history/infrastructure/mysql-review-trade-evidence-reader.js', () => ({
  createMysqlSystemReviewTradeEvidenceReader: (_connection: unknown, verify: (facts: never[]) => Promise<boolean>) => { hooks.verify = verify; return {} },
}))
vi.mock('../src/modules/trade-history/application/review-trade-readiness.js', () => ({
  createReviewTradeReadinessReader: () => ({ read: async () => await hooks.verify!([]) ? hooks.ready : { status: 'unresolved', reason: 'source' } }),
}))

function fixture() {
  const proofs = [{ dealTicket: '1', orderTicket: '2', commandId: 'command', intentId: 'intent', action: 'order.place' as const,
    resultHash: 'result', decisionId: 'decision', riskDecisionId: 'risk', strategyId: '9', strategyVersionId: '10' }]
  const records = new Map<string, string>()
  let affectedRows = 1, inserts = 0
  const execute = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('SELECT proof_sha256')) return [records.has(String(args[1])) ? [{ proof_sha256: records.get(String(args[1])) }] : []]
    if (sql.includes('INSERT INTO account_trade_attributions')) { inserts++; records.set(String(args[1]), String(args[3])); return [{}] }
    if (sql.includes('UPDATE account_trade_records')) return [{ affectedRows }]
    if (sql.includes('SELECT revision')) return [[{ revision: 3 }]]
    return [[{ id: 'record' }]]
  })
  const source = vi.fn(async () => ({ status: 'proven' as const, strategyId: '9', strategyVersionId: '10', proofs }))
  const authorize = vi.fn(async () => true)
  const writer = createMysqlSystemTradeAttribution({ execute } as unknown as PoolConnection, { source, authorize })
  const input = { recordId: 'record', userId: 7, expectedRevision: 2, taskId: 'task', asOfUtcMsc: 1000,
    route: { userId: 7, accountId: '5', platform: 'mt5' } } as Parameters<typeof writer.reconcile>[0]
  return { writer, input, records, execute, authorize, proofs, inserts: () => inserts, failUpdate: () => { affectedRows = 0 } }
}

it('stores stable command proof once and locks the record before evidence reads', async () => {
  const f = fixture()
  expect(await f.writer.reconcile(f.input)).toMatchObject({ status: 'attributed', revision: 3, strategyVersionId: '10' })
  expect(f.execute.mock.calls[0]![0]).toContain('FOR UPDATE')
  await f.writer.reconcile(f.input)
  expect(f.inserts()).toBe(1)
})
it('performs no attribution writes after ownership rejection', async () => {
  const f = fixture(); f.authorize.mockResolvedValue(false)
  expect(await f.writer.reconcile(f.input)).toMatchObject({ status: 'unresolved', reason: 'system_trade_ownership_unavailable' })
  expect(f.execute.mock.calls.some(([sql]) => /INSERT|UPDATE account_trade_records/.test(sql))).toBe(false)
})
it('rejects changed proof and does not overwrite existing lineage', async () => {
  const f = fixture(); await f.writer.reconcile(f.input)
  f.proofs[0]!.intentId = 'changed'
  await expect(f.writer.reconcile(f.input)).rejects.toThrow('system_trade_attribution_conflict')
  expect(f.inserts()).toBe(1)
})
it('raises a revision error so the owning transaction rolls back all writes', async () => {
  const f = fixture(); f.failUpdate()
  await expect(f.writer.reconcile(f.input)).rejects.toThrow('system_trade_attribution_revision_changed')
})
