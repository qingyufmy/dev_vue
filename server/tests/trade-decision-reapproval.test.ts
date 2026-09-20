import { expect, it } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createTradeDecisionReapprovalWriter } from '../src/modules/inference/composition.js'

const input = { userId: 7, accountId: '5', decisionId: 'decision', riskDecisionId: 'old-risk' }
function fixture(updated = 1, state = 'consumed', risk = 'old-risk') {
  const calls: { sql: string; args: unknown[] }[] = []
  const db = { async execute(sql: string, args: unknown[]) {
    calls.push({ sql, args })
    if (sql.startsWith('UPDATE trade_decisions')) return [{ affectedRows: updated }]
    if (sql.startsWith('SELECT state')) return [[{ state, risk_decision_id: risk }]]
    return [{ affectedRows: 1 }]
  } } as unknown as PoolConnection
  return { calls, writer: createTradeDecisionReapprovalWriter(db) }
}
it('atomically reserves the same event and emits a new review without overwriting the prior approval', async () => {
  const { writer, calls } = fixture()
  expect(await writer.request(input)).toBe(true)
  expect(calls).toHaveLength(4)
  expect(calls[0]!.args).toEqual(['decision',7,'5','old-risk'])
  expect(calls[2]!.sql).not.toContain('active_event_id=NULL')
  expect(calls[2]!.sql).toContain("state='reserved',risk_decision_id=NULL")
  expect(JSON.parse(calls[3]!.args[2] as string)).toMatchObject({ decision_id: 'decision', status: 'proposed', previous_risk_decision_id: 'old-risk' })
  expect(calls.some(call => /UPDATE risk_decisions_v4|UPDATE trade_decision_payloads/.test(call.sql))).toBe(false)
})
it('a stale approval or duplicate request produces no event or claim mutation', async () => {
  const { writer, calls } = fixture(0)
  expect(await writer.request(input)).toBe(false)
  expect(calls).toHaveLength(1)
})
it.each([['released','old-risk'], ['consumed','other-risk']])('fails on inconsistent claims, for caller transaction rollback', async (state, risk) => {
  const { writer, calls } = fixture(1,state,risk)
  await expect(writer.request(input)).rejects.toThrow('entry_event_reapproval_conflict')
  expect(calls).toHaveLength(2)
})
it('creates distinct outbox identities for successive approvals of the same decision', async () => {
  const first = fixture(), second = fixture(1, 'consumed', 'next-risk')
  await first.writer.request(input)
  await second.writer.request({ ...input, riskDecisionId: 'next-risk' })
  expect(first.calls[3]!.args[0]).not.toBe(second.calls[3]!.args[0])
})
