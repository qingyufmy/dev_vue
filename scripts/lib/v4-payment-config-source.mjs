import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const paymentConfigKeys = Object.freeze(['payment_mode', 'fixed_tron_address', 'fixed_erc20_address', 'fixed_bep20_address', 'fixed_sol_address'])
export const paymentConfigSourceFields = Object.freeze({ id: ['int', false], category: ['varchar(100)', false], key: ['varchar(100)', false],
  value: ['mediumtext', true], label: ['varchar(255)', true], sort_order: ['int', true], created_at: ['datetime', true], updated_at: ['datetime', true] })
export function inspectPaymentConfigSources(rows) {
  check(Array.isArray(rows), 'payment_config_source_invalid')
  const ids = new Set(), keys = new Set(), entries = [], blockers = []
  for (const source of rows) {
    exactKeys(source, Object.keys(paymentConfigSourceFields))
    for (const [field, [type, nullable]] of Object.entries(paymentConfigSourceFields)) {
      if (type === 'datetime') inspectWallClock(source[field])
      else if (type === 'mediumtext') check(source[field] === null || (typeof source[field] === 'string' && Buffer.byteLength(source[field], 'utf8') <= 16777215 && Buffer.from(source[field], 'utf8').toString('utf8') === source[field]), 'payment_config_value_invalid')
      else represent(source[field], type, nullable)
    }
    check(BigInt(source.id) > 0n && !ids.has(source.id), 'payment_config_id_invalid')
    check(source.category === 'crypto_wallet' && paymentConfigKeys.includes(source.key) && !keys.has(source.key), 'payment_config_scope_invalid')
    ids.add(source.id); keys.add(source.key)
    const add = code => blockers.push({ sourceId: source.id, code })
    if (source.created_at !== null || source.updated_at !== null) add('payment_config_time_basis_required')
    if (source.key === 'payment_mode') {
      if (source.value !== 'fixed') add('payment_config_mode_resolution_required')
    } else if (source.value !== null && source.value !== '' && !/^[\x21-\x7e]{1,100}$/.test(source.value)) add('payment_config_address_representation_invalid')
    entries.push({ sourceId: source.id, sourceHash: hash(source), source: { ...source }, valueKind: source.value === null ? 'null' : source.value === '' ? 'empty' : 'text' })
  }
  entries.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : 1)
  return { version: 'payment-config-source/v1', sourceFields: 8, entries, sourceHash: hash(entries.map(entry => entry.source)),
    missingKeys: paymentConfigKeys.filter(key => !keys.has(key)), blockers, historicalRecipientBindingVerified: false, custodyControlVerified: false }
}
