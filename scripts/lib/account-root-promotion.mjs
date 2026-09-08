import { createHash } from 'node:crypto'
import { canonical } from './v4-backfill-contract.mjs'

export const accountRootRenames = Object.freeze([
  ['trading_accounts', 'trading_accounts_legacy_v3'],
  ['trading_accounts_v4_build', 'trading_accounts'],
  ['trading_account_ownership_intervals_v4_build', 'trading_account_ownership_intervals'],
  ['trading_account_ownerships_v4_build', 'trading_account_ownerships'],
  ['user_trading_account_settings_v4_build', 'user_trading_account_settings'],
].map(pair => Object.freeze(pair)))
const sha = value => createHash('sha256').update(value).digest('hex')
export const promotionFingerprint = snapshot => sha(canonical(snapshot))
export function compactRootSnapshot(tables, promote = false) {
  const names = new Map(promote ? accountRootRenames : [])
  const result = tables.map(table => ({ name: names.get(table.name) ?? table.name,
    ddlSha256: sha(table.ddl.replace(/`([a-z][a-z0-9_]*)`/g, (full, name) => names.has(name) ? `\`${names.get(name)}\`` : full)),
    rows: table.rows, rowsSha256: table.rowsSha256 }))
  if (new Set(result.map(row => row.name)).size !== result.length) throw Error('account_promotion_name_collision')
  return result.sort((a, b) => a.name.localeCompare(b.name))
}
export function accountRootRenameSql(restore = false) {
  const pairs = restore ? accountRootRenames.map(([from, to]) => [to, from]).reverse() : accountRootRenames
  return 'RENAME TABLE ' + pairs.map(([from, to]) => `\`${from}\` TO \`${to}\``).join(', ')
}

// Exact full-schema and row fingerprints are supplied by the reviewed rehearsal.
// An unknown DDL result is inspected on the next call, never blindly replayed.
export async function executeAccountRootPromotion(store, proof, { apply = false, restore = false } = {}) {
  const actual = promotionFingerprint(await store.snapshot())
  if (actual === promotionFingerprint(proof.after)) return { status: 'already-applied', ddlCount: 0 }
  if (actual !== promotionFingerprint(proof.before)) throw Error('account_promotion_state_conflict')
  if (!apply) return { status: 'pending', ddlCount: 0 }
  try { await store.rename(accountRootRenameSql(restore)) }
  catch { throw Error('account_promotion_outcome_unknown') }
  if (promotionFingerprint(await store.snapshot()) !== promotionFingerprint(proof.after)) throw Error('account_promotion_postcondition_failed')
  return { status: 'applied', ddlCount: 1 }
}
