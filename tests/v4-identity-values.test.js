import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { compareIdentityCandidates, inspectIdentityValues, representIdentityValue } from '../scripts/lib/v4-identity-values.mjs'

const review = JSON.parse(readFileSync(new URL('../docs/migration/public-upgrade-u1-review-20260906.json', import.meta.url)))
const users = review.identity.tables.find(t => t.sourceTable === 'users')
function sourceRow(contract = users, overrides = {}) {
  const cells = contract.fields.map(f => {
    const value = Object.hasOwn(overrides, f.sourceColumn) ? overrides[f.sourceColumn] : f.sourceNullable ? null : /^(?:int|tinyint|bigint)/.test(f.sourceType) ? '1' : /^decimal/.test(f.sourceType) ? '0.00000000' : /^datetime/.test(f.sourceType) ? '2026-09-06 12:00:00' : 'sample'
    return { column: f.sourceColumn, type: f.sourceType, charset: f.sourceCollation?.split('_')[0] ?? null, valueHex: value === null ? null : Buffer.from(value).toString('hex') }
  })
  const envelope = { encoding: 'mysql-sql-value-hex-v1', table: contract.sourceTable, cells }
  const pk = contract.sourcePrimaryKey.map(name => {
    const cell = cells.find(c => c.column === name)
    return { type: /int/.test(cell.type) ? 'integer' : 'text', value: Buffer.from(cell.valueHex, 'hex').toString() }
  })
  return { pk, envelope, sourceHash: hash(envelope) }
}
const field = (result, name) => result.fields.find(f => f.sourceColumn === name)

describe('identity scalar candidates without migration admission', () => {
  it('registers every field in all eleven reviewed tables without promoting specialized rules', () => {
    let count = 0
    for (const table of review.identity.tables) {
      const result = inspectIdentityValues(table, sourceRow(table))
      expect(result.fields.map(f => f.sourceColumn)).toEqual(table.fields.map(f => f.sourceColumn))
      expect(result.readyForBackfill).toBe(false)
      table.fields.forEach(f => {
        if (!['b2.exact', 'b2.legacy-id', 'b2.decimal'].includes(f.transformId)) expect(field(result, f.sourceColumn).status).toBe('deferred')
      })
      count += result.fields.length
    }
    expect(count).toBe(148)
  })
  it('accounts for all 34 user fields and preserves credentials, NULL and exact referral credit', () => {
    const result = inspectIdentityValues(users, sourceRow(users, { password: '$2b$unchanged', email: '', phone: null, referred_by: '000123', referral_credit: '123456789012.12345678' }))
    expect(result.fields).toHaveLength(34)
    expect(field(result, 'password').value).toBe('$2b$unchanged')
    expect(field(result, 'email').value).toBe('')
    expect(field(result, 'phone').value).toBeNull()
    expect(field(result, 'referral_credit').value).toBe('123456789012.12345678')
    expect(field(result, 'referral_credit').blockers).toContain('G-MEMBER')
    expect(field(result, 'created_at').status).toBe('deferred')
    expect(field(result, 'deleted_at').status).toBe('deferred')
    expect(field(result, 'telegram_id').status).toBe('deferred')
    expect(result.readyForBackfill).toBe(false)
  })
  it('rejects NULL-to-required and overflow without filling defaults or truncating', () => {
    const result = inspectIdentityValues(users, sourceRow(users, { password: null, nickname: 'x'.repeat(101), referral_credit: '1000000000000.00000000' }))
    expect(field(result, 'password').code).toBe('identity_null_forbidden')
    expect(field(result, 'nickname').code).toBe('identity_text_too_long')
    expect(field(result, 'referral_credit').code).toBe('identity_decimal_overflow')
  })
  it('keeps integer and decimal precision exact and refuses rounding or coercion', () => {
    expect(representIdentityValue('18446744073709551615', 'bigint unsigned', false)).toBe('18446744073709551615')
    expect(() => representIdentityValue('18446744073709551616', 'bigint unsigned', false)).toThrow('identity_integer_overflow')
    expect(representIdentityValue('-0.000', 'decimal(20,8)', false)).toBe('0.00000000')
    expect(representIdentityValue('1.2300', 'decimal(5,2)', false)).toBe('1.23')
    expect(() => representIdentityValue('1.2301', 'decimal(5,2)', false)).toThrow('identity_decimal_rounding_forbidden')
    for (const value of ['1e2', ' 1', '+1', '01', 1]) expect(() => representIdentityValue(value, 'int', false)).toThrow()
    expect(() => representIdentityValue('1.2', 'double', false)).toThrow('identity_type_unsupported')
  })
  it('rejects source tampering, omitted/repeated fields and PK disagreement', () => {
    for (const mode of ['hash', 'missing', 'duplicate', 'pk', 'type']) {
      const row = sourceRow()
      if (mode === 'hash') row.sourceHash = '0'.repeat(64)
      if (mode === 'missing') row.envelope.cells.pop()
      if (mode === 'duplicate') row.envelope.cells[1] = row.envelope.cells[0]
      if (mode === 'pk') row.pk[0].value = '2'
      if (mode === 'type') row.envelope.cells[1].type = 'varchar(999)'
      if (mode !== 'hash') row.sourceHash = hash(row.envelope)
      expect(() => inspectIdentityValues(users, row)).toThrow()
    }
  })
  it('does not replace malformed UTF-8 or normalize Unicode text', () => {
    const row = sourceRow(users, { nickname: 'e\u0301 ' })
    expect(field(inspectIdentityValues(users, row), 'nickname').value).toBe('e\u0301 ')
    row.envelope.cells.find(c => c.column === 'nickname').valueHex = 'ff'
    row.sourceHash = hash(row.envelope)
    expect(field(inspectIdentityValues(users, row), 'nickname').code).toBe('identity_encoding_invalid')
  })
  it('compares separate target values and reports missing, unexpected and changed fields without values', () => {
    const inspected = inspectIdentityValues(users, sourceRow(users, { password: 'sensitive-original' }))
    const actual = Object.fromEntries(inspected.fields.filter(f => f.status === 'candidate').map(f => [f.target, f.value]))
    const match = compareIdentityCandidates(inspected, actual)
    expect(match.candidateValuesMatch).toBe(true)
    expect(match.deferredOrBlocked).toBeGreaterThan(0)
    expect(match.fullRowReconciled).toBe(false)
    delete actual['users.email']; actual['users.password'] = 'sensitive-changed'; actual.extra = 'sensitive-extra'
    const diff = compareIdentityCandidates(inspected, actual)
    expect(diff.differences).toEqual(expect.arrayContaining([{ target: 'users.email', code: 'missing' }, { target: 'users.password', code: 'value_mismatch' }, { target: 'extra', code: 'unexpected' }]))
    expect(JSON.stringify(diff)).not.toContain('sensitive')
    expect(diff.readyForBackfill).toBe(false)
  })
  it('never counts an empty comparison as completed', () => {
    const result = compareIdentityCandidates({ fields: [{ status: 'deferred' }] }, {})
    expect(result.candidateValuesMatch).toBe(false)
    expect(result.fullRowReconciled).toBe(false)
  })
})
