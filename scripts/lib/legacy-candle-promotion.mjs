import { accountRootMigrationSnapshot } from './inplace-account-root-migration.mjs'

export const legacyCandleRenames = Object.freeze([
  Object.freeze(['market_candles', 'market_candles_legacy_v3']),
  Object.freeze(['market_candles_build_v4', 'market_candles']),
])
export const legacyCandleRenameSql = () => 'RENAME TABLE ' + legacyCandleRenames.map(([from, to]) => `\`${from}\` TO \`${to}\``).join(', ')

// Rewrite table positions only. Column/constraint names, literals and comments
// are not table references and must stay visible to the historical verifiers.
export function candleTableDefinition(ddl, names) {
  return ddl.replace(/^CREATE TABLE `([a-z][a-z0-9_]*)`/, (_full, name) => `CREATE TABLE \`${names.get(name) ?? name}\``)
    .replace(/^(  CONSTRAINT `[^`]+` FOREIGN KEY \([^)]+\) REFERENCES )`([a-z][a-z0-9_]*)`/gm,
      (_full, prefix, name) => `${prefix}\`${names.get(name) ?? name}\``)
}
export function legacyCandlePromotionSnapshot(tables, { promote = false, historical = false } = {}) {
  if (promote && historical) throw Error('legacy_candle_promotion_direction')
  const names = new Map(promote ? legacyCandleRenames : historical ? legacyCandleRenames.map(([a, b]) => [b, a]) : [])
  const known = new Set(tables.map(row => row.name))
  const first = historical ? 'market_candles_legacy_v3' : 'market_candles_build_v4'
  const absent = historical ? 'market_candles_build_v4' : promote ? 'market_candles_legacy_v3' : null
  if ((promote || historical) && (!known.has(first) || !known.has('market_candles') || known.has(absent))) throw Error('legacy_candle_promotion_layout')
  for (const row of tables) {
    if (!new RegExp('^CREATE TABLE `' + row.name + '` \\(').test(row.ddl)) throw Error('legacy_candle_promotion_definition')
  }
  return accountRootMigrationSnapshot(tables.map(row => ({ ...row, name: names.get(row.name) ?? row.name, ddl: candleTableDefinition(row.ddl, names) })))
}
