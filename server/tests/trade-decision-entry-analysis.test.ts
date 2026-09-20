import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { contentHash } from '../src/modules/inference/domain/inference.js'
import { createMysqlTradeDecisionEntryAnalysisReader } from '../src/modules/inference/infrastructure/mysql-trade-decision-entry-analysis-reader.js'

const scope = { decisionId: 'decision-1', riskDecisionId: 'risk-1', userId: 7, accountId: '11', strategyId: '21', strategyVersionId: '31', symbol: 'XAUUSD.a' }
function fixture() {
  const result = { marketBias: 'bullish', opportunity: 'long_setup', confidence: 80, summary: 'entry', marketRegime: 'trend',
    supportingEvidence: ['closed bars'], counterEvidence: [], dataGaps: [], keyLevels: { accelerationByTimeframe: { H1: true } },
    invalidation: {}, analysisBody: 'historical', analyzedAt: '2020-01-01T00:01:00.000Z', validUntil: '2020-01-01T00:10:00.000Z' }
  const input = { kind: 'analysis', strategy: { id: '41', versionId: '51' }, market: { symbol: scope.symbol }, capturedAt: '2020-01-01T00:00:00.000Z' }
  const trader = { kind: 'trader', strategy: { id: '21', versionId: '31' }, account: { id: '11' },
    capturedAt: '2020-01-01T00:02:00.000Z', analysis: { id: 'analysis-1', contentHash: contentHash(result), result: structuredClone(result) } }
  const row = { decision_id: 'decision-1', risk_decision_id: 'risk-1', user_id: 7, account_id: '11', trader_strategy_id: '21', trader_version_id: '31',
    analysis_id: 'analysis-1', analysis_strategy_id: '41', analysis_version_id: '51', standard_symbol: scope.symbol,
    analysis_hash: contentHash(result), result_hash: contentHash(result), result_json: result,
    input_id: 'snapshot-1', input_hash: contentHash(input), input_json: input,
    trader_input_id: 'trader-snapshot-1', trader_input_hash: contentHash(trader), trader_input_json: trader }
  const execute = vi.fn().mockResolvedValue([[row]])
  return { row, result, input, trader, execute, reader: createMysqlTradeDecisionEntryAnalysisReader({ execute } as unknown as PoolConnection) }
}
it('reads expired historical evidence and retains distinct analyst/trader versions and all three hashes', async () => {
  const f = fixture(), value = await f.reader.read(scope)
  expect(value).toMatchObject({ ...scope, analysisStrategyId: '41', analysisStrategyVersionId: '51', analysisHash: f.row.analysis_hash,
    inputSnapshotHash: f.row.input_hash, traderInputSnapshotHash: f.row.trader_input_hash, result: f.result })
  f.result.summary = 'mutated'
  expect(value?.result.summary).toBe('entry')
  const sql = f.execute.mock.calls[0]![0] as string
  expect(sql).not.toMatch(/FOR SHARE|FOR UPDATE|UTC_TIMESTAMP|ORDER BY/)
  for (const condition of ["d.status='accepted'", "tr.status='succeeded'", 'tr.input_snapshot_id=d.input_snapshot_id',
    "ar.status='succeeded'", 'ar.input_snapshot_id=a.input_snapshot_id', "s.purpose='analysis'", "ts.purpose='trader'",
    'ts.trading_account_id=d.trading_account_id', 'BINARY a.standard_symbol=BINARY ?', 'LIMIT 2']) expect(sql).toContain(condition)
  expect(f.execute.mock.calls[0]![1]).toEqual(['decision-1', 'risk-1', 7, '11', '21', '31', 'XAUUSD.a'])
})
it.each(['result_hash', 'analysis_hash', 'input_hash', 'trader_input_hash'] as const)('rejects corrupt %s', async field => {
  const f = fixture(); f.row[field] = '0'.repeat(64)
  expect(await f.reader.read(scope)).toBeNull()
})
it.each(['decision_id', 'risk_decision_id', 'account_id', 'trader_strategy_id', 'trader_version_id', 'standard_symbol'] as const)('rejects mismatched %s', async field => {
  const f = fixture(); f.row[field] = 'other'
  expect(await f.reader.read(scope)).toBeNull()
})
it.each(['result', 'hash', 'id'])('rejects a validly hashed trader snapshot pinned to a different analysis %s', async field => {
  const f = fixture()
  if (field === 'result') f.trader.analysis.result.summary = 'different'
  if (field === 'hash') f.trader.analysis.contentHash = '0'.repeat(64)
  if (field === 'id') f.trader.analysis.id = 'analysis-2'
  f.row.trader_input_hash = contentHash(f.trader)
  expect(await f.reader.read(scope)).toBeNull()
})
it.each(['input-version', 'trader-version', 'account', 'future-input', 'expired-at-capture', 'malformed-result'])('rejects validly hashed contradictory evidence: %s', async kind => {
  const f = fixture()
  if (kind === 'input-version') f.input.strategy.versionId = '52'
  if (kind === 'trader-version') f.trader.strategy.versionId = '32'
  if (kind === 'account') f.trader.account.id = '12'
  if (kind === 'future-input') f.input.capturedAt = '2020-01-01T00:03:00.000Z'
  if (kind === 'expired-at-capture') f.trader.capturedAt = f.result.validUntil
  if (kind === 'malformed-result') { f.result.confidence = 101; f.trader.analysis.result = structuredClone(f.result) }
  f.row.analysis_hash = f.row.result_hash = contentHash(f.result); f.trader.analysis.contentHash = f.row.analysis_hash
  f.row.input_hash = contentHash(f.input); f.row.trader_input_hash = contentHash(f.trader)
  expect(await f.reader.read(scope)).toBeNull()
})
it('keeps storage errors visible and rejects missing, duplicate or malformed payloads', async () => {
  const f = fixture()
  for (const rows of [[], [f.row, f.row], [{ ...f.row, result_json: '{' }]]) {
    f.execute.mockResolvedValueOnce([rows]); expect(await f.reader.read(scope)).toBeNull()
  }
  f.execute.mockRejectedValueOnce(Error('database_unavailable'))
  await expect(f.reader.read(scope)).rejects.toThrow('database_unavailable')
})
it('validates scope before SQL and freezes it across asynchronous reads', async () => {
  const f = fixture()
  await expect(f.reader.read({ ...scope, strategyVersionId: '0' })).rejects.toThrow('entry_analysis_scope_invalid')
  expect(f.execute).not.toHaveBeenCalled()
  const request = { ...scope }, pending = f.reader.read(request); request.accountId = '99'
  expect(await pending).toMatchObject({ accountId: '11' })
})
