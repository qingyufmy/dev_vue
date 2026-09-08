import { expect, it } from 'vitest'
import { contextWriteFingerprintInput, normalizeContextWrite, type ContextWriteCommand } from '../src/modules/trading/domain/context-write.js'

const command: ContextWriteCommand = { userId: 42, requestId: 'd97382ac-4b49-42db-b1f1-850ec403848a',
  action: 'select_account', targetId: '7', expectedRevision: 3 }

it('copies a canonical command and fingerprints every operation-defining field', () => {
  expect(normalizeContextWrite(command)).toEqual(command)
  expect(normalizeContextWrite(command)).not.toBe(command)
  const original = contextWriteFingerprintInput(command)
  const reordered = { expectedRevision: 3, targetId: '7', action: 'select_account' as const, requestId: command.requestId, userId: 42 }
  expect(contextWriteFingerprintInput(reordered)).toBe(original)
  for (const change of [{ userId: 43 }, { requestId: 'd97382ac-4b49-42db-b1f1-850ec403848b' },
    { action: 'enter_observer' as const }, { targetId: '8' }, { expectedRevision: 4 }]) {
    expect(contextWriteFingerprintInput({ ...command, ...change })).not.toBe(original)
  }
})

it('requires a null target only for observer exit and preserves opaque target bytes', () => {
  expect(normalizeContextWrite({ ...command, action: 'leave_observer', targetId: null }).targetId).toBeNull()
  expect(normalizeContextWrite({ ...command, action: 'enter_observer', targetId: 'OBS:01' }).targetId).toBe('OBS:01')
  for (const change of [{ action: 'leave_observer', targetId: '7' }, { targetId: null },
    { targetId: '' }, { targetId: ' 7' }, { targetId: '7\n' }, { targetId: 'a'.repeat(192) }]) {
    expect(() => normalizeContextWrite({ ...command, ...change } as ContextWriteCommand)).toThrow('trading_context_invalid')
  }
})

it('rejects ambiguous identity, request keys, revisions and extra command fields', () => {
  for (const change of [{ userId: 0 }, { userId: 2147483648 }, { requestId: command.requestId.toUpperCase() },
    { requestId: command.requestId + '\n' }, { expectedRevision: null }, { expectedRevision: -1 },
    { expectedRevision: 1.5 }, { expectedRevision: Number.MAX_SAFE_INTEGER }, { action: 'other' }, { extra: true }]) {
    expect(() => normalizeContextWrite({ ...command, ...change } as ContextWriteCommand)).toThrow('trading_context_invalid')
  }
  expect(normalizeContextWrite({ ...command, expectedRevision: Number.MAX_SAFE_INTEGER - 1 }).expectedRevision).toBe(Number.MAX_SAFE_INTEGER - 1)
})
