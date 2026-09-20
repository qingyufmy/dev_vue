import { describe, expect, it } from 'vitest'
import { contentHash } from '../src/modules/inference/domain/inference.js'
import { createMysqlProposedDecisionEvidenceReader } from '../src/modules/inference/infrastructure/mysql-proposed-decision-evidence-reader.js'

const scope = { decisionId: 'decision-1', decisionRevision: 1, userId: 7, accountId: '5', analysisRevision: 2 }
function fixture() {
  const decision = { confidence: 80, action: 'hold', actions: [] }
  const snapshot = { kind: 'analysis', strategy: { id: '1', versionId: '11' }, market: { symbol: 'XAUUSD' }, capturedAt: '2026-09-09T00:00:00.000Z' }
  return { decision_id: 'decision-1', decision_revision: 1, user_id: 7, account_id: '5', analysis_revision: 2,
    decision_hash: contentHash(decision), decision_payload: decision, confidence: 80,
    analysis_id: 'analysis-1', snapshot_id: 'snapshot-1', snapshot_hash: contentHash(snapshot), snapshot_payload: snapshot,
    strategy_id: '1', strategy_version_id: '11', standard_symbol: 'XAUUSD' }
}
const reader = (rows: unknown[]) => createMysqlProposedDecisionEvidenceReader({ async execute() { return [rows] } } as never)

describe('proposed decision frozen evidence reader', () => {
  it('returns exact scoped and hash-verified frozen evidence without assuming old coverage', async () => {
    const result = await reader([fixture()]).read(scope)
    expect(result?.confidence).toBe(80)
    expect(result?.snapshotId).toBe('snapshot-1')
    expect(result?.market.candle_coverage).toBeUndefined()
  })
  it('rejects missing, duplicate or mismatched scope rows', async () => {
    expect(await reader([]).read(scope)).toBeNull()
    expect(await reader([fixture(), fixture()]).read(scope)).toBeNull()
    for (const overrides of [{ user_id: 8 }, { account_id: '6' }, { decision_revision: 2 }, { analysis_revision: 3 }, { confidence: 70 }]) {
      expect(await reader([{ ...fixture(), ...overrides }]).read(scope)).toBeNull()
    }
  })
  it('rejects changed payloads and a valid hash with mismatched embedded strategy or time', async () => {
    const changed = fixture(); changed.decision_payload.confidence = 70
    expect(await reader([changed]).read(scope)).toBeNull()
    for (const mutate of [
      (row: ReturnType<typeof fixture>) => { row.snapshot_payload.strategy.id = '2' },
      (row: ReturnType<typeof fixture>) => { row.snapshot_payload.market.symbol = 'EURUSD' },
      (row: ReturnType<typeof fixture>) => { row.snapshot_payload.capturedAt = '2026-02-30T00:00:00.000Z' },
    ]) {
      const row = fixture(); mutate(row); row.snapshot_hash = contentHash(row.snapshot_payload)
      expect(await reader([row]).read(scope)).toBeNull()
    }
  })
  it('keeps caller scope frozen while reading and limits SQL to the proposed phase', async () => {
    const input = { ...scope }
    const actual = createMysqlProposedDecisionEvidenceReader({ async execute(sql: string, args: unknown[]) {
      expect(args).toEqual(['decision-1', 1, 7, '5', 2])
      expect(sql).toContain("d.status='proposed' AND d.risk_decision_id IS NULL")
      expect(sql).toContain('LIMIT 2 FOR SHARE')
      expect(sql).toContain('a.revision=tr.analysis_revision')
      input.userId = 99
      return [[fixture()]]
    } } as never)
    expect((await actual.read(input))?.userId).toBe(7)
  })
})
