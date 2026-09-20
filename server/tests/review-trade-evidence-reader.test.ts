import { createHash } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { canonicalEvidence } from '../src/modules/trade-history/domain/terminal-history-projection.js'
import { createMysqlReviewTradeEvidenceReader, createMysqlSystemReviewTradeEvidenceReader } from '../src/modules/trade-history/infrastructure/mysql-review-trade-evidence-reader.js'

function fixture(raw: Record<string, unknown> = { profit: '1', commission: '0', swap: '0', fee: '0' }) {
  const identity = { position_id: '100', symbol: 'XAUUSD', deal_kind: 'trade', account_currency: 'USD', currency_evidence: 'explicit_record', volume: '0.01' }
  const entry = canonicalEvidence({ ...identity, deal_ticket: '9', time_utc_msc: Date.parse('2026-09-11T01:00:00.000Z'), entry_kind: 'in', side: 'buy', price: '2500', profit: '0', commission: '0', swap: '0', fee: '0' })
  const evidence = canonicalEvidence({ ...identity, deal_ticket: '10', time_utc_msc: Date.parse('2026-09-11T02:00:00.000Z'), entry_kind: 'out', side: 'sell', price: '2501', ...raw })
  const row = { id: 'record-1', account_id: '5', user_id: 7, ownership_interval_id: 'interval-1', revision: 2,
    platform: 'mt5', position_id: '100', source_classification: 'manual', status: 'closed', attribution_status: 'exact', currency_evidence: 'explicit_record',
    account_currency: 'USD', evidence_sha256: createHash('sha256').update([entry.hash,evidence.hash].sort().join('|')).digest('hex'),
    opened_at: '2026-09-11T01:00:00.000000Z', closed_at: '2026-09-11T02:00:00.000000Z', terminal_timezone_offset_minutes: 180 }
  const facts = [{ id: 'entry-1', deal_ticket: '9', evidence_sha256: entry.hash, evidence_json: entry.json }, { id: 'deal-1', deal_ticket: '10', evidence_sha256: evidence.hash, evidence_json: evidence.json }]
  let queries = 0
  const connection = { async execute(_sql: string, params: unknown[]) {
    queries++
    return [_sql.includes('FROM account_trade_records_v4') ? params[1] === 7 ? [row] : [] : facts]
  } } as unknown as Pick<PoolConnection, 'execute'>
  return { connection, reader: createMysqlReviewTradeEvidenceReader(connection), row, facts, queries: () => queries }
}
const scope = { userId: 7, recordId: 'record-1', expectedRevision: 2 }
describe('review trade evidence SQL adapter', () => {
  it('captures owned closed evidence with original costs and canonical UTC dates', async () => {
    const f = fixture()
    const result = await f.reader.read(scope)
    expect(result).toMatchObject({ status: 'captured', evidence: { ownershipIntervalId: 'interval-1', openedAt: '2026-09-11T01:00:00.000Z',
      facts: [{ ticket: '9', costs: { complete: true } }, { ticket: '10', costs: { complete: true } }] } })
    expect(await f.reader.read({ ...scope, userId: 8 })).toEqual({ status: 'unresolved', reason: 'record_unavailable' })
  })
  it('stops before loading facts for changed revisions and non-exact attribution', async () => {
    const f = fixture()
    expect(await f.reader.read({ ...scope, expectedRevision: 1 })).toEqual({ status: 'unresolved', reason: 'revision_changed' })
    expect(f.queries()).toBe(1)
    f.row.attribution_status = 'unresolved'
    expect(await f.reader.read(scope)).toEqual({ status: 'unresolved', reason: 'record_not_eligible' })
    expect(f.queries()).toBe(2)
  })
  it('refuses omitted costs, duplicate joins and mismatched record hashes', async () => {
    expect(await fixture({ profit: '1' }).reader.read(scope)).toEqual({ status: 'unresolved', reason: 'cost_fields_incomplete' })
    const duplicate = fixture(); duplicate.facts.push(duplicate.facts[0]!)
    expect(await duplicate.reader.read(scope)).toEqual({ status: 'unresolved', reason: 'facts_incomplete' })
    const changed = fixture(); changed.row.evidence_sha256 = 'a'.repeat(64)
    expect(await changed.reader.read(scope)).toEqual({ status: 'unresolved', reason: 'facts_incomplete' })
  })
  it('admits unknown source only through fresh explicit verification after lifecycle checks', async () => {
    const f = fixture(), verify = vi.fn(async () => true)
    f.row.source_classification = 'unknown'
    f.row.attribution_status = 'unresolved'
    expect(await f.reader.read(scope)).toMatchObject({ status: 'unresolved' })
    const reader = createMysqlSystemReviewTradeEvidenceReader(f.connection, verify)
    expect(await reader.read(scope)).toMatchObject({ status: 'captured', evidence: { source: 'system' } })
    expect(verify.mock.calls).toHaveLength(1)
    verify.mockResolvedValue(false)
    expect(await reader.read(scope)).toMatchObject({ status: 'unresolved' })
    f.row.source_classification = 'manual'
    verify.mockClear()
    expect(await reader.read(scope)).toMatchObject({ status: 'unresolved' })
    expect(verify).not.toHaveBeenCalled()
  })
  it('never lets system attribution bypass missing costs or corrupted fact sets', async () => {
    const verify = vi.fn(async () => true), f = fixture({ profit: '1' })
    f.row.source_classification = 'unknown'
    expect(await createMysqlSystemReviewTradeEvidenceReader(f.connection, verify).read(scope)).toMatchObject({ reason: 'cost_fields_incomplete' })
    expect(verify).not.toHaveBeenCalled()
  })
})
