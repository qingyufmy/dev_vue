import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { contentHash } from '../src/modules/inference/domain/inference.js'
import { createMysqlTradeDecisionAnalysisReader } from '../src/modules/inference/infrastructure/mysql-trade-decision-analysis-reader.js'

const input = { decisionId: 'decision-1', riskDecisionId: 'risk-1', userId: 7, accountId: '11' }
const origin = { decision_id: 'decision-1', user_id: 7, account_id: '11', strategy_id: '21', strategy_version_id: '31' }
const payload = { kind: 'analysis', strategy: { id: '41', versionId: '51' },
  market: { symbol: 'XAUUSD.a', candles: {} }, capturedAt: '2026-09-09T00:00:00.000Z' }
const row = { analysis_id: 'analysis-1', snapshot_id: 'snapshot-1', strategy_id: '41', strategy_version_id: '51',
  standard_symbol: 'XAUUSD.a', payload_json: payload, payload_sha256: contentHash(payload) }
function fixture(rows: unknown[] = [row], origins: unknown[] = [origin]) {
  const execute = vi.fn().mockResolvedValueOnce([origins, []]).mockResolvedValueOnce([rows, []])
  return { execute, reader: createMysqlTradeDecisionAnalysisReader({ execute } as unknown as PoolConnection) }
}
it('returns the exact frozen analysis while retaining the distinct trader strategy origin', async () => {
  const { reader, execute } = fixture()
  expect(await reader.read(input)).toEqual({ decisionId: input.decisionId, userId: 7, accountId: '11', strategyId: '21', strategyVersionId: '31',
    analysisId: 'analysis-1', snapshotId: 'snapshot-1', snapshotHash: row.payload_sha256,
    symbol: 'XAUUSD.a', capturedAt: payload.capturedAt, market: payload.market,
    atr: { status: 'unavailable', reason: 'insufficient_closed_hourly_bars' } })
  expect(execute.mock.calls[1]![1]).toEqual(['decision-1', 'risk-1', 7, '11'])
  const sql = execute.mock.calls[1]![0] as string
  for (const condition of ['a.id=d.market_analysis_id', 'a.owner_user_id=d.user_id', 'r.input_snapshot_id=a.input_snapshot_id',
    's.strategy_version_id=a.strategy_version_id', "s.purpose='analysis'", 'FOR SHARE']) expect(sql).toContain(condition)
})
it('does not query an analysis when accepted decision provenance is absent', async () => {
  const { reader, execute } = fixture([row], [])
  expect(await reader.read(input)).toBeNull()
  expect(execute).toHaveBeenCalledTimes(1)
})
it.each([{ rows: [] }, { rows: [row, row] }])('rejects missing or ambiguous frozen input', async ({ rows }) => {
  expect(await fixture(rows).reader.read(input)).toBeNull()
})
it('accepts JSON text without synthesizing an ATR field', async () => {
  const result = await fixture([{ ...row, payload_json: JSON.stringify(payload) }]).reader.read(input)
  expect(result?.market).toEqual(payload.market)
  expect(result?.market).not.toHaveProperty('atr')
})
it.each([
  { payload_json: '{' }, { payload_sha256: '0'.repeat(64) }, { standard_symbol: 'XAUUSD.A' },
  { strategy_id: '21' }, { strategy_version_id: '31' },
])('rejects corrupted or mismatched evidence %j', async patch => {
  expect(await fixture([{ ...row, ...patch }]).reader.read(input)).toBeNull()
})
it.each(['2026-02-30T00:00:00.000Z', '2026-09-09T03:00:00.000+03:00'])('rejects invalid UTC capture time %s', async capturedAt => {
  const changed = { ...payload, capturedAt }
  expect(await fixture([{ ...row, payload_json: changed, payload_sha256: contentHash(changed) }]).reader.read(input)).toBeNull()
})
it('propagates storage errors rather than treating them as missing ATR', async () => {
  const { reader, execute } = fixture()
  execute.mockReset().mockResolvedValueOnce([[origin], []]).mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(reader.read(input)).rejects.toThrow('storage unavailable')
})
