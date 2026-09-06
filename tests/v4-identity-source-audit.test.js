import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { auditIdentitySourceBatch } from '../scripts/lib/v4-identity-source-audit.mjs'

const review = JSON.parse(readFileSync(new URL('../docs/migration/public-upgrade-u1-review-20260906.json', import.meta.url)))
function row(table, changes) {
  const contract = review.identity.tables.find(t => t.sourceTable === table)
  const cells = contract.fields.map(f => {
    const value = Object.hasOwn(changes, f.sourceColumn) ? changes[f.sourceColumn] : f.sourceNullable ? null : /^datetime/.test(f.sourceType) ? '2026-01-01 00:00:00' : /^(?:int|tinyint|bigint)/.test(f.sourceType) ? '1' : /^decimal/.test(f.sourceType) ? '0.00000000' : 'private-synthetic-value'
    return { column: f.sourceColumn, type: f.sourceType, charset: f.sourceCollation?.split('_')[0] ?? null, valueHex: value === null ? null : Buffer.from(value).toString('hex') }
  })
  const envelope = { encoding: 'mysql-sql-value-hex-v1', table, cells }
  return { envelope, sourceHash: hash(envelope), pk: contract.sourcePrimaryKey.map(name => {
    const cell = cells.find(c => c.column === name)
    return { type: /int/.test(cell.type) ? 'integer' : 'text', value: Buffer.from(cell.valueHex, 'hex').toString() }
  }) }
}
function batch() {
  const rows = Object.fromEntries(review.identity.tables.map(t => [t.sourceTable, []]))
  rows.users.push(row('users', { id: '1', role: 'user', plan: 'free', deletion_status: 'active', token_version: '2' }))
  rows.trading_accounts.push(row('trading_accounts', { id: '1', user_id: '1', broker_server: 'Broker', login_account: '00123' }))
  rows.mt5_account_ownership_history.push(row('mt5_account_ownership_history', { id: '1', user_id: '1', trading_account_id: '1', broker_server_key: 'Broker', login_account: '00123', ended_at: null }))
  rows.mt5_account_bindings.push(row('mt5_account_bindings', { current_user_id: '1', current_trading_account_id: '1', broker_server_key: 'Broker', login_account: '00123' }))
  return rows
}
describe('reviewed source envelopes to lifecycle and relationship diagnostics', () => {
  it('audits source-reader envelopes without exporting private values or admitting backfill', () => {
    const input = batch(), result = auditIdentitySourceBatch(review, input)
    expect(result.lifecycle[0]).toMatchObject({ stateConsistent: true, sourceLoginEligible: true })
    expect(result.ownership.exactRelationsConsistent).toBe(true)
    expect(result.counts.users.rows).toBe(1)
    expect(result.timeChecks.some(t => t.code === 'historical_time_basis_unverified')).toBe(true)
    expect(result.completeSourceVerified).toBe(false)
    expect(result.readyForBackfill).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(/private-synthetic-value|Broker|00123/)
  })
  it('propagates lifecycle inconsistencies and exact relation failures from actual source columns', () => {
    const input = batch()
    input.users = [row('users', { id: '1', role: 'user', plan: 'free', deletion_status: 'active', deleted_at: '2026-01-01 00:00:00', token_version: '2' })]
    input.mt5_account_bindings = [row('mt5_account_bindings', { current_user_id: '1', current_trading_account_id: '1', broker_server_key: 'BROKER', login_account: '00123' })]
    const result = auditIdentitySourceBatch(review, input)
    expect(result.lifecycle[0].issues).toContain('identity_active_with_deleted_time')
    expect(result.ownership.issues.map(i => i.code)).toContain('binding_identity_unresolved')
  })
  it('rejects incomplete table input, duplicate source rows and changed source hashes', () => {
    const missing = batch(); delete missing.users
    expect(() => auditIdentitySourceBatch(review, missing)).toThrow('backfill_shape_invalid')
    const duplicate = batch(); duplicate.users.push(duplicate.users[0])
    expect(() => auditIdentitySourceBatch(review, duplicate)).toThrow('identity_source_duplicate_row')
    const changed = batch(); changed.users[0].sourceHash = '0'.repeat(64)
    expect(() => auditIdentitySourceBatch(review, changed)).toThrow('identity_source_hash_mismatch')
  })
  it('keeps the source content digest stable under row reordering', () => {
    const input = batch()
    input.users.push(row('users', { id: '2', role: 'user', plan: 'free', deletion_status: 'active', token_version: '0' }))
    const before = auditIdentitySourceBatch(review, input).inputHash
    input.users.reverse()
    expect(auditIdentitySourceBatch(review, input).inputHash).toBe(before)
  })
})
