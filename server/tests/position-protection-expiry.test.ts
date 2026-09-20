import { describe, expect, it, vi } from 'vitest'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { assertPositionProtectionNotPrepared, expirePositionProtection, verifyPositionProtectionExpiry } from '../src/modules/execution/infrastructure/mysql-position-protection-expiry.js'
import { sha256Canonical } from '../src/modules/execution/domain/execution.js'

const at = Date.parse('2026-09-10T10:00:00.123Z'), planHash = 'a'.repeat(64), requestHash = 'b'.repeat(64)
const scope = {workflowId:'11111111-1111-8111-a111-111111111111',userId:7,accountId:'5'}
function event() {
  const payload = {planHash,requestHash,deadline:at-1000,expiredAt:new Date(at).toISOString(),reason:'protection_deadline_elapsed'}
  return {revision:3,event_type:'expired',payload_json:payload,payload_sha256:sha256Canonical(payload)} as unknown as RowDataPacket
}
describe('unprepared protection expiry', () => {
  it('accepts a precise deadline receipt at or after the deadline', () => {
    expect(() => verifyPositionProtectionExpiry(event(),planHash,requestHash,at-1000,new Date(at))).not.toThrow()
  })
  it.each(['plan','request','deadline','future','hash','revision','reason','extra'])('rejects expiry receipt corruption %s', field => {
    const row = event(), payload = row.payload_json
    if (field === 'plan') payload.planHash = 'c'.repeat(64)
    if (field === 'request') payload.requestHash = 'c'.repeat(64)
    if (field === 'deadline') payload.deadline = at-2000
    if (field === 'future') payload.expiredAt = new Date(at+1).toISOString()
    if (field === 'revision') row.revision = 4
    if (field === 'reason') payload.reason = 'risk_rejected'
    if (field === 'extra') payload.review = 'fabricated'
    row.payload_sha256 = field === 'hash' ? 'c'.repeat(64) : sha256Canonical(payload)
    expect(() => verifyPositionProtectionExpiry(row,planHash,requestHash,at-1000,new Date(at))).toThrow('position_protection_expiry_corrupt')
  })
  it('refuses early expiry before attempting any SQL', async () => {
    const execute = vi.fn()
    await expect(expirePositionProtection({execute} as unknown as PoolConnection,scope,planHash,requestHash,at+1,new Date(at))).rejects.toThrow('expiry_not_due')
    expect(execute).not.toHaveBeenCalled()
  })
  it.each(['intent','operation'])('cannot expire an unreceipted %s', async kind => {
    const execute = vi.fn(async (sql: string) => [[...(sql.includes(kind === 'intent' ? 'FROM execution_intents' : 'FROM operations') ? [{id:'existing'}] : [])]])
    await expect(assertPositionProtectionNotPrepared({execute} as unknown as PoolConnection,scope.workflowId)).rejects.toThrow('unreceipted_child')
    expect(execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
  })
})
