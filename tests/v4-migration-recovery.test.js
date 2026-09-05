import { describe, expect, it, vi } from 'vitest'
import { authorizeRecovery, loadRecoveryPermit, validateRecoveryCorrection, validateRecoveryEvents, validateRecoveryEvidence } from '../scripts/lib/v4-migration-recovery.mjs'
import { sha256 } from '../scripts/lib/v4-migration-plan.mjs'
import { validateCorrectionEvents } from '../scripts/lib/v4-migration-events.mjs'

function evidence() {
  const permit = loadRecoveryPermit('m1-a-bootstrap-warning-20260905')
  const history = [{ id: permit.migrationId, execution_id: permit.originalExecutionId, status: 'failed',
    error_code: permit.errorCode, checksum_sha256: permit.originalChecksum, completed_statements: 2, statement_count: 7, completed_at_utc: null }]
  const counts = [{ name: 'users', count: '0' }]
  const bound = { ...permit, historyHash: sha256(JSON.stringify(history)), countsHash: sha256(JSON.stringify(counts)) }
  return { permit: bound, context: { targetDatabase: permit.targetDatabase, serverUuid: permit.serverUuid,
    hasEvents: false, history, counts, schema: { sha256: permit.schemaHash },
    migration: { id: permit.migrationId, checksum: permit.originalChecksum, statements: Array(7).fill('DDL') } } }
}

describe('reviewed one-use schema recovery', () => {
  it('has exactly named, frozen rehearsal permits, not arbitrary force parameters', () => {
    const a = loadRecoveryPermit('m1-a-bootstrap-warning-20260905')
    const b = loadRecoveryPermit('m1-b-011-foreign-keys-20260905')
    expect(Object.isFrozen(a)).toBe(true)
    expect(a.reconciledCheckpoint).toBe(3)
    expect(b.reconciledCheckpoint).toBe(2)
    expect(() => loadRecoveryPermit('force')).toThrow('migration_recovery_unknown')
    expect(a.checksum).toMatch(/^[0-9a-f]{64}$/)
  })
  it('accepts only the exact reviewed failure and successful DDL checkpoint gap', () => {
    const { permit, context } = evidence()
    expect(() => validateRecoveryEvidence(permit, context)).not.toThrow()
  })
  it('cannot resume B with the original broken ALTER or a mismatched correction', () => {
    const permit = loadRecoveryPermit('m1-b-011-foreign-keys-20260905')
    expect(() => validateRecoveryCorrection(permit, [])).toThrow('migration_recovery_correction_required')
    const correction = { ...permit.requiredCorrection, migrationId: permit.migrationId, originalChecksum: permit.originalChecksum }
    expect(() => validateRecoveryCorrection(permit, [correction])).not.toThrow()
    expect(() => validateRecoveryCorrection(permit, [{ ...correction, sqlChecksum: 'drift' }])).toThrow('migration_recovery_correction_required')
  })
  it('binds a recovery receipt to its original target and server', () => {
    const p = loadRecoveryPermit('m1-a-bootstrap-warning-20260905')
    const rows = [{ kind: 'recovery_authorized', artifact_id: p.id, artifact_sha256: p.checksum, migration_id: p.migrationId }]
    expect(() => validateRecoveryEvents(rows, { targetDatabase: p.targetDatabase, serverUuid: p.serverUuid })).not.toThrow()
    expect(() => validateRecoveryEvents(rows, { targetDatabase: 'dev_vue_m1_b', serverUuid: p.serverUuid })).toThrow('migration_recovery_evidence_invalid')
  })
  it.each([
    ['targetDatabase', 'dev_vue', 'target_mismatch'], ['serverUuid', 'another-server', 'target_mismatch'],
    ['hasEvents', true, 'already_attempted'], ['schema', { sha256: 'drift' }, 'schema_drift'],
    ['counts', [{ name: 'users', count: '1' }], 'data_drift'],
    ['migration', { id: 'other' }, 'plan_mismatch'],
  ])('fails closed on %s before any write', (field, value, error) => {
    const { permit, context } = evidence()
    expect(() => validateRecoveryEvidence(permit, { ...context, [field]: value })).toThrow(`migration_recovery_${error}`)
  })
  it('rejects changed execution, checkpoint, history, checksum and failure reason', () => {
    const { permit, context } = evidence()
    for (const change of [{ execution_id: 'new-id' }, { completed_statements: 3 }, { status: 'running' },
      { checksum_sha256: 'changed' }, { error_code: 'another-error' }]) {
      expect(() => validateRecoveryEvidence(permit, { ...context, history: [{ ...context.history[0], ...change }] }))
        .toThrow('migration_recovery_history_mismatch')
    }
    expect(() => validateRecoveryEvidence(permit, { ...context, history: [...context.history, { id: 'extra' }] }))
      .toThrow('migration_recovery_history_drift')
  })
  it('atomically archives original failure and establishes a new attempt without replaying DDL', async () => {
    const { permit, context } = evidence()
    const calls = []
    const control = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), query: vi.fn(async (sql, params) => {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT id,')) return [context.history]
      if (sql.startsWith('SELECT')) return [[{ started_at_utc: '2026-09-05T00:00:00.000Z' }]]
      return [{ affectedRows: 1 }]
    }) }
    const resume = await authorizeRecovery(control, permit, context.history, { schema: context.schema, counts: context.counts })
    expect(resume.startIndex).toBe(3)
    expect(resume.executionId).not.toBe(permit.originalExecutionId)
    expect(control.commit).toHaveBeenCalledOnce()
    expect(control.rollback).not.toHaveBeenCalled()
    expect(calls[2].sql).toContain('INSERT INTO schema_migration_events')
    expect(JSON.parse(calls[2].params[6]).originalHistory).toEqual(context.history)
    expect(calls[3].sql).toContain("WHERE id=? AND execution_id=? AND status='failed'")
    expect(calls.every(c => !/^(CREATE|ALTER|DELETE|DROP)/.test(c.sql))).toBe(true)
  })
  it('rolls back metadata if the guarded checkpoint update is not exactly one row', async () => {
    const { permit, context } = evidence()
    const control = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), query: vi.fn(async sql => {
      if (sql.startsWith('SELECT id,')) return [context.history]
      if (sql.startsWith('SELECT')) return [[{}]]
      return [{ affectedRows: sql.startsWith('UPDATE') ? 0 : 1 }]
    }) }
    await expect(authorizeRecovery(control, permit, context.history, {})).rejects.toThrow('migration_recovery_checkpoint_failed')
    expect(control.rollback).toHaveBeenCalledOnce()
    expect(control.commit).not.toHaveBeenCalled()
  })
  it('rechecks the complete history under transaction locks before the recovery audit write', async () => {
    const { permit, context } = evidence()
    const control = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), query: vi.fn(async () => [[]]) }
    await expect(authorizeRecovery(control, permit, context.history, {})).rejects.toThrow('migration_recovery_history_drift')
    expect(control.query).toHaveBeenCalledOnce()
    expect(control.query.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(control.rollback).toHaveBeenCalledOnce()
  })
})

describe('correction execution evidence', () => {
  const correction = { id: 'fix', migrationId: 'm', checksum: 'hash', statementNumber: 3 }
  const history = [{ id: 'm', execution_id: 'attempt', completed_statements: 3 }]
  const event = { migration_id: 'm', execution_id: 'attempt', artifact_id: 'fix', artifact_sha256: 'hash' }
  const events = [{ ...event, kind: 'correction_started' }, { ...event, kind: 'correction_completed' }]
  it('requires both exact-attempt receipts after a corrected statement checkpoint', () => {
    expect(() => validateCorrectionEvents(events, history, [correction])).not.toThrow()
    expect(() => validateCorrectionEvents([], history, [correction])).toThrow('migration_correction_receipt_missing')
    expect(() => validateCorrectionEvents(events.slice(0, 1), history, [correction])).toThrow('migration_correction_receipt_missing')
    expect(() => validateCorrectionEvents(events.map(e => ({ ...e, execution_id: 'old' })), history, [correction])).toThrow('migration_correction_receipt_missing')
    expect(() => validateCorrectionEvents([...events, events[1]], history, [correction])).toThrow('migration_correction_receipt_missing')
  })
  it('rejects a changed artifact even before checkpoint completion', () => {
    expect(() => validateCorrectionEvents([{ ...events[0], artifact_sha256: 'changed' }], [], [correction])).toThrow('migration_correction_evidence_invalid')
  })
})
