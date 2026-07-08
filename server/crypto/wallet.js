import { createHash } from 'crypto'
import { mnemonicToSeedSync } from '@scure/bip39'
import { HDKey } from '@scure/bip32'
import { privateToPublic, publicToAddress } from '@ethereumjs/util'
import { Keypair } from '@solana/web3.js'
import { queryOne, queryRun } from '../db.js'

const CHAIN_CONFIG = {
  ETH:  { path: "m/44'/60'/0'/0/{index}", coinType: 60, confirmations: 12 },
  BSC:  { path: "m/44'/60'/0'/0/{index}", coinType: 60, confirmations: 15 },
  TRON: { path: "m/44'/195'/0'/0/{index}", coinType: 195, confirmations: 19 },
  SOL:  { path: "m/44'/501'/0'/{index}'", coinType: 501, confirmations: 32 },
}

let _cachedMnemonic = null

function getMnemonic() {
  if (_cachedMnemonic) return _cachedMnemonic

  const envMnemonic = process.env.HD_WALLET_MNEMONIC
  if (envMnemonic) {
    _cachedMnemonic = envMnemonic
    return _cachedMnemonic
  }

  throw new Error('HD_WALLET_MNEMONIC 未配置（仅支持环境变量，勿存数据库）')
}

export async function initCryptoWallet() {
  try {
    getMnemonic()
    console.log('[Wallet] Crypto wallet initialized')
  } catch (err) {
    console.warn('[Wallet] Crypto wallet not configured:', err.message)
  }
}

export async function getCryptoWalletApiKey(chain) {
  switch (chain) {
    case 'TRON': return process.env.TRONGRID_API_KEY || ''
    case 'ETH': return process.env.ETHERSCAN_API_KEY || ''
    case 'BSC': return process.env.BSCSCAN_API_KEY || ''
    case 'SOL': return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
    default: return ''
  }
}

function deriveChildKey(chain, index) {
  const cfg = CHAIN_CONFIG[chain]
  if (!cfg) throw new Error(`不支持的链: ${chain}`)
  const seed = mnemonicToSeedSync(getMnemonic())
  const master = HDKey.fromMasterSeed(seed)
  const path = cfg.path.replace('{index}', index)
  return master.derive(path)
}

export function derivePrivateKey(chain, index) {
  const childKey = deriveChildKey(chain, index)
  return Buffer.from(childKey.privateKey).toString('hex')
}

export async function getMainAddress() {
  return deriveAddress('TRON', 0)
}

function ethAddressFromPrivateKey(privKey) {
  const pubKey = privateToPublic(privKey)
  const addrBytes = publicToAddress(pubKey)
  return '0x' + Buffer.from(addrBytes).toString('hex')
}

let _TronWeb = null
export async function loadTronWeb() {
  if (!_TronWeb) {
    const mod = await import('tronweb')
    _TronWeb = mod.TronWeb
  }
  return _TronWeb
}

function tronAddressFromPrivateKey(privKey) {
  const privKeyHex = Buffer.from(privKey).toString('hex')
  if (_TronWeb) {
    return _TronWeb.address.fromPrivateKey(privKeyHex)
  }
  const pubKey = privateToPublic(privKey)
  const addrBytes = publicToAddress(pubKey)
  return base58CheckEncode([0x41, ...addrBytes])
}

function solAddressFromPrivateKey(privKey) {
  const keypair = Keypair.fromSeed(privKey)
  return keypair.publicKey.toBase58()
}

function base58CheckEncode(data) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const payload = new Uint8Array(data)
  const checksumInput = new Uint8Array(payload.length + 4)
  checksumInput.set(payload)
  const firstHash = createHash('sha256').update(payload).digest()
  const secondHash = createHash('sha256').update(firstHash).digest()
  checksumInput.set(secondHash.slice(0, 4), payload.length)

  let num = 0n
  for (const b of checksumInput) {
    num = num * 256n + BigInt(b)
  }
  let encoded = ''
  while (num > 0n) {
    encoded = ALPHABET[Number(num % 58n)] + encoded
    num = num / 58n
  }
  for (const b of checksumInput) {
    if (b === 0) encoded = ALPHABET[0] + encoded
    else break
  }
  return encoded
}

export function deriveAddress(chain, index) {
  const childKey = deriveChildKey(chain, index)
  const privKey = childKey.privateKey
  if (!privKey) throw new Error('无法从 HDKey 获取私钥')

  switch (chain) {
    case 'ETH':
    case 'BSC':
      return ethAddressFromPrivateKey(privKey)
    case 'TRON':
      return tronAddressFromPrivateKey(privKey)
    case 'SOL':
      return solAddressFromPrivateKey(privKey)
    default:
      throw new Error(`不支持的链: ${chain}`)
  }
}

export function validateAddress(chain, address) {
  if (!address || typeof address !== 'string') return false

  switch (chain) {
    case 'ETH':
    case 'BSC':
      return /^0x[0-9a-fA-F]{40}$/.test(address)
    case 'TRON':
      return /^T[A-Za-z1-9]{33}$/.test(address)
    case 'SOL':
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
  return row ? row.cnt : 0
}

export async function saveAddress(chain, index, address) {
  return queryRun(
    'INSERT INTO wallet_keys (chain, address_index, address) VALUES (?, ?, ?)',
    [chain, index, address]
  )
}

export function getRequiredConfirmations(chain) {
  return CHAIN_CONFIG[chain]?.confirmations ?? 12
}
