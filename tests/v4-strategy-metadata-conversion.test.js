import { describe, expect, it } from 'vitest'
import { convertStrategyMetadata } from '../scripts/lib/v4-strategy-metadata-conversion.mjs'

const source = changes => ({ id: '1', title: '策略', description: '', system_prompt: '  原始\r\n提示词  ', scope: 'platform', owner_user_id: '0', created_by: '7',
  is_active: '1', visibility_status: 'active', version: '44', created_at: '2026-01-01 12:00:00', updated_at: '2026-01-02 12:00:00', deleted_at: null, ...changes })
const convert = changes => convertStrategyMetadata(source(changes), new Set(['7']))

describe('strategy metadata conversion', () => {
  it('keeps current version and exact text without inventing history or activation', () => {
    const result = convert()
    expect(result.status).toBe('converted')
    expect(result.candidate).toMatchObject({ currentVersionNumber: '44', scope: 'platform', ownerUserId: null, description: '' })
    expect(result.executable).toBe(false)
    expect(result.historicalVersionsReconstructed).toBe(false)
    expect(result.candidate.promptHash).not.toBe(convert({ system_prompt: source().system_prompt.trim() }).candidate.promptHash)
    expect(JSON.stringify(result)).not.toContain('原始')
  })
  it('preserves ownership and rejects missing or contradictory owners', () => {
    expect(convert({ scope: 'private', owner_user_id: '7' }).candidate).toMatchObject({ scope: 'user', ownerUserId: '7' })
    expect(convert({ scope: 'private', owner_user_id: '8' }).status).toBe('blocked')
    expect(convert({ owner_user_id: '7' }).status).toBe('blocked')
  })
  it('retires deleted and archived rows, without guessing contradictory active flags', () => {
    expect(convert({ deleted_at: '2026-01-03 12:00:00' }).candidate.status).toBe('retired')
    expect(convert({ visibility_status: 'archived' }).candidate.status).toBe('retired')
    expect(convert({ visibility_status: 'draft', is_active: '0' }).candidate.status).toBe('draft')
    expect(convert({ is_active: '0' }).status).toBe('blocked')
  })
  it('uses database character limits and refuses truncation', () => {
    expect(convert({ title: '😀'.repeat(191) }).status).toBe('converted')
    expect(convert({ title: '😀'.repeat(192) }).candidate).toBeNull()
    expect(convert({ description: '文'.repeat(2001) }).candidate).toBeNull()
  })
  it('checks target integer ranges without rounding the source identifier', () => {
    expect(convert({ id: '9007199254740993', version: '4294967295' }).candidate).toMatchObject({ legacyId: '9007199254740993', currentVersionNumber: '4294967295' })
    expect(convert({ version: '4294967296' }).status).toBe('blocked')
    expect(convert({ id: '18446744073709551616' }).status).toBe('blocked')
  })
  it('keeps unresolved time evidence separate from UTC and rejects missing source fields', () => {
    expect(convert().blockers).toContain('historical_time_basis')
    expect(convert({ created_at: '2026-01-01 13:00:00' }).timeSourceHash).not.toBe(convert().timeSourceHash)
    expect(() => convert({ title: undefined })).toThrow('strategy_metadata_source_shape')
  })
})
