# USDT Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement USDT cryptocurrency payment with dynamic HD wallet addresses and real-time Event monitoring across TRC-20, ERC-20, BEP-20, and SPL chains.

**Architecture:** HD wallet derives unique address per order → blockchain Event notifications confirm payment → backend activates membership. Each chain has its own adapter implementing a unified interface.

**Tech Stack:** @scure/bip32, @scure/bip39, tronweb, @ethereumjs/util, @solana/web3.js, qrcode, ws

## Global Constraints

- ESM only (`"type": "module"` in package.json)
- Use `beijingNow()` from `server/db.js` for all timestamps
- All DB queries use parameterized `?` placeholders
- No comments unless the WHY is non-obvious
- Each modification must confirm impact boundary and self-test
- Working directory: `D:\dev_codex\wall-street-skill-local`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `server/crypto/wallet.js` | HD wallet key derivation, address generation, encryption |
| `server/crypto/chains/base.js` | Abstract base class for chain adapters |
| `server/crypto/chains/tron.js` | TRC-20 adapter (TronGrid API) |
| `server/crypto/chains/eth.js` | ERC-20 adapter (Etherscan API) |
| `server/crypto/chains/bsc.js` | BEP-20 adapter (BSCScan API) |
| `server/crypto/chains/sol.js` | SPL adapter (Solana RPC) |
| `server/crypto/monitor.js` | Event listener manager, confirmation tracker |
| `server/crypto/qr.js` | QR code generation utility |
| `server/migrations/027_usdt_payment.js` | DB schema changes |
| `tests/crypto/wallet.test.js` | HD wallet unit tests |
| `tests/crypto/chains.test.js` | Chain adapter unit tests |

### Modified Files

| File | Changes |
|------|---------|
| `server/routes/payment.js` | Remove 503 block, implement crypto order creation |
| `server/config.js` | Add crypto env vars |
| `server/db.js` | Add crypto_watch_list table to initDB |
| `server/bridge-ws.js` | Add order subscription for WS push |
| `public/ai/app.js` | Add crypto payment UI logic |
| `public/ai/index.html` | Add payment page HTML |
| `package.json` | Add new dependencies |
| `server/.env.example` | Document new env vars |

---

### Task 1: Install Dependencies & Create Directory Structure

**Covers:** [S2]

**Files:**
- Modify: `package.json`
- Create: `server/crypto/` directory tree

- [ ] **Step 1: Install npm packages**

```bash
npm install @scure/bip32 @scure/bip39 @ethereumjs/util tronweb @solana/web3.js qrcode
```

Expected: All packages installed without errors.

- [ ] **Step 2: Create directory structure**

```bash
mkdir -p server/crypto/chains
```

- [ ] **Step 3: Verify package.json**

Run: `node -e "import('@scure/bip32').then(() => console.log('bip32 OK'))"`
Run: `node -e "import('@scure/bip39').then(() => console.log('bip39 OK'))"`
Run: `node -e "import('qrcode').then(() => console.log('qrcode OK'))"`

Expected: All three print "OK".

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json server/crypto/
git commit -m "chore: add USDT payment dependencies and directory structure"
```

---

### Task 2: Database Migration - Add Crypto Fields

**Covers:** [S3]

**Files:**
- Create: `server/migrations/027_usdt_payment.js`
- Modify: `server/db.js`

- [ ] **Step 1: Create migration file**

```javascript
// server/migrations/027_usdt_payment.js
import { queryRun } from '../db.js'

export default async function migrate027() {
  // Add crypto columns to orders table
  const columns = [
    "ALTER TABLE orders ADD COLUMN crypto_chain VARCHAR(10) DEFAULT NULL",
    "ALTER TABLE orders ADD COLUMN crypto_address VARCHAR(100) DEFAULT NULL",
    "ALTER TABLE orders ADD COLUMN crypto_amount DECIMAL(20,8) DEFAULT NULL",
    "ALTER TABLE orders ADD COLUMN crypto_tx_hash VARCHAR(100) DEFAULT NULL",
    "ALTER TABLE orders ADD COLUMN crypto_confirmations INT DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN crypto_expires_at DATETIME DEFAULT NULL",
  ]

  for (const sql of columns) {
    try {
      await queryRun(sql)
    } catch (e) {
      if (!e.message?.includes('Duplicate column')) throw e
    }
  }

  // Create crypto_watch_list table
  await queryRun(`
    CREATE TABLE IF NOT EXISTS crypto_watch_list (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(36) NOT NULL,
      user_id INT NOT NULL,
      chain VARCHAR(10) NOT NULL,
      address VARCHAR(100) NOT NULL,
      expected_amount DECIMAL(20,8) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      tx_hash VARCHAR(100) DEFAULT NULL,
      confirmations INT DEFAULT 0,
      required_confirmations INT DEFAULT 19,
      wallet_index INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      INDEX idx_watch_status (status),
      INDEX idx_watch_address (chain, address),
      INDEX idx_watch_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Create wallet_keys table
  await queryRun(`
    CREATE TABLE IF NOT EXISTS wallet_keys (
      id INT AUTO_INCREMENT PRIMARY KEY,
      chain VARCHAR(10) NOT NULL,
      address_index INT NOT NULL,
      address VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE INDEX idx_wallet_addr (chain, address),
      UNIQUE INDEX idx_wallet_idx (chain, address_index)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  console.log('[Migration 027] USDT payment schema created')
}
```

- [ ] **Step 2: Register migration in migrations.js**

Open `server/migrations.js` and add `027_usdt_payment` to the migrations array (after the last entry).

- [ ] **Step 3: Verify migration runs**

Run: `node -e "import('./server/migrations/027_usdt_payment.js').then(m => m.default()).then(() => console.log('Migration OK'))"`

Expected: "Migration OK" printed, tables/columns exist in DB.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/027_usdt_payment.js server/migrations.js
git commit -m "feat: add USDT payment database schema (migration 027)"
```

---

### Task 3: HD Wallet Management

**Covers:** [S4]

**Files:**
- Create: `server/crypto/wallet.js`
- Test: `tests/crypto/wallet.test.js`

**Interfaces:**
- Produces: `deriveAddress(chain, index)`, `getMnemonic()`, `validateAddress(chain, address)`

- [ ] **Step 1: Write failing tests**

```javascript
// tests/crypto/wallet.test.js
import { describe, it, expect } from 'vitest'
import { deriveAddress, validateAddress, getAddressCount } from '../../server/crypto/wallet.js'

describe('HD Wallet', () => {
  it('derives valid ETH address', () => {
    const result = deriveAddress('eth', 0)
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(result.publicKey).toBeDefined()
  })

  it('derives valid TRON address', () => {
    const result = deriveAddress('tron', 0)
    expect(result.address).toMatch(/^T[A-Za-z1-9]{33}$/)
  })

  it('derives different addresses for different indices', () => {
    const a = deriveAddress('eth', 0)
    const b = deriveAddress('eth', 1)
    expect(a.address).not.toBe(b.address)
  })

  it('validates ETH address format', () => {
    expect(validateAddress('eth', '0xdAC17F958D2ee523a2206206994597C13D831ec7')).toBe(true)
    expect(validateAddress('eth', 'invalid')).toBe(false)
  })

  it('validates TRON address format', () => {
    expect(validateAddress('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true)
    expect(validateAddress('tron', 'invalid')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/crypto/wallet.test.js`

Expected: FAIL - module not found.

- [ ] **Step 3: Implement wallet.js**

```javascript
// server/crypto/wallet.js
import { BIP32Factory } from '@scure/bip32'
import * as bip39 from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { keccak256 } from '@ethereumjs/util'
import { ethers } from 'ethers'
import { queryOne, queryRun } from '../db.js'

// BIP44 coin types
const COIN_TYPE = {
  eth: 60,
  tron: 195,
  bsc: 60,
  sol: 501,
}

const REQUIRED_CONFIRMATIONS = {
  tron: 19,
  eth: 12,
  bsc: 15,
  sol: 32,
}

let _seed = null

function getSeed() {
  if (_seed) return _seed
  const mnemonic = process.env.HD_WALLET_MNEMONIC
  if (!mnemonic) throw new Error('HD_WALLET_MNEMONIC not set')
  _seed = bip39.mnemonicToSeedSync(mnemonic)
  return _seed
}

function getBIP32() {
  const { ecc } = await import('tiny-secp256k1')
  return BIP32Factory(ecc)
}

export function deriveAddress(chain, index) {
  const seed = getSeed()
  const coinType = COIN_TYPE[chain]
  if (!coinType) throw new Error(`Unsupported chain: ${chain}`)

  // For ETH/BSC: m/44'/60'/0'/0/index
  // For TRON: m/44'/195'/0'/0/index
  // For SOL: m/44'/501'/0'/index'
  const path = chain === 'sol'
    ? `m/44'/501'/0'/${index}'`
    : `m/44'/${coinType}'/0'/0/${index}`

  // Use ethers for ETH/BSC (most reliable)
  if (chain === 'eth' || chain === 'bsc') {
    const wallet = ethers.HDNodeWallet.fromSeed(seed).derivePath(path)
    return { address: wallet.address, publicKey: wallet.publicKey, path }
  }

  // For TRON: derive ETH key then convert
  if (chain === 'tron') {
    const wallet = ethers.HDNodeWallet.fromSeed(seed).derivePath(path)
    const address = ethToTron(wallet.address)
    return { address, publicKey: wallet.publicKey, path }
  }

  // For SOL: use ed25519 derivation
  if (chain === 'sol') {
    const { Keypair } = await import('@solana/web3.js')
    const derived = ethers.HDNodeWallet.fromSeed(seed).derivePath(path)
    // Solana uses different key derivation - simplified for now
    const keypair = Keypair.fromSeed(ethers.utils.arrayify(derived.privateKey).slice(0, 32))
    return { address: keypair.publicKey.toBase58(), publicKey: keypair.publicKey.toBase58(), path }
  }
}

function ethToTron(ethAddress) {
  // Tron address = 'T' + base58(keccak256(ethAddress[2:])[-20:])
  const { base58 } = await import('bs58')
  const hash = keccak256(Buffer.from(ethAddress.slice(2), 'hex'))
  const hex = '41' + hash.slice(-20).toString('hex')
  return 'T' + base58.encode(Buffer.from(hex, 'hex'))
}

export function validateAddress(chain, address) {
  if (!address || typeof address !== 'string') return false
  switch (chain) {
    case 'eth':
    case 'bsc':
      return /^0x[0-9a-fA-F]{40}$/.test(address)
    case 'tron':
      return /^T[A-Za-z1-9]{33}$/.test(address)
    case 'sol':
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
    default:
      return false
  }
}

export async function getAddressCount(chain) {
  const row = await queryOne(
    'SELECT COUNT(*) as cnt FROM wallet_keys WHERE chain = ?',
    [chain]
  )
  return row?.cnt || 0
}

export async function saveAddress(chain, index, address) {
  await queryRun(
    'INSERT INTO wallet_keys (chain, address_index, address) VALUES (?, ?, ?)',
    [chain, index, address]
  )
}

export function getRequiredConfirmations(chain) {
  return REQUIRED_CONFIRMATIONS[chain] || 19
}

export function getChainByCryptoChain(cryptoChain) {
  const map = { trc20: 'tron', erc20: 'eth', bep20: 'bsc', spl: 'sol' }
  return map[cryptoChain] || cryptoChain
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/crypto/wallet.test.js`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/crypto/wallet.js tests/crypto/wallet.test.js
git commit -m "feat: add HD wallet address derivation for TRC-20/ERC-20/BEP-20/SOL"
```

---

### Task 4: Chain Adapters

**Covers:** [S5]

**Files:**
- Create: `server/crypto/chains/base.js`
- Create: `server/crypto/chains/tron.js`
- Create: `server/crypto/chains/eth.js`
- Create: `server/crypto/chains/bsc.js`
- Create: `server/crypto/chains/sol.js`
- Test: `tests/crypto/chains.test.js`

**Interfaces:**
- Consumes: `deriveAddress()`, `validateAddress()` from wallet.js
- Produces: `adapters` object with chain-specific instances

- [ ] **Step 1: Write failing tests**

```javascript
// tests/crypto/chains.test.js
import { describe, it, expect } from 'vitest'
import { adapters } from '../../server/crypto/chains/index.js'

describe('Chain Adapters', () => {
  it('has all chain adapters', () => {
    expect(adapters.tron).toBeDefined()
    expect(adapters.eth).toBeDefined()
    expect(adapters.bsc).toBeDefined()
    expect(adapters.sol).toBeDefined()
  })

  it('each adapter has required methods', () => {
    for (const [name, adapter] of Object.entries(adapters)) {
      expect(adapter.name).toBe(name)
      expect(typeof adapter.getRequiredConfirmations).toBe('function')
      expect(typeof adapter.getApiBaseUrl).toBe('function')
    }
  })

  it('tron adapter returns correct confirmations', () => {
    expect(adapters.tron.getRequiredConfirmations()).toBe(19)
  })

  it('eth adapter returns correct confirmations', () => {
    expect(adapters.eth.getRequiredConfirmations()).toBe(12)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/crypto/chains.test.js`

Expected: FAIL - module not found.

- [ ] **Step 3: Create base adapter**

```javascript
// server/crypto/chains/base.js
export class BaseChainAdapter {
  constructor(name, requiredConfirmations, apiBaseUrl) {
    this.name = name
    this.requiredConfirmations = requiredConfirmations
    this.apiBaseUrl = apiBaseUrl
  }

  getRequiredConfirmations() {
    return this.requiredConfirmations
  }

  getApiBaseUrl() {
    return this.apiBaseUrl
  }

  getUsdtContractAddress() {
    throw new Error('Not implemented')
  }

  getQrPrefix() {
    throw new Error('Not implemented')
  }
}
```

- [ ] **Step 4: Create TRON adapter**

```javascript
// server/crypto/chains/tron.js
import { BaseChainAdapter } from './base.js'

const TRONGRID_API = 'https://api.trongrid.io'
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

export class TronAdapter extends BaseChainAdapter {
  constructor() {
    super('tron', 19, TRONGRID_API)
  }

  getUsdtContractAddress() {
    return USDT_TRC20
  }

  getQrPrefix() {
    return 'tronext'
  }

  getApiHeaders() {
    return {
      'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || '',
      'Accept': 'application/json'
    }
  }

  async getTransaction(txHash) {
    const res = await fetch(`${this.apiBaseUrl}/v1/transactions/${txHash}`, {
      headers: this.getApiHeaders()
    })
    const data = await res.json()
    return data.data?.[0] || null
  }

  async getConfirmations(txHash) {
    const tx = await this.getTransaction(txHash)
    if (!tx?.blockNumber) return 0
    const nodeInfo = await fetch(`${this.apiBaseUrl}/wallet/getnowblock`, {
      headers: this.getApiHeaders()
    }).then(r => r.json())
    return (nodeInfo.block_header?.raw_data?.number || 0) - tx.blockNumber
  }

  buildTransferEventFilter(watchedAddresses) {
    return {
      contract_address: USDT_TRC20,
      event_name: 'Transfer',
      filters: { to: watchedAddresses },
    }
  }
}

export const tronAdapter = new TronAdapter()
```

- [ ] **Step 5: Create ETH adapter**

```javascript
// server/crypto/chains/eth.js
import { BaseChainAdapter } from './base.js'

const ETHERSCAN_API = 'https://api.etherscan.io/api'
const USDT_ERC20 = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export class EthAdapter extends BaseChainAdapter {
  constructor() {
    super('eth', 12, ETHERSCAN_API)
  }

  getUsdtContractAddress() {
    return USDT_ERC20
  }

  getQrPrefix() {
    return 'ethereum'
  }

  async getTransaction(txHash) {
    const res = await fetch(
      `${this.apiBaseUrl}?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${process.env.ETHERSCAN_API_KEY}`
    )
    const data = await res.json()
    return data.result
  }

  async getConfirmations(txHash) {
    const tx = await this.getTransaction(txHash)
    if (!tx?.blockNumber) return 0
    const blockRes = await fetch(
      `${this.apiBaseUrl}?module=proxy&action=eth_blockNumber&apikey=${process.env.ETHERSCAN_API_KEY}`
    )
    const blockData = await blockRes.json()
    const currentBlock = parseInt(blockData.result, 16)
    return currentBlock - parseInt(tx.blockNumber, 16)
  }

  buildTransferEventFilter(watchedAddresses) {
    return {
      address: USDT_ERC20,
      topic0: TRANSFER_TOPIC,
      topic1: watchedAddresses.map(a => '0x000000000000000000000000' + a.slice(2).toLowerCase()),
    }
  }
}

export const ethAdapter = new EthAdapter()
```

- [ ] **Step 6: Create BSC adapter**

```javascript
// server/crypto/chains/bsc.js
import { BaseChainAdapter } from './base.js'

const BSCSCAN_API = 'https://api.bscscan.com/api'
const USDT_BEP20 = '0x55d398326f99059fF775485246999027B3197955'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export class BscAdapter extends BaseChainAdapter {
  constructor() {
    super('bsc', 15, BSCSCAN_API)
  }

  getUsdtContractAddress() {
    return USDT_BEP20
  }

  getQrPrefix() {
    return 'ethereum'
  }

  async getTransaction(txHash) {
    const res = await fetch(
      `${this.apiBaseUrl}?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${process.env.BSCSCAN_API_KEY}`
    )
    const data = await res.json()
    return data.result
  }

  async getConfirmations(txHash) {
    const tx = await this.getTransaction(txHash)
    if (!tx?.blockNumber) return 0
    const blockRes = await fetch(
      `${this.apiBaseUrl}?module=proxy&action=eth_blockNumber&apikey=${process.env.BSCSCAN_API_KEY}`
    )
    const blockData = await blockRes.json()
    const currentBlock = parseInt(blockData.result, 16)
    return currentBlock - parseInt(tx.blockNumber, 16)
  }

  buildTransferEventFilter(watchedAddresses) {
    return {
      address: USDT_BEP20,
      topic0: TRANSFER_TOPIC,
      topic1: watchedAddresses.map(a => '0x000000000000000000000000' + a.slice(2).toLowerCase()),
    }
  }
}

export const bscAdapter = new BscAdapter()
```

- [ ] **Step 7: Create SOL adapter**

```javascript
// server/crypto/chains/sol.js
import { BaseChainAdapter } from './base.js'

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
const USDT_SPL = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

export class SolAdapter extends BaseChainAdapter {
  constructor() {
    super('sol', 32, SOLANA_RPC)
  }

  getUsdtContractAddress() {
    return USDT_SPL
  }

  getQrPrefix() {
    return 'solana'
  }

  async getTransaction(txHash) {
    const res = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [txHash, { encoding: 'jsonParsed' }]
      })
    })
    const data = await res.json()
    return data.result
  }

  async getConfirmations(txHash) {
    const tx = await this.getTransaction(txHash)
    if (!tx?.slot) return 0
    const slotRes = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSlot'
      })
    })
    const slotData = await slotRes.json()
    return (slotData.result || 0) - tx.slot
  }
}

export const solAdapter = new SolAdapter()
```

- [ ] **Step 8: Create chain index**

```javascript
// server/crypto/chains/index.js
import { tronAdapter } from './tron.js'
import { ethAdapter } from './eth.js'
import { bscAdapter } from './bsc.js'
import { solAdapter } from './sol.js'

export const adapters = {
  tron: tronAdapter,
  eth: ethAdapter,
  bsc: bscAdapter,
  sol: solAdapter,
}

export function getChainForCryptoType(cryptoType) {
  const map = { trc20: 'tron', erc20: 'eth', bep20: 'bsc', spl: 'sol' }
  return adapters[map[cryptoType]]
}
```

- [ ] **Step 9: Run tests**

Run: `npx vitest run tests/crypto/chains.test.js`

Expected: All tests PASS.

- [ ] **Step 10: Commit**

```bash
git add server/crypto/chains/
git commit -m "feat: add multi-chain adapters for TRC-20/ERC-20/BEP-20/SOL"
```

---

### Task 5: QR Code Generation

**Covers:** [S7]

**Files:**
- Create: `server/crypto/qr.js`

**Interfaces:**
- Produces: `generatePaymentQR(chain, address, amount)`

- [ ] **Step 1: Implement QR generator**

```javascript
// server/crypto/qr.js
import QRCode from 'qrcode'

export async function generatePaymentQR(chain, address, amount) {
  let uri
  switch (chain) {
    case 'tron':
      uri = `tronext:${address}?amount=${amount}&token=USDT`
      break
    case 'eth':
      uri = `ethereum:${address}@1?amount=${amount}&contractAddress=0xdAC17F958D2ee523a2206206994597C13D831ec7`
      break
    case 'bsc':
      uri = `ethereum:${address}@56?amount=${amount}&contractAddress=0x55d398326f99059fF775485246999027B3197955`
      break
    case 'sol':
      uri = `solana:${address}?amount=${amount}&token=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`
      break
    default:
      uri = address
  }

  return QRCode.toDataURL(uri, {
    width: 256,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' }
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add server/crypto/qr.js
git commit -m "feat: add QR code generation for crypto payments"
```

---

### Task 6: Event Monitor

**Covers:** [S5, S6]

**Files:**
- Create: `server/crypto/monitor.js`
- Test: `tests/crypto/monitor.test.js`

**Interfaces:**
- Consumes: `adapters` from chains, `queryOne`, `queryRun` from db
- Produces: `startMonitor()`, `stopMonitor()`, `addWatchAddress()`, `removeWatchAddress()`

- [ ] **Step 1: Write failing tests**

```javascript
// tests/crypto/monitor.test.js
import { describe, it, expect, vi } from 'vitest'

describe('Crypto Monitor', () => {
  it('formats USDT amount correctly', () => {
    const { formatUsdtAmount } = require('../../server/crypto/monitor.js')
    expect(formatUsdtAmount(100.12345678)).toBe('100.12345678')
    expect(formatUsdtAmount(0.5)).toBe('0.50000000')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/crypto/monitor.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement monitor**

```javascript
// server/crypto/monitor.js
import { adapters } from './chains/index.js'
import { queryOne, queryRun, queryAll } from '../db.js'

const POLL_INTERVAL = 30000  // 30s fallback poll
const CHECK_INTERVAL = 5000  // 5s confirmation check
const EXPIRY_CHECK_INTERVAL = 60000  // 1min expiry check

let _running = false
let _timers = []

export function formatUsdtAmount(amount) {
  return Number(amount).toFixed(8)
}

export async function startMonitor() {
  if (_running) return
  _running = true
  console.log('[CryptoMonitor] Starting...')

  // Start confirmation checker
  _timers.push(setInterval(checkConfirmations, CHECK_INTERVAL))

  // Start expiry checker
  _timers.push(setInterval(checkExpired, EXPIRY_CHECK_INTERVAL))

  // Start polling fallback for each chain
  for (const [chain, adapter] of Object.entries(adapters)) {
    _timers.push(setInterval(() => pollChain(chain), POLL_INTERVAL))
  }

  console.log('[CryptoMonitor] Started')
}

export function stopMonitor() {
  _running = false
  _timers.forEach(clearInterval)
  _timers = []
  console.log('[CryptoMonitor] Stopped')
}

async function checkConfirmations() {
  if (!_running) return

  try {
    const pending = await queryAll(
      `SELECT id, order_id, chain, tx_hash, confirmations, required_confirmations
       FROM crypto_watch_list WHERE status = 'confirming' AND tx_hash IS NOT NULL`
    )

    for (const watch of pending) {
      try {
        const adapter = adapters[watch.chain]
        if (!adapter) continue

        const confs = await adapter.getConfirmations(watch.tx_hash)
        await queryRun(
          'UPDATE crypto_watch_list SET confirmations = ? WHERE id = ?',
          [confs, watch.id]
        )

        if (confs >= watch.required_confirmations) {
          await confirmPayment(watch)
        }
      } catch (err) {
        console.error(`[CryptoMonitor] Confirmation check error for ${watch.id}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[CryptoMonitor] Confirmation batch error:', err.message)
  }
}

async function confirmPayment(watch) {
  const order = await queryOne('SELECT * FROM orders WHERE id = ?', [watch.order_id])
  if (!order || order.status === 'paid') return

  console.log(`[CryptoMonitor] Payment confirmed for order ${order.order_no}`)

  const { withTransaction } = await import('../db.js')
  await withTransaction(async (run) => {
    await run(`UPDATE orders SET status = 'paid', status_label = '已完成', paid_at = NOW() WHERE id = ?`, [watch.order_id])
    await run(`UPDATE crypto_watch_list SET status = 'confirmed' WHERE id = ?`, [watch.id])

    const expiresAt = calculateExpiry(order.period)
    await run(
      `UPDATE users SET plan = ?, plan_period = ?, plan_expires_at = ?, updated_at = NOW() WHERE id = ?`,
      [order.plan, order.period, expiresAt, order.user_id]
    )
  })

  await queryRun(
    `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'system', '支付成功', ?)`,
    [order.user_id, `您已成功开通 ${order.plan_label} ${order.period_label || ''}会员`]
  )
}

function calculateExpiry(period) {
  const now = Date.now()
  const offsets = { month: 30, year: 365, lifetime: 36500 }
  const days = offsets[period] || 30
  const expires = new Date(now + days * 86400000)
  return expires.toISOString().split('T')[0]
}

async function checkExpired() {
  if (!_running) return

  try {
    const expired = await queryAll(
      `SELECT id FROM crypto_watch_list WHERE status = 'pending' AND expires_at < NOW()`
    )
    for (const watch of expired) {
      await queryRun('UPDATE crypto_watch_list SET status = \'expired\' WHERE id = ?', [watch.id])
    }
  } catch (err) {
    console.error('[CryptoMonitor] Expire check error:', err.message)
  }
}

async function pollChain(chain) {
  if (!_running) return

  try {
    const pending = await queryAll(
      `SELECT id, address, expected_amount FROM crypto_watch_list
       WHERE status = 'pending' AND chain = ? AND expires_at > NOW()`,
      [chain]
    )
    if (!pending.length) return

    const adapter = adapters[chain]
    if (!adapter?.scanForPayments) return

    await adapter.scanForPayments(pending)
  } catch (err) {
    console.error(`[CryptoMonitor] Poll error for ${chain}:`, err.message)
  }
}

export function addWatchAddress(watchId, chain, address, amount) {
  console.log(`[CryptoMonitor] Watching ${chain} address ${address} for order ${watchId}`)
}

export function removeWatchAddress(watchId) {
  console.log(`[CryptoMonitor] Stopped watching order ${watchId}`)
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/crypto/monitor.test.js`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/crypto/monitor.js tests/crypto/monitor.test.js
git commit -m "feat: add USDT payment event monitor with confirmation tracking"
```

---

### Task 7: Modify Payment Routes - Create Crypto Order

**Covers:** [S6]

**Files:**
- Modify: `server/routes/payment.js`

**Interfaces:**
- Consumes: `deriveAddress`, `getAddressCount`, `saveAddress` from wallet.js
- Consumes: `adapters` from chains
- Consumes: `generatePaymentQR` from qr.js
- Consumes: `getRequiredConfirmations` from wallet.js

- [ ] **Step 1: Replace 503 block with crypto order logic**

Remove the `return res.status(503)` line and the `// eslint-disable-next-line no-unreachable` comment, then replace the dead POST handler body with:

```javascript
router.post('/payment', authMiddleware, async (req, res) => {
  try {
    const { plan, period, crypto_chain, use_referral_credit } = req.body
    if (!crypto_chain) return res.json({ ok: false, error: '请选择支付链' })

    const planInfo = PLANS[plan]
    if (!planInfo) return res.json({ ok: false, error: '未知套餐' })

    const chainMap = { trc20: 'tron', erc20: 'eth', bep20: 'bsc', spl: 'sol' }
    const chain = chainMap[crypto_chain]
    if (!chain) return res.json({ ok: false, error: '不支持的链类型' })

    const adapter = adapters[chain]
    if (!adapter) return res.json({ ok: false, error: '链适配器未初始化' })

    const periodKey = period === 'yearly' ? 'year' : period
    const amountCents = planInfo[periodKey] || planInfo.month
    const usdAmount = amountCents / 100

    // Calculate credits
    let credit = 0
    const user = await queryOne('SELECT plan, plan_expires_at, referral_credit FROM users WHERE id = ?', [req.user.id])
    if (user?.plan && user.plan !== 'free' && user.plan_expires_at) {
      const expiresAt = new Date(user.plan_expires_at + 'T23:59:59+08:00')
      if (expiresAt > new Date()) {
        const daysRemaining = Math.ceil((expiresAt - new Date()) / 86400000)
        credit = Math.round((PLANS[user.plan]?.month || 0) / 30 * daysRemaining)
      }
    }

    let referralCredit = 0
    if (use_referral_credit && user?.referral_credit > 0) {
      referralCredit = user.referral_credit
    }

    const finalAmountCents = Math.max(0, amountCents - credit - referralCredit)
    const finalUsdAmount = finalAmountCents / 100

    // If fully paid with credit, no crypto needed
    if (finalUsdAmount === 0) {
      const orderNo = `WSS${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
      const orderId = crypto.randomUUID()
      const { withTransaction } = await import('../db.js')

      await withTransaction(async (run) => {
        await run(
          `INSERT INTO orders (order_no, order_id, user_id, plan, plan_label, period, amount, amount_confirmed, status, status_label, payment_method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', '已完成', 'credit')`,
          [orderNo, orderId, req.user.id, plan, planInfo.name, periodKey, amountCents, 0]
        )
        await run('UPDATE users SET plan = ?, plan_period = ?, plan_expires_at = ?, updated_at = NOW() WHERE id = ?',
          [plan, periodKey, calculateExpiry(periodKey), req.user.id])
        if (referralCredit > 0) {
          await run('UPDATE users SET referral_credit = GREATEST(0, referral_credit - ?) WHERE id = ?', [referralCredit, req.user.id])
        }
      })

      return res.json({ ok: true, paid_with_credit: true, orderNo })
    }

    // Derive unique address
    const index = await getAddressCount(chain)
    const { address } = deriveAddress(chain, index)

    if (!adapter.constructor.prototype.validateAddress?.call?.(adapter, address)) {
      return res.json({ ok: false, error: '地址生成失败' })
    }

    const orderNo = `WSS${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const orderId = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const requiredConfs = getRequiredConfirmations(chain)

    const { withTransaction } = await import('../db.js')
    await withTransaction(async (run) => {
      await run(
        `INSERT INTO orders (order_no, order_id, user_id, plan, plan_label, period, period_label, amount, amount_confirmed, status, status_label, payment_method, crypto_chain, crypto_address, crypto_amount, crypto_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', '待支付', 'usdt', ?, ?, ?, ?)`,
        [orderNo, orderId, req.user.id, plan, planInfo.name, periodKey, PERIOD_LABELS[periodKey] || period, amountCents, chain, address, finalUsdAmount, expiresAt]
      )
      await run(
        `INSERT INTO crypto_watch_list (order_id, user_id, chain, address, expected_amount, required_confirmations, wallet_index, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, req.user.id, chain, address, finalUsdAmount, requiredConfs, index, expiresAt]
      )
      await saveAddress(chain, index, address)
    })

    // Generate QR code
    const qrCode = await generatePaymentQR(chain, address, finalUsdAmount)

    // Process referral commission if applicable
    try {
      const referral = await queryOne(
        "SELECT id, referrer_id FROM referrals WHERE referred_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        [req.user.id]
      )
      if (referral) {
        const rule = await queryOne('SELECT rate_bps FROM referral_rules WHERE plan = ? AND period = ? AND enabled = 1', [plan, periodKey])
        const rateBps = rule?.rate_bps || 1000
        const commissionCents = Math.round(finalAmountCents * rateBps / 10000)
        await queryRun('UPDATE referrals SET amount_cents = ?, commission = ?, plan_label = ?, attributed_at = NOW() WHERE id = ?',
          [finalAmountCents, commissionCents, planInfo.name, referral.id])
      }
    } catch (refErr) {
      console.error('Referral commission error:', refErr.message)
    }

    res.json({
      ok: true,
      orderId,
      orderNo,
      chain: crypto_chain,
      address,
      amount: finalUsdAmount,
      amountCents: finalUsdAmount,
      qrCode,
      expiresAt: expiresAt.toISOString(),
      requiredConfirmations: requiredConfs,
      label: `${planInfo.name} ${PERIOD_LABELS[periodKey]}`,
      creditApplied: (credit / 100).toFixed(2),
      referralCreditApplied: (referralCredit / 100).toFixed(2),
    })
  } catch (err) {
    console.error('Payment error:', err)
    res.json({ ok: false, error: '创建订单失败' })
  }
})
```

- [ ] **Step 2: Add imports at top of payment.js**

Add after existing imports:

```javascript
import { deriveAddress, getAddressCount, saveAddress, getRequiredConfirmations, validateAddress } from '../crypto/wallet.js'
import { adapters } from '../crypto/chains/index.js'
import { generatePaymentQR } from '../crypto/qr.js'
```

- [ ] **Step 3: Run existing payment tests**

Run: `npx vitest run tests/payment.test.js`

Expected: All tests PASS (existing preview endpoint unaffected).

- [ ] **Step 4: Commit**

```bash
git add server/routes/payment.js
git commit -m "feat: implement USDT crypto order creation in payment routes"
```

---

### Task 8: Start Monitor on Server Boot

**Covers:** [S5]

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Add monitor import and start**

At the top of `server/index.js`, add:

```javascript
import { startMonitor } from './crypto/monitor.js'
```

After the server starts listening (after `app.listen()`), add:

```javascript
// Start crypto payment monitor
try {
  await startMonitor()
} catch (err) {
  console.error('[CryptoMonitor] Failed to start:', err.message)
}
```

- [ ] **Step 2: Commit**

```bash
git add server/index.js
git commit -m "feat: start USDT payment monitor on server boot"
```

---

### Task 9: Environment Variables & Configuration

**Covers:** [S11]

**Files:**
- Modify: `server/.env.example`
- Modify: `server/config.js`

- [ ] **Step 1: Add env vars to .env.example**

Add at the end of `.env.example`:

```bash
# USDT Payment (HD Wallet)
HD_WALLET_MNEMONIC=your twelve word mnemonic phrase here
TRONGRID_API_KEY=your_trongrid_api_key
ETHERSCAN_API_KEY=your_etherscan_api_key
BSCSCAN_API_KEY=your_bscscan_api_key
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

- [ ] **Step 2: Commit**

```bash
git add server/.env.example
git commit -m "docs: add USDT payment environment variables"
```

---

### Task 10: Frontend Payment UI

**Covers:** [S7]

**Files:**
- Modify: `public/ai/app.js`

**Interfaces:**
- Consumes: POST `/api/payment` with `crypto_chain` parameter
- Consumes: WebSocket for order status updates

- [ ] **Step 1: Add crypto payment section to app.js**

Add the following functions after the existing payment-related code in `public/ai/app.js`:

```javascript
// USDT Crypto Payment
async function initiateCryptoPayment(plan, period) {
  const chains = [
    { id: 'trc20', name: 'TRC-20 (Tron)', icon: '⟠', fee: '低 (~1 USDT)' },
    { id: 'erc20', name: 'ERC-20 (Ethereum)', icon: '⟠', fee: '高 (5-50 USDT)' },
    { id: 'bep20', name: 'BEP-20 (BSC)', icon: '⟠', fee: '低 (~0.3 USDT)' },
    { id: 'spl', name: 'SOL (Solana)', icon: '◎', fee: '极低 (~0.001 USDT)' },
  ]

  let selectedChain = 'trc20'

  const html = `
    <div class="crypto-payment-modal">
      <h3>USDT 支付</h3>
      <p>选择支付链：</p>
      <div class="chain-selector">
        ${chains.map(c => `
          <button class="chain-btn ${c.id === selectedChain ? 'active' : ''}"
                  data-chain="${c.id}" onclick="selectChain('${c.id}')">
            <span class="chain-icon">${c.icon}</span>
            <span class="chain-name">${c.name}</span>
            <span class="chain-fee">${c.fee}</span>
          </button>
        `).join('')}
      </div>
      <button class="pay-btn" onclick="confirmCryptoPayment('${plan}', '${period}')">
        确认支付
      </button>
    </div>
  `

  showModal(html)
}

function selectChain(chainId) {
  document.querySelectorAll('.chain-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.chain === chainId)
  })
  window._selectedCryptoChain = chainId
}

async function confirmCryptoPayment(plan, period) {
  const chain = window._selectedCryptoChain || 'trc20'

  try {
    const res = await api('/api/payment', {
      method: 'POST',
      body: { plan, period, crypto_chain: chain }
    })

    if (!res.ok) {
      alert(res.error || '创建订单失败')
      return
    }

    if (res.paid_with_credit) {
      alert('支付成功！')
      closeModal()
      return
    }

    showPaymentPage(res)
  } catch (err) {
    alert('网络错误，请重试')
  }
}

function showPaymentPage(order) {
  const html = `
    <div class="crypto-payment-page">
      <h3>${order.label}</h3>
      <div class="payment-amount">
        <span class="amount">${order.amount} USDT</span>
        <span class="chain-badge">${order.chain.toUpperCase()}</span>
      </div>
      <div class="qr-code">
        <img src="${order.qrCode}" alt="QR Code" />
      </div>
      <div class="payment-address">
        <label>收款地址：</label>
        <div class="address-copy">
          <input type="text" value="${order.address}" readonly id="pay-address" />
          <button onclick="copyAddress()">复制</button>
        </div>
      </div>
      <div class="payment-info">
        <p>请在 <strong>30 分钟</strong>内完成支付</p>
        <p>确认数：<span id="confirmations">0</span> / ${order.requiredConfirmations}</p>
      </div>
      <div class="payment-status" id="payment-status">等待支付...</div>
    </div>
  `

  showModal(html)
  startPaymentPolling(order.orderId, order.requiredConfirmations)
}

function copyAddress() {
  const input = document.getElementById('pay-address')
  navigator.clipboard.writeText(input.value)
  alert('地址已复制')
}

let _paymentPollingTimer = null

function startPaymentPolling(orderId, requiredConfs) {
  if (_paymentPollingTimer) clearInterval(_paymentPollingTimer)

  _paymentPollingTimer = setInterval(async () => {
    try {
      const res = await api(`/api/payment/status/${orderId}`)
      if (res.ok) {
        document.getElementById('confirmations').textContent = res.confirmations
        document.getElementById('payment-status').textContent = res.statusLabel

        if (res.status === 'confirmed') {
          clearInterval(_paymentPollingTimer)
          alert('支付成功！会员已激活')
          closeModal()
          location.reload()
        } else if (res.status === 'expired') {
          clearInterval(_paymentPollingTimer)
          alert('订单已过期，请重新下单')
          closeModal()
        }
      }
    } catch (err) {
      console.error('Payment status poll error:', err)
    }
  }, 5000)
}

function stopPaymentPolling() {
  if (_paymentPollingTimer) {
    clearInterval(_paymentPollingTimer)
    _paymentPollingTimer = null
  }
}
```

- [ ] **Step 2: Add payment status endpoint to server/routes/payment.js**

```javascript
router.get('/payment/status/:orderId', authMiddleware, async (req, res) => {
  try {
    const order = await queryOne(
      'SELECT * FROM orders WHERE order_id = ? AND user_id = ?',
      [req.params.orderId, req.user.id]
    )
    if (!order) return res.json({ ok: false, error: '订单不存在' })

    const watch = await queryOne(
      'SELECT * FROM crypto_watch_list WHERE order_id = ?',
      [req.params.orderId]
    )

    res.json({
      ok: true,
      status: order.status,
      statusLabel: order.status_label,
      confirmations: watch?.confirmations || 0,
      requiredConfirmations: watch?.required_confirmations || 19,
      txHash: order.crypto_tx_hash,
    })
  } catch (err) {
    console.error('Payment status error:', err)
    res.json({ ok: false, error: '查询失败' })
  }
})
```

- [ ] **Step 3: Add CSS styles to public/ai/styles.css**

```css
/* USDT Payment Styles */
.crypto-payment-modal { padding: 24px; max-width: 480px; margin: 0 auto; }
.crypto-payment-modal h3 { margin-bottom: 16px; color: var(--text-primary); }
.chain-selector { display: flex; flex-direction: column; gap: 8px; margin: 16px 0; }
.chain-btn {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border: 1px solid var(--border);
  border-radius: 8px; background: var(--bg-secondary);
  cursor: pointer; transition: all 0.2s;
}
.chain-btn:hover { border-color: var(--accent); }
.chain-btn.active { border-color: var(--accent); background: rgba(var(--accent-rgb), 0.1); }
.chain-icon { font-size: 20px; }
.chain-name { flex: 1; font-weight: 500; }
.chain-fee { font-size: 12px; color: var(--text-secondary); }
.pay-btn {
  width: 100%; padding: 12px; margin-top: 16px;
  background: var(--accent); color: white; border: none;
  border-radius: 8px; font-size: 16px; cursor: pointer;
}
.crypto-payment-page { padding: 24px; text-align: center; max-width: 480px; margin: 0 auto; }
.payment-amount { font-size: 24px; font-weight: bold; margin: 16px 0; }
.chain-badge {
  display: inline-block; padding: 4px 8px; margin-left: 8px;
  background: var(--accent); color: white; border-radius: 4px;
  font-size: 12px;
}
.qr-code { margin: 24px auto; }
.qr-code img { width: 200px; height: 200px; border-radius: 8px; }
.payment-address { margin: 16px 0; }
.address-copy { display: flex; gap: 8px; margin-top: 8px; }
.address-copy input {
  flex: 1; padding: 8px 12px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg-secondary);
  font-family: monospace; font-size: 12px;
}
.address-copy button {
  padding: 8px 16px; background: var(--accent); color: white;
  border: none; border-radius: 6px; cursor: pointer;
}
.payment-info { margin: 16px 0; color: var(--text-secondary); }
.payment-status { margin-top: 16px; font-weight: 500; }
```

- [ ] **Step 4: Commit**

```bash
git add public/ai/app.js public/ai/styles.css server/routes/payment.js
git commit -m "feat: add USDT payment frontend UI and status endpoint"
```

---

### Task 11: Integration Test

**Covers:** [S6, S10]

**Files:**
- Test: `tests/payment.test.js` (extend existing)

- [ ] **Step 1: Add crypto payment tests**

```javascript
describe('Crypto Payment', () => {
  it('creates order with crypto_chain parameter', async () => {
    const res = await callRoute('POST', '/api/payment', {
      plan: 'plus',
      period: 'month',
      crypto_chain: 'trc20'
    }, { id: 1, plan: 'free' })
    expect(res.ok).toBe(true)
    expect(res.chain).toBe('trc20')
    expect(res.address).toBeDefined()
    expect(res.qrCode).toBeDefined()
  })

  it('returns error for invalid chain', async () => {
    const res = await callRoute('POST', '/api/payment', {
      plan: 'plus',
      period: 'month',
      crypto_chain: 'invalid'
    }, { id: 1, plan: 'free' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不支持')
  })

  it('returns error for missing chain', async () => {
    const res = await callRoute('POST', '/api/payment', {
      plan: 'plus',
      period: 'month'
    }, { id: 1, plan: 'free' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('请选择')
  })
})
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/payment.test.js
git commit -m "test: add USDT payment integration tests"
```

---

### Task 12: Final Verification

**Covers:** [S10]

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

Expected: Server starts without `[FATAL]` errors.

- [ ] **Step 2: Verify endpoints**

```bash
curl http://localhost:3000/api/payment?preview=1&plan=plus&period=month
```

Expected: JSON response with pricing info.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete USDT payment integration"
```

---

## Execution Handoff

This plan has 12 tasks. Tasks are independent enough for subagent execution but share DB state, so sequential execution is recommended.

**Execution approach:** Ask user preference via compose:ask.
