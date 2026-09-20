import { createHash } from 'node:crypto'
import { hash, requireBackfill as check } from './v4-backfill-contract.mjs'

export const subscriptionRootRenames = Object.freeze([
  ['strategy_subscriptions', 'strategy_subscriptions_legacy_v3'],
  ['strategy_subscriptions_v4_build', 'strategy_subscriptions'],
  ['subscription_schedules_v4_build', 'subscription_schedules'],
  ['subscription_execution_preferences_v4_build', 'subscription_execution_preferences'],
].map(pair => Object.freeze(pair)))

export function subscriptionRootRenameSql({ restore = false } = {}) {
  const pairs = restore ? subscriptionRootRenames.map(([from, to]) => [to, from]).reverse() : subscriptionRootRenames
  return 'RENAME TABLE ' + pairs.map(([from, to]) => `\`${from}\` TO \`${to}\``).join(', ')
}

// Pure prediction only. No database admission or authorization to run a migration.
export function subscriptionRootSnapshot(tables, { promote = false } = {}) {
  check(Array.isArray(tables) && tables.length > 0, 'subscription_promotion_snapshot_empty')
  const names = new Map(promote ? subscriptionRootRenames : [])
  const result = tables.map(table => {
    check(typeof table.name === 'string' && /^[a-z][a-z0-9_]*$/.test(table.name)
      && typeof table.ddl === 'string' && Number.isSafeInteger(table.rows) && table.rows >= 0
      && /^[a-f0-9]{64}$/.test(table.rowsSha256), 'subscription_promotion_snapshot_invalid')
    // Never rewrite constraint identifiers, comments or arbitrary SQL literals.
    const ddl = table.ddl.replace(/'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|\/\*[\s\S]*?\*\/|--[^\r\n]*|#[^\r\n]*|(CREATE TABLE |REFERENCES )`([a-z][a-z0-9_]*)`|`(?:``|[^`])*`/g,
      (full, prefix, name) => names.has(name) ? `${prefix}\`${names.get(name)}\`` : full)
    return { name: names.get(table.name) ?? table.name, ddlSha256: createHash('sha256').update(ddl).digest('hex'),
      rows: table.rows, rowsSha256: table.rowsSha256 }
  })
  check(new Set(result.map(row => row.name)).size === result.length, 'subscription_promotion_name_collision')
  if (promote) check(subscriptionRootRenames.every(([from]) => tables.some(table => table.name === from)), 'subscription_promotion_source_missing')
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

export function classifySubscriptionPromotion(actual, proof) {
  if (hash(actual) === hash(proof.after)) return 'applied'
  if (hash(actual) === hash(proof.before)) return 'pending'
  return 'conflict'
}
