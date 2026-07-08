import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../server/db.js', () => ({
  queryAll: vi.fn(),
}))

import { queryAll } from '../../server/db.js'
import { getFixedAddress, getFixedAddressForChain, resetFixedAddressCache, generateUniqueAmount } from '../../server/crypto/fixed-address.js'

describe('getFixedAddress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFixedAddressCache()
  })

  it('从 DB 读取固定地址', async () => {
    queryAll.mockResolvedValueOnce([
      { key: 'fixed_tron_address', value: 'TTronAddr' },
      { key: 'fixed_erc20_address', value: '0xEthAddr' },
    ])

    const result = await getFixedAddress()
    expect(result.fixed_tron_address).toBe('TTronAddr')
    expect(result.fixed_erc20_address).toBe('0xEthAddr')
  })

  it('缓存生效后不再查 DB', async () => {
    queryAll.mockResolvedValueOnce([{ key: 'fixed_tron_address', value: 'TCached' }])
    await getFixedAddress()
    await getFixedAddress()
    expect(queryAll).toHaveBeenCalledTimes(1)
  })

  it('resetFixedAddressCache 清除缓存', async () => {
    queryAll.mockResolvedValueOnce([{ key: 'fixed_tron_address', value: 'TFirst' }])
    await getFixedAddress()
    resetFixedAddressCache()
    queryAll.mockResolvedValueOnce([{ key: 'fixed_tron_address', value: 'TSecond' }])
    const result = await getFixedAddress()
    expect(result.fixed_tron_address).toBe('TSecond')
    expect(queryAll).toHaveBeenCalledTimes(2)
  })
})

describe('getFixedAddressForChain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFixedAddressCache()
  })

  it('返回对应链的地址', async () => {
    queryAll.mockResolvedValueOnce([
      { key: 'fixed_tron_address', value: 'TAddr' },
      { key: 'fixed_erc20_address', value: '0xEthAddr' },
    ])
    expect(await getFixedAddressForChain('TRON')).toBe('TAddr')
    expect(await getFixedAddressForChain('ETH')).toBe('0xEthAddr')
  })

  it('未配置的链返回 null', async () => {
    queryAll.mockResolvedValueOnce([])
    expect(await getFixedAddressForChain('BTC')).toBeNull()
  })
})

describe('generateUniqueAmount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFixedAddressCache()
  })

  it('无已有订单时返回基础金额+1', async () => {
    queryAll.mockResolvedValueOnce([])
    const result = await generateUniqueAmount(50.001, 'order1', 'plus', 'month')
    expect(result).toBeGreaterThan(50)
    expect(result).toBeLessThan(51)
  })

  it('有冲突时生成不同尾数', async () => {
    queryAll.mockResolvedValueOnce([
      { crypto_amount: 50.000001 },
      { crypto_amount: 50.000002 },
    ])
    const result = await generateUniqueAmount(50.001, 'order2', 'plus', 'month')
    expect(result).toBe(50.000003)
  })

  it('基础金额整数部分正确', async () => {
    queryAll.mockResolvedValueOnce([])
    const result = await generateUniqueAmount(99.999, 'order3', 'plus', 'month')
    expect(Math.floor(result)).toBe(99)
  })
})
