import { readFile } from 'node:fs/promises'
import { loadAccountProjectionMigration } from './inplace-account-projection-migration.mjs'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'

export const legacyCandleBuildTables = Object.freeze(['legacy_candle_backfill_v4', 'market_candles_build_v4', 'legacy_candle_mappings_v4'])

// Registers build tables only. Data fill and name promotion have separate protocols.
export async function loadLegacyCandleBuildMigration(root) {
  const prior = await loadAccountProjectionMigration(root)
  if (prior.steps.length !== 160) throw Error('legacy_candle_build_prior_version')
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/039_legacy_candle_build_tables.sql', root), 'utf8'))
  if (statements.length !== legacyCandleBuildTables.length) throw Error('legacy_candle_build_statement_count')
  const priorRegistryHash = hash(prior.steps.map(({ id, checksum }) => ({ id, checksum })))
  const additions = statements.map((sql, index) => {
    const table = legacyCandleBuildTables[index]
    if (!sql.startsWith('CREATE TABLE `' + table + '` (')) throw Error('legacy_candle_build_statement_target')
    const body = { id: `inplace_039_0${index + 1}_${table}`, table, sql, protocol: 'legacy-candle-build-migration/v1', priorRegistryHash }
    return Object.freeze({ ...body, checksum: hash(body) })
  })
  return { prior, priorRegistryHash, additions, steps: [...prior.steps, ...additions] }
}
