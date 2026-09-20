import { capturePriceActionEvidence } from '../src/modules/market/index.js'
import { describe, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlAnalysisSourceReader } from '../src/modules/inference/infrastructure/mysql-analysis-source-reader.js'
import { contentHash } from '../src/modules/inference/domain/inference.js'

const scope = { userId: 7, analysisId: '00000000-0000-4000-8000-000000000001', analysisStrategyId: '10', symbol: 'XAUUSD' }
function fixture() {
  const payload = { kind: 'analysis', strategy: { id: '10', versionId: '11' }, market: { symbol: 'XAUUSD', source_account_id: '9' } }
  return { analysis_id: scope.analysisId, user_id: 7, strategy_id: '10', strategy_version_id: '11', standard_symbol: 'XAUUSD',
    snapshot_id: '00000000-0000-4000-8000-000000000002', snapshot_hash: contentHash(payload), source_account_id: '9' as string | null,
    payload_json: payload as unknown }
}
function reader(rows: unknown[]) {
  const execute = vi.fn(async () => [rows, []])
  return { execute, source: createMysqlAnalysisSourceReader({ execute } as unknown as Pick<PoolConnection, 'execute'>) }
}

describe('analysis source from persisted input lineage', () => {
  it.each([false, true])('returns a source proven by the frozen payload (manual source unspecified=%s)', async manual => {
    const row = fixture(); if (manual) row.source_account_id = null
    const { source, execute } = reader([row])
    expect(await source.read(scope)).toEqual({ analysisId: scope.analysisId, sourceAccountId: '9', strategyVersionId: '11',
      snapshotId: row.snapshot_id, snapshotHash: row.snapshot_hash })
    expect(execute.mock.calls[0]).toEqual([expect.any(String), [scope.analysisId, 7, '10', 'XAUUSD']])
  })
  it('accepts MySQL JSON text and returns no payload or prompt', async () => {
    const row = fixture(); row.payload_json = JSON.stringify(row.payload_json)
    const result = await reader([row]).source.read(scope)
    expect(Object.keys(result!).sort()).toEqual(['analysisId', 'snapshotHash', 'snapshotId', 'sourceAccountId', 'strategyVersionId'])
  })
  it('returns unavailable for absent or disconnected lineage, never a default account', async () => {
    expect(await reader([]).source.read(scope)).toBeNull()
  })
  it('rejects conflicting run source even with a valid snapshot digest', async () => {
    await expect(reader([{ ...fixture(), source_account_id: '8' }]).source.read(scope)).rejects.toMatchObject({ code: 'analysis_source_evidence_invalid' })
  })
  it.each([
    { user_id: 8 }, { analysis_id: '00000000-0000-4000-8000-000000000003' }, { strategy_id: '12' },
    { standard_symbol: 'EURUSD' }, { snapshot_hash: '0'.repeat(64) }, { payload_json: '{broken' },
  ])('rejects inconsistent stored evidence %j', async patch => {
    await expect(reader([{ ...fixture(), ...patch }]).source.read(scope)).rejects.toMatchObject({ code: 'analysis_source_evidence_invalid' })
  })
  it.each([
    { market: { symbol: 'XAUUSD' } }, { market: { symbol: 'XAUUSD', source_account_id: '18446744073709551616' } },
    { market: { symbol: 'EURUSD', source_account_id: '9' } }, { strategy: { id: '10', versionId: '12' } }, { kind: 'trader' },
  ])('rejects internally inconsistent payload even when its digest matches %j', async patch => {
    const row = fixture(), payload = { ...(row.payload_json as object), ...patch }
    row.payload_json = payload; row.snapshot_hash = contentHash(payload)
    await expect(reader([row]).source.read(scope)).rejects.toMatchObject({ code: 'analysis_source_evidence_invalid' })
  })
  it('rejects duplicate evidence and invalid requests', async () => {
    await expect(reader([fixture(), fixture()]).source.read(scope)).rejects.toMatchObject({ code: 'analysis_source_evidence_invalid' })
    const { source, execute } = reader([fixture()])
    await expect(source.read({ ...scope, analysisId: 'missing' })).rejects.toMatchObject({ code: 'analysis_source_evidence_invalid' })
    expect(execute).not.toHaveBeenCalled()
  })
})


it.each(['valid', 'suffix', 'hash', 'source', 'timeframe', 'capture-time'])('replays archived events and enforces their source binding: %s', async mode => {
  const row = fixture(), now = '2026-09-13T04:00:00.000Z'
  const bars = Array.from({ length: 30 }, (_, index) => ({ openTime: new Date(Date.parse(now) - (30 - index) * 300000).toISOString(),
    open: '100', high: '101', low: '99', close: '100', closed: true }))
  const context = { sourceAccountId: mode === 'source' ? '8' : '9', symbol: mode === 'suffix' ? 'XAUUSD.s' : 'XAUUSD', timeframe: 'M5', timeframeMs: 300000,
    referenceTime: now, clock: { clockStatus: 'calibrated', timezoneOffsetMinutes: 180, observedAt: now } }
  const evidence = capturePriceActionEvidence(bars, context)
  if (mode === 'hash') evidence.evidenceHash = '0'.repeat(64)
  const payload = { ...(row.payload_json as object), capturedAt: mode === 'capture-time' ? '2026-09-13T04:01:00.000Z' : now,
    market: { symbol: context.symbol, source_account_id: '9', events: { [mode === 'timeframe' ? 'M15' : 'M5']: evidence } } }
  row.payload_json = payload; row.snapshot_hash = contentHash(payload)
  const read = reader([row]).source.read(scope)
  if (mode !== 'valid' && mode !== 'suffix') { await expect(read).rejects.toMatchObject({ code: 'analysis_source_evidence_invalid' }); return }
  const result = await read
  expect(result?.priceActionEvents).toMatchObject({ M5: { state: 'ready', events: [], evidenceHash: evidence.evidenceHash } })
  expect(result?.priceActionEvents?.M5).not.toHaveProperty('input')
})
