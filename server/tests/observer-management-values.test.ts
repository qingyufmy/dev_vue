import { describe, expect, it } from 'vitest'
import type { ResultSetHeader } from 'mysql2/promise'
import { insertedId, isPositiveId, parseResult, validateChannelConfig, validateSourceConfig, validateWrite } from '../src/modules/trading/infrastructure/mysql-observer-management-values.js'

describe('observer management storage boundaries', () => {
  it('accepts empty optional descriptions while bounding ids and slugs', () => {
    expect(() => validateSourceConfig({ displayName: 'Source', notes: '', tradingAccountId: null, analysisStrategyId: null, status: 'disabled' })).not.toThrow()
    const channel = { displayName: 'Channel', description: '', sourceId: null, slug: 'channel', active: false, audience: 'assigned' as const, sortOrder: 0 }
    expect(() => validateChannelConfig(channel)).not.toThrow()
    expect(() => validateChannelConfig({ ...channel, slug: 'a'.repeat(65) })).toThrow()
    expect(isPositiveId('18446744073709551615')).toBe(true)
    expect(isPositiveId('18446744073709551616')).toBe(false)
    expect(() => insertedId({ insertId: Number.MAX_SAFE_INTEGER + 1 } as ResultSetHeader)).toThrow()
  })

  it('rejects padded idempotency keys and only returns receipt contract fields', () => {
    const input = { actorUserId: 1, idempotencyKey: 'safe-key-1', requestHash: 'a'.repeat(64), command: { kind: 'channel.default' as const, channelId: null, expectedRevision: 0 } }
    expect(() => validateWrite(input)).not.toThrow()
    expect(() => validateWrite({ ...input, idempotencyKey: 'safe-key-1 ' })).toThrow()
    const result = { operation_id: '12345678-1234-1234-1234-123456789012', target_id: '1', revision: 1, registry_revision: 1 }
    expect(parseResult({ ...result, request_hash: 'secret' })).toEqual(result)
  })
})
