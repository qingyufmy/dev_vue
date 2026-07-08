import { describe, it, expect } from 'vitest'
import { generatePaymentQR } from '../../server/crypto/qr.js'
import { USDT_CONTRACTS } from '../../server/crypto/constants.js'

describe('generatePaymentQR', () => {
  it('TRON 链生成 data URL', async () => {
    const result = await generatePaymentQR('TRON', 'TTestAddr123', 50.001)
    expect(result).toMatch(/^data:image\/png;base64,/)
  })

  it('ETH 链生成 data URL', async () => {
    const result = await generatePaymentQR('ETH', '0xTestAddr', 100)
    expect(result).toMatch(/^data:image\/png;base64,/)
  })

  it('BSC 链生成 data URL', async () => {
    const result = await generatePaymentQR('BSC', '0xTestAddr', 25.5)
    expect(result).toMatch(/^data:image\/png;base64,/)
  })

  it('SOL 链生成 data URL', async () => {
    const result = await generatePaymentQR('SOL', 'So1TestAddr', 75)
    expect(result).toMatch(/^data:image\/png;base64,/)
  })

  it('不支持的链抛出错误', async () => {
    await expect(generatePaymentQR('BTC', 'addr', 10)).rejects.toThrow('Unsupported chain')
  })
})

describe('USDT_CONTRACTS', () => {
  it('包含 4 条链的合约地址', () => {
    expect(USDT_CONTRACTS.TRON).toMatch(/^T[A-Za-z0-9]{33}$/)
    expect(USDT_CONTRACTS.ETH).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(USDT_CONTRACTS.BSC).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(USDT_CONTRACTS.SOL).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  })
})
