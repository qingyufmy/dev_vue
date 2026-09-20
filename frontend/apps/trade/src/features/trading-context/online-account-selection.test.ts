import { describe, expect, it } from 'vitest'
import { preferredOnlineAccount } from './online-account-selection'

describe('online account default', () => {
  const accounts = [
    { id: 'old', bridgeState: 'offline' as const },
    { id: 'mt4', bridgeState: 'online' as const },
    { id: 'mt5', bridgeState: 'online' as const },
  ]
  it('selects an online account instead of the first historical account', () => {
    expect(preferredOnlineAccount(accounts, null)).toBe('mt4')
    expect(preferredOnlineAccount(accounts, 'old')).toBe('mt4')
  })
  it('preserves a manually selected online account when inventory is reordered', () => {
    expect(preferredOnlineAccount(accounts, 'mt5')).toBe('mt5')
    expect(preferredOnlineAccount([...accounts].reverse(), 'mt4')).toBe('mt4')
  })
  it('does not treat paused, replaced or unauthorized accounts as online', () => {
    for (const bridgeState of ['offline', 'paused', 'replaced', 'unauthorized'] as const) {
      expect(preferredOnlineAccount([{ id: 'old', bridgeState }], 'old')).toBeNull()
    }
    expect(preferredOnlineAccount([], null)).toBeNull()
  })
})
