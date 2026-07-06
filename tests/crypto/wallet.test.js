import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryRun: vi.fn(),
  queryAll: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-02 12:00:00'),
}))

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let deriveAddress, validateAddress, getAddressCount, saveAddress, getRequiredConfirmations

beforeEach(async () => {
  process.env.HD_WALLET_MNEMONIC = TEST_MNEMONIC
  vi.resetModules()
  const mod = await import('../../server/crypto/wallet.js')
  deriveAddress = mod.deriveAddress
  validateAddress = mod.validateAddress
  getAddressCount = mod.getAddressCount
  saveAddress = mod.saveAddress
  getRequiredConfirmations = mod.getRequiredConfirmations
})

afterEach(() => {
  delete process.env.HD_WALLET_MNEMONIC
})

describe('deriveAddress', () => {
  it('derives a valid ETH address for index 0', () => {
    const addr = deriveAddress('ETH', 0)
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('derives deterministic addresses — same index always yields same address', () => {
    const a1 = deriveAddress('ETH', 0)
    const a2 = deriveAddress('ETH', 0)
    expect(a1).toBe(a2)
  })

  it('different indices produce different ETH addresses', () => {
    const a0 = deriveAddress('ETH', 0)
    const a1 = deriveAddress('ETH', 1)
    expect(a0).not.toBe(a1)
  })

  it('derives a valid BSC address (same as ETH format)', () => {
    const addr = deriveAddress('BSC', 0)
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('BSC and ETH index 0 produce the same address (both use m/44\'/60\'/0\'/0/0)', () => {
    const eth = deriveAddress('ETH', 0)
    const bsc = deriveAddress('BSC', 0)
    expect(eth).toBe(bsc)
  })

  it('derives a valid TRON address starting with T', () => {
    const addr = deriveAddress('TRON', 0)
    expect(addr).toMatch(/^T[A-Za-z1-9]{33}$/)
  })

  it('derives a valid SOL address (base58, 32-44 chars)', () => {
    const addr = deriveAddress('SOL', 0)
    expect(addr).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  })

  it('throws for unsupported chain', () => {
    expect(() => deriveAddress('BTC', 0)).toThrow()
  })

  it('throws when mnemonic is not set', async () => {
    delete process.env.HD_WALLET_MNEMONIC
    vi.resetModules()
    const mod = await import('../../server/crypto/wallet.js')
    expect(() => mod.deriveAddress('ETH', 0)).toThrow()
  })
})

describe('validateAddress', () => {
  it('returns true for valid ETH address', () => {
    const addr = deriveAddress('ETH', 0)
    expect(validateAddress('ETH', addr)).toBe(true)
  })

  it('returns true for valid TRON address', () => {
    const addr = deriveAddress('TRON', 0)
    expect(validateAddress('TRON', addr)).toBe(true)
  })

  it('returns true for valid SOL address', () => {
    const addr = deriveAddress('SOL', 0)
    expect(validateAddress('SOL', addr)).toBe(true)
  })

  it('returns false for malformed ETH address', () => {
    expect(validateAddress('ETH', '0x123')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(validateAddress('ETH', '')).toBe(false)
  })

  it('returns false for null/undefined', () => {
    expect(validateAddress('ETH', null)).toBe(false)
    expect(validateAddress('ETH', undefined)).toBe(false)
  })
})

describe('getAddressCount', () => {
  it('returns count from DB', async () => {
    const { queryOne } = await import('../../server/db.js')
    queryOne.mockResolvedValue({ cnt: 5 })
    const count = await getAddressCount('ETH')
    expect(count).toBe(5)
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('wallet_keys'),
      ['ETH']
    )
  })

  it('returns 0 when no rows exist', async () => {
    const { queryOne } = await import('../../server/db.js')
    queryOne.mockResolvedValue(null)
    const count = await getAddressCount('ETH')
    expect(count).toBe(0)
  })
})

describe('saveAddress', () => {
  it('inserts address into wallet_keys', async () => {
    const { queryRun } = await import('../../server/db.js')
    queryRun.mockResolvedValue({ insertId: 1, changes: 1 })
    await saveAddress('ETH', 0, '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12')
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO wallet_keys'),
      ['ETH', 0, '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12']
    )
  })
})

describe('getRequiredConfirmations', () => {
  it('returns 12 for ETH', () => {
    expect(getRequiredConfirmations('ETH')).toBe(12)
  })

  it('returns 12 for BSC', () => {
    expect(getRequiredConfirmations('BSC')).toBe(12)
  })

  it('returns 19 for TRON', () => {
    expect(getRequiredConfirmations('TRON')).toBe(19)
  })

  it('returns 32 for SOL', () => {
    expect(getRequiredConfirmations('SOL')).toBe(32)
  })

  it('returns default 12 for unknown chain', () => {
    expect(getRequiredConfirmations('BTC')).toBe(12)
  })
})
