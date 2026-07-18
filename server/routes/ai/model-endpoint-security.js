import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const DNS_CACHE_TTL_MS = 5 * 60 * 1000
const dnsCache = new Map()
const TRUSTED_PROVIDER_HOSTS = new Set([
  'api.deepseek.com', 'api.openai.com', 'api.moonshot.cn', 'api.kimi.com',
  'dashscope.aliyuncs.com', 'open.bigmodel.cn', 'ark.cn-beijing.volces.com',
])

function allowPrivateEndpoints() {
  return String(process.env.AI_ALLOW_PRIVATE_MODEL_ENDPOINTS || '').toLowerCase() === 'true'
}

function parseIpv4(address) {
  const parts = String(address).split('.').map(Number)
  return parts.length === 4 && parts.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ? parts : null
}

export function isPrivateOrReservedAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice(7)
    if (isIP(mapped) === 4) return isPrivateOrReservedAddress(mapped)
    const hex = mapped.split(':')
    if (hex.length === 2 && hex.every(part => /^[0-9a-f]{1,4}$/.test(part))) {
      const high = parseInt(hex[0], 16)
      const low = parseInt(hex[1], 16)
      return isPrivateOrReservedAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
  }
  if (isIP(value) === 4) {
    const [a, b, c] = parseIpv4(value)
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
  }
  if (isIP(value) === 6) {
    return value === '::' || value === '::1'
      || value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value) || value.startsWith('ff')
      || value.startsWith('2001:db8:')
  }
  return true
}

function parseAndValidateUrl(rawUrl) {
  let parsed
  try { parsed = new URL(String(rawUrl || '')) } catch { throw new Error('model_endpoint_invalid_url') }
  if (parsed.username || parsed.password) throw new Error('model_endpoint_credentials_forbidden')
  if (!allowPrivateEndpoints() && parsed.protocol !== 'https:') throw new Error('model_endpoint_https_required')
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('model_endpoint_protocol_forbidden')
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('model_endpoint_private_network_forbidden')
  }
  if (!allowPrivateEndpoints() && isIP(hostname) && isPrivateOrReservedAddress(hostname)) {
    throw new Error('model_endpoint_private_network_forbidden')
  }
  return parsed
}

export function normalizeModelBaseUrl(rawUrl) {
  const parsed = parseAndValidateUrl(rawUrl)
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/+$/, '')
}

async function resolveAddresses(hostname, lookup = dnsLookup) {
  const cached = dnsCache.get(hostname)
  if (lookup === dnsLookup && cached && cached.expiresAt > Date.now()) return cached.addresses
  let rows
  try { rows = await lookup(hostname, { all: true, verbatim: true }) } catch { throw new Error('model_endpoint_dns_failed') }
  const addresses = (Array.isArray(rows) ? rows : [rows]).map(row => row?.address).filter(Boolean)
  if (!addresses.length) throw new Error('model_endpoint_dns_failed')
  if (lookup === dnsLookup) dnsCache.set(hostname, { addresses, expiresAt: Date.now() + DNS_CACHE_TTL_MS })
  return addresses
}

export async function assertSafeModelEndpoint(rawUrl, { lookup = dnsLookup } = {}) {
  const parsed = parseAndValidateUrl(rawUrl)
  if (allowPrivateEndpoints()) return parsed
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(hostname) || TRUSTED_PROVIDER_HOSTS.has(hostname)) return parsed
  if (process.env.NODE_ENV === 'test' && /\.(test|example|invalid)$/.test(parsed.hostname)) return parsed
  const addresses = await resolveAddresses(hostname, lookup)
  if (addresses.some(isPrivateOrReservedAddress)) throw new Error('model_endpoint_private_network_forbidden')
  return parsed
}

export function resetModelEndpointCacheForTests() {
  dnsCache.clear()
}
