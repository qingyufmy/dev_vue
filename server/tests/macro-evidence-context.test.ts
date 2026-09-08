import { createMysqlMacroSnapshotReader } from '../src/modules/inference/composition.js'
import { describe, expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import {
  AnalysisContextBuilder, InferenceError, contentHash, macroEvidencePlan,
  type AnalysisRun, type JsonObject, type MacroSnapshotReader,
} from '../src/modules/inference/index.js'
import type { StrategyVersion } from '../src/modules/strategies/index.js'

const now = new Date('2026-09-05T08:00:00.000Z')
const run: AnalysisRun = {
  id: 'analysis-1', userId: 42, strategyId: 'strategy-1', strategyVersionId: 'version-1', symbol: 'XAUUSD',
  marketSourceAccountId: null, trigger: 'scheduled', scheduleSlot: now.toISOString(), status: 'queued',
  inputSnapshotId: null, modelTaskId: null, marketAnalysisId: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), revision: 1,
}

function strategy(config: Record<string, unknown>): StrategyVersion {
  return {
    id: 'version-1', strategyId: 'strategy-1', kind: 'analysis', version: 1, promptText: '只分析行情',
    promptHash: 'a'.repeat(64), config, inputContractVersion: 'market-analysis-input/v1', outputContractVersion: 'market-analysis/v1',
  }
}

describe('M1 macro evidence context', () => {
  it('defaults missing or invalid configuration to off without touching the macro reader', async () => {
    let calls = 0
    const macro: MacroSnapshotReader = { async latest() { calls += 1; return { status: 'available' } } }
    const builder = new AnalysisContextBuilder({ async read() { return { symbol: 'XAUUSD' } } }, macro)

    expect(macroEvidencePlan({})).toEqual({ mode: 'off' })
    expect(macroEvidencePlan({ macro_evidence: { mode: 'required', accepted_schema_versions: [1], max_age_seconds: 172800 } })).toEqual({ mode: 'off' })
    await expect(builder.build(run, strategy({}), now)).resolves.toMatchObject({ macro: { status: 'disabled' } })
    expect(calls).toBe(0)
  })

  it('passes the frozen context limits and records an explicit unavailable state', async () => {
    let received: Parameters<MacroSnapshotReader['latest']>[0] | null = null
    const macro: MacroSnapshotReader = { async latest(input) { received = input; return null } }
    const builder = new AnalysisContextBuilder({ async read() { return { symbol: 'XAUUSD' } } }, macro)
    const config = { macro_evidence: { mode: 'context', accepted_schema_versions: [1, 2], max_age_seconds: 172800 } }

    await expect(builder.build(run, strategy(config), now)).resolves.toMatchObject({
      macro: { status: 'unavailable', reason: 'no_compatible_snapshot' },
    })
    expect(received).toEqual({ now: now.toISOString(), acceptedSchemaVersions: [1, 2], maxAgeSeconds: 172800 })
  })

  it('reads only compatible platform publications and exposes the restricted evidence projection', async () => {
    const payload: JsonObject = {
      analysis_evidence: { direction: 'uncertain', factors: [{ code: 'DFII10', gold_relation: 'adverse' }] },
      provider_licenses: { secret_internal_note: 'must-not-reach-model' },
    }
    let query: { sql: string; values: unknown[] } | null = null
    const pool = {
      async execute(sql: string, values: unknown[]) {
        query = { sql, values }
        return [[{
          id: 'macro-1', revision: 4, schema_version: 1,
          data_cutoff_at_utc: new Date('2026-09-05T07:00:00.000Z'), published_at_utc: new Date('2026-09-05T07:01:00.000Z'),
          valid_until_utc: new Date('2026-09-06T07:01:00.000Z'), freshness_status: 'fresh', health_status: 'healthy',
          horizon: 'medium_term', content_sha256: contentHash(payload), payload_json: payload,
        }], []]
      },
    } as unknown as Pool

    const result = await createMysqlMacroSnapshotReader(pool).latest({ now: now.toISOString(), acceptedSchemaVersions: [1], maxAgeSeconds: 172800 })
    const executedQuery = query as { sql: string; values: unknown[] } | null
    expect(executedQuery?.sql).toContain("owner_scope='platform' AND owner_user_id IS NULL")
    expect(executedQuery?.sql).toContain("publication_status='published'")
    expect(executedQuery?.values).toEqual([1, now.toISOString(), now.toISOString(), now.toISOString(), 172800, now.toISOString()])
    expect(result).toMatchObject({ status: 'available', id: 'macro-1', schema_version: 1, evidence: payload.analysis_evidence })
    expect(JSON.stringify(result)).not.toContain('provider_licenses')
    expect(JSON.stringify(result)).not.toContain('secret_internal_note')
  })

  it('fails closed when the stored payload hash or evidence projection is invalid', async () => {
    const base = {
      id: 'macro-1', revision: 1, schema_version: 1,
      data_cutoff_at_utc: now, published_at_utc: now, valid_until_utc: new Date('2026-09-06T08:00:00.000Z'),
      freshness_status: 'fresh', health_status: 'healthy', horizon: 'medium_term',
    }
    const hashMismatch = { async execute() { return [[{ ...base, content_sha256: '0'.repeat(64), payload_json: { analysis_evidence: {} } }], []] } } as unknown as Pool
    await expect(createMysqlMacroSnapshotReader(hashMismatch).latest({ now: now.toISOString(), acceptedSchemaVersions: [1], maxAgeSeconds: 172800 }))
      .rejects.toEqual(expect.objectContaining<Partial<InferenceError>>({ code: 'macro_snapshot_hash_mismatch' }))

    const payload = { display: { summary: 'only for UI' } }
    const missingEvidence = { async execute() { return [[{ ...base, content_sha256: contentHash(payload), payload_json: payload }], []] } } as unknown as Pool
    await expect(createMysqlMacroSnapshotReader(missingEvidence).latest({ now: now.toISOString(), acceptedSchemaVersions: [1], maxAgeSeconds: 172800 }))
      .rejects.toEqual(expect.objectContaining<Partial<InferenceError>>({ code: 'macro_snapshot_evidence_invalid' }))

    const invalidJson = { async execute() { return [[{ ...base, content_sha256: '0'.repeat(64), payload_json: '{broken' }], []] } } as unknown as Pool
    await expect(createMysqlMacroSnapshotReader(invalidJson).latest({ now: now.toISOString(), acceptedSchemaVersions: [1], maxAgeSeconds: 172800 }))
      .rejects.toEqual(expect.objectContaining<Partial<InferenceError>>({ code: 'macro_snapshot_payload_invalid' }))
  })
})
