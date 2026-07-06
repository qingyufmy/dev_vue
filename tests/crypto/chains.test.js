import { describe, it, expect, vi, beforeEach } from 'vitest'

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryRun: vi.fn(),
  queryAll: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-02 12:00:00'),
}))

function mockFetch(jsonBody) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(jsonBody),
  })
}

function mockFetchFail(status = 404) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: 'not found' }),
  })
}

beforeEach(() => {
  process.env.HD_WALLET_MNEMONIC = TEST_MNEMONIC
  vi.resetModules()
})

describe('BaseChainAdapter', () => {
  it('throws when instantiated directly', async () => {
    const { BaseChainAdapter } = await import('../../server/crypto/chains/base.js')
    expect(() => new BaseChainAdapter()).toThrow()
  })

  it('requires subclass to implement abstract methods', async () => {
    const { BaseChainAdapter } = await import('../../server/crypto/chains/base.js')
    class Empty extends BaseChainAdapter {}
    const adapter = new Empty()
    expect(() => adapter.getApiBaseUrl()).toThrow(/[Nn]ot implemented/)
    expect(() => adapter.getRequiredConfirmations()).toThrow(/[Nn]ot implemented/)
    expect(() => adapter.buildTransferEventFilter([])).toThrow(/[Nn]ot implemented/)
  })

  it('deriveAddress returns address and publicKey', async () => {
    const { BaseChainAdapter } = await import('../../server/crypto/chains/base.js')
    class Stub extends BaseChainAdapter {
      getApiBaseUrl() { return 'https://stub.io' }
      getRequiredConfirmations() { return 1 }
      buildTransferEventFilter() { return {} }
      _deriveRaw() { return { address: '0xABC', publicKey: '0xPUB' } }
    }
    const adapter = new Stub()
    const result = adapter.deriveAddress(0)
    expect(result).toEqual({ address: '0xABC', publicKey: '0xPUB' })
  })

  it('name and chainId are set from constructor', async () => {
    const { BaseChainAdapter } = await import('../../server/crypto/chains/base.js')
    class Stub extends BaseChainAdapter {
      name = 'StubChain'
      chainId = 'stub'
      getApiBaseUrl() { return '' }
      getRequiredConfirmations() { return 1 }
      buildTransferEventFilter() { return {} }
      _deriveRaw() { return { address: '', publicKey: '' } }
    }
    const adapter = new Stub()
    expect(adapter.name).toBe('StubChain')
    expect(adapter.chainId).toBe('stub')
  })
})

describe('TRON Adapter', () => {
  it('has correct properties', async () => {
    const { tronAdapter } = await import('../../server/crypto/chains/tron.js')
    expect(tronAdapter.name).toBe('TRON')
    expect(tronAdapter.chainId).toBe('tron')
    expect(tronAdapter.getRequiredConfirmations()).toBe(19)
    expect(tronAdapter.getApiBaseUrl()).toBe('https://api.trongrid.io')
  })

  it('deriveAddress returns a valid TRON address', async () => {
    const { tronAdapter } = await import('../../server/crypto/chains/tron.js')
    const { address } = tronAdapter.deriveAddress(0)
    expect(address).toMatch(/^T[A-Za-z1-9]{33}$/)
  })

  it('getTransaction calls TronGrid API', async () => {
    mockFetch({
      ret: [{ contractResult: 'SUCCESS' }],
      raw_data: {
        contract: [{
          parameter: { value: { amount: 1000000, ownerAddress: 'Txxx', toAddress: 'Tyyy' } },
        }],
      },
      block_header: { raw_data: { number: 100 } },
    })
    const { tronAdapter } = await import('../../server/crypto/chains/tron.js')
    const tx = await tronAdapter.getTransaction('abc123')
    expect(tx.hash).toBe('abc123')
    expect(tx.status).toBe('success')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('trongrid.io/v1/transactions/abc123'),
    )
  })

  it('getTransaction returns null for failed fetch', async () => {
    mockFetchFail()
    const { tronAdapter } = await import('../../server/crypto/chains/tron.js')
    const tx = await tronAdapter.getTransaction('bad')
    expect(tx).toBeNull()
  })

  it('getConfirmations returns number', async () => {
    mockFetch({ block_number: 100 })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ block_number: 100 }),
    })
    const { tronAdapter } = await import('../../server/crypto/chains/tron.js')
    const conf = await tronAdapter.getConfirmations('tx123')
    expect(typeof conf).toBe('number')
    expect(conf).toBeGreaterThanOrEqual(0)
  })

  it('buildTransferEventFilter returns filter object with addresses', async () => {
    const { tronAdapter } = await import('../../server/crypto/chains/tron.js')
    const filter = tronAdapter.buildTransferEventFilter(['Taddr1', 'Taddr2'])
    expect(filter.addresses).toEqual(['Taddr1', 'Taddr2'])
    expect(filter.topic).toBeDefined()
  })
})

describe('ETH Adapter', () => {
  it('has correct properties', async () => {
    const { ethAdapter } = await import('../../server/crypto/chains/eth.js')
    expect(ethAdapter.name).toBe('ETH')
    expect(ethAdapter.chainId).toBe('eth')
    expect(ethAdapter.getRequiredConfirmations()).toBe(12)
    expect(ethAdapter.getApiBaseUrl()).toBe('https://api.etherscan.io')
  })

  it('deriveAddress returns a valid ETH address', async () => {
    const { ethAdapter } = await import('../../server/crypto/chains/eth.js')
    const { address } = ethAdapter.deriveAddress(0)
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('getTransaction calls Etherscan API', async () => {
    mockFetch({
      jsonrpc: '2.0',
      id: 1,
      result: {
        hash: '0xABC',
        from: '0x111',
        to: '0x222',
        value: '0x1000000',
        blockNumber: '0x64',
      },
    })
    const { ethAdapter } = await import('../../server/crypto/chains/eth.js')
    const tx = await ethAdapter.getTransaction('0xABC')
    expect(tx.hash).toBe('0xABC')
    expect(tx.status).toBe('pending')
  })

  it('getTransaction returns null on empty result', async () => {
    mockFetch({ jsonrpc: '2.0', id: 1, result: null })
    const { ethAdapter } = await import('../../server/crypto/chains/eth.js')
    const tx = await ethAdapter.getTransaction('0xBAD')
    expect(tx).toBeNull()
  })

  it('buildTransferEventFilter returns filter object', async () => {
    const { ethAdapter } = await import('../../server/crypto/chains/eth.js')
    const filter = ethAdapter.buildTransferEventFilter(['0xAddr1', '0xAddr2'])
    expect(filter.addresses).toEqual(['0xAddr1', '0xAddr2'])
    expect(filter.topic).toBeDefined()
  })
})

describe('BSC Adapter', () => {
  it('has correct properties', async () => {
    const { bscAdapter } = await import('../../server/crypto/chains/bsc.js')
    expect(bscAdapter.name).toBe('BSC')
    expect(bscAdapter.chainId).toBe('bsc')
    expect(bscAdapter.getRequiredConfirmations()).toBe(15)
    expect(bscAdapter.getApiBaseUrl()).toBe('https://api.bscscan.com')
  })

  it('deriveAddress returns a valid BSC address', async () => {
    const { bscAdapter } = await import('../../server/crypto/chains/bsc.js')
    const { address } = bscAdapter.deriveAddress(0)
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('getTransaction calls BSCScan API', async () => {
    mockFetch({
      status: '1',
      result: [{
        hash: '0xDEF',
        from: '0x333',
        to: '0x444',
        value: '2000000',
        blockNumber: '200',
        confirmations: '3',
      }],
    })
    const { bscAdapter } = await import('../../server/crypto/chains/bsc.js')
    const tx = await bscAdapter.getTransaction('0xDEF')
    expect(tx.hash).toBe('0xDEF')
  })

  it('buildTransferEventFilter returns filter object', async () => {
    const { bscAdapter } = await import('../../server/crypto/chains/bsc.js')
    const filter = bscAdapter.buildTransferEventFilter(['0xBscAddr'])
    expect(filter.addresses).toEqual(['0xBscAddr'])
    expect(filter.topic).toBeDefined()
  })
})

describe('SOL Adapter', () => {
  it('has correct properties', async () => {
    const { solAdapter } = await import('../../server/crypto/chains/sol.js')
    expect(solAdapter.name).toBe('SOL')
    expect(solAdapter.chainId).toBe('sol')
    expect(solAdapter.getRequiredConfirmations()).toBe(32)
    expect(solAdapter.getApiBaseUrl()).toBe('https://api.mainnet-beta.solana.com')
  })

  it('deriveAddress returns a valid SOL address', async () => {
    const { solAdapter } = await import('../../server/crypto/chains/sol.js')
    const { address } = solAdapter.deriveAddress(0)
    expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  })

  it('getTransaction calls Solana RPC', async () => {
    mockFetch({
      jsonrpc: '2.0',
      result: {
        transaction: {
          message: { accountKeys: ['from111', 'to222'], instructions: [] },
          signatures: ['sig1'],
        },
        meta: { err: null, fee: 5000, preBalances: [100, 200], postBalances: [95, 205], blockTime: 1234567890 },
      },
    })
    const { solAdapter } = await import('../../server/crypto/chains/sol.js')
    const tx = await solAdapter.getTransaction('txhash123')
    expect(tx.hash).toBe('txhash123')
    expect(tx.status).toBe('success')
  })

  it('getTransaction returns null on error', async () => {
    mockFetch({
      jsonrpc: '2.0',
      result: {
        transaction: { message: { accountKeys: [], instructions: [] }, signatures: [] },
        meta: { err: { InstructionError: [0, 'Custom'] }, fee: 5000 },
      },
    })
    const { solAdapter } = await import('../../server/crypto/chains/sol.js')
    const tx = await solAdapter.getTransaction('badtx')
    expect(tx).toBeNull()
  })

  it('buildTransferEventFilter returns filter object', async () => {
    const { solAdapter } = await import('../../server/crypto/chains/sol.js')
    const filter = solAdapter.buildTransferEventFilter(['SolAddr1'])
    expect(filter.addresses).toEqual(['SolAddr1'])
    expect(filter.topic).toBeDefined()
  })
})

describe('chain index', () => {
  it('exports all adapters keyed by chain name', async () => {
    const { adapters } = await import('../../server/crypto/chains/index.js')
    expect(adapters).toHaveProperty('TRON')
    expect(adapters).toHaveProperty('ETH')
    expect(adapters).toHaveProperty('BSC')
    expect(adapters).toHaveProperty('SOL')
  })

  it('each adapter has correct name', async () => {
    const { adapters } = await import('../../server/crypto/chains/index.js')
    expect(adapters.TRON.name).toBe('TRON')
    expect(adapters.ETH.name).toBe('ETH')
    expect(adapters.BSC.name).toBe('BSC')
    expect(adapters.SOL.name).toBe('SOL')
  })

  it('getAdapter returns correct adapter by chain name', async () => {
    const { getAdapter, adapters } = await import('../../server/crypto/chains/index.js')
    expect(getAdapter('ETH')).toBe(adapters.ETH)
  })
})
