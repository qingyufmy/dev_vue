import { exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
const environmentKeys = new Set(['hd_mnemonic', 'trongrid_api_key', 'etherscan_api_key', 'bscscan_api_key', 'solana_rpc_url'])
// Classifies metadata only. This is a migration work list, never deletion approval.
export function classifySettingsInventory(entries) {
  check(Array.isArray(entries), 'settings_disposition_input')
  const ids = new Set()
  return entries.map(row => {
    exactKeys(row, ['id', 'category', 'key', 'valueKind', 'valueBytes', 'jsonValid', 'sortOrder', 'createdAtRaw', 'updatedAtRaw', 'rowSha256', 'sensitiveNameCandidate'])
    check(typeof row.id === 'string' && /^[1-9][0-9]*$/.test(row.id) && !ids.has(row.id)
      && typeof row.category === 'string' && typeof row.key === 'string' && /^[a-f0-9]{64}$/.test(row.rowSha256), 'settings_disposition_identity')
    ids.add(row.id)
    let disposition = 'system_setting_review', ownerId = null
    if (row.category === 'quote_symbol') {
      const match = /^quote_symbol_([1-9][0-9]*)$/.exec(row.key)
      check(match && BigInt(match[1]) <= 2147483647n, 'settings_disposition_owner')
      ownerId = match[1]; disposition = 'user_preference_review'
    } else if (row.category === 'auth') disposition = 'legacy_auth_consumer_review'
    else if (row.category === 'crypto_wallet' && environmentKeys.has(row.key)) disposition = 'environment_replacement_review'
    else if (row.category === 'crypto_wallet' && row.key === 'rate_source') disposition = 'legacy_rate_consumer_review'
    return { sourceId: row.id, category: row.category, key: row.key, sourceRowSha256: row.rowSha256,
      disposition, ownerId, exposure: 'restricted_until_reviewed', valueTypeApproved: false, deletionAuthorized: false }
  })
}
