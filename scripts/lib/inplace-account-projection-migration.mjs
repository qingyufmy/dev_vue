import { readFile } from 'node:fs/promises'
import { loadObserverContextMigration } from './inplace-observer-context-migration.mjs'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'

export const accountProjectionTables = Object.freeze(['account_runtime_snapshots', 'market_quotes', 'open_position_snapshots',
  'pending_order_snapshots', 'trading_projection_revisions', 'trading_projection_provenance_v4'])

// Defines new CREATE steps only. No automatic execution or legacy candle conversion.
export async function loadAccountProjectionMigration(root) {
  const prior = await loadObserverContextMigration(root)
  if (prior.steps.length !== 154) throw Error('account_projection_prior_version')
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/038_account_market_projection_tables.sql', root), 'utf8'))
  if (statements.length !== accountProjectionTables.length) throw Error('account_projection_statement_count')
  const priorRegistryHash = hash(prior.steps.map(({ id, checksum }) => ({ id, checksum })))
  const additions = statements.map((sql, index) => {
    const table = accountProjectionTables[index]
    if (!sql.startsWith('CREATE TABLE `' + table + '` (')) throw Error('account_projection_statement_target')
    const body = { id: `inplace_038_0${index + 1}_${table}`, table, sql, protocol: 'account-projection-migration/v1', priorRegistryHash }
    return Object.freeze({ ...body, checksum: hash(body) })
  })
  return { prior, priorRegistryHash, additions, steps: [...prior.steps, ...additions] }
}
