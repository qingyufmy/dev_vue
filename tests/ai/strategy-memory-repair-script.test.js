import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../scripts/repair-strategy-memory-integrity.mjs', import.meta.url), 'utf8')

describe('strategy memory integrity repair script', () => {
  it('is dry-run by default and requires an exact execute confirmation', () => {
    expect(source).toContain("argv.includes('--execute')")
    expect(source).toContain("executeConfirmation:'REPAIR_CASE_1201_STRATEGY_MEMORY'")
    expect(source).toContain('execution_confirmation_required')
  })

  it('pins the known broken lineage and fails closed on every invariant', () => {
    for (const value of ['caseId:1201', 'approvedVersionId:39', 'pendingUpdateId:1',
      'compressionJobId:2', 'incorrectRevisionId:3', 'currentVersionNo:3']) {
      expect(source).toContain(value)
    }
    expect(source).toContain('repair_target_changed_after_dry_run')
    expect(source).toContain('corrective_library_cas_failed')
    expect(source).toContain('corrective_pending_cas_failed')
    expect(source).toContain('corrective_compression_job_create_failed')
  })

  it('preserves history and writes a corrective revision instead of deleting rows', () => {
    expect(source).toContain("'corrective_memory_merge'")
    expect(source).toContain("'monthly_review'")
    expect(source).toContain('strategy_memory_integrity_corrected')
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i)
  })

  it('removes raw applicability metadata only from the corrected runtime body', () => {
    expect(source).toContain('removeLegacyApplicabilityLines')
    expect(source).toContain('applicable_when|avoid_when')
    expect(source).toContain('2026-07 月复盘确认经验')
  })
})
