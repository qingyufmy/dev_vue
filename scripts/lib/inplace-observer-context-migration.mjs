import { readFile } from 'node:fs/promises'
import { loadTerminalRouteMigration } from './inplace-terminal-route-migration.mjs'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'

export const observerContextTables = Object.freeze(['observer_sources', 'observer_channels', 'observer_channel_accesses', 'trading_contexts'])

// Append-only definition. Live inspection and execution require a separate
// coordinator that preserves all 150 prior steps and protected tables.
export async function loadObserverContextMigration(root) {
  const prior = await loadTerminalRouteMigration(root)
  if (prior.steps.length !== 150) throw Error('observer_context_prior_version')
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/037_observer_context_tables.sql', root), 'utf8'))
  if (statements.length !== observerContextTables.length) throw Error('observer_context_statement_count')
  const priorRegistryHash = hash(prior.steps.map(({ id, checksum }) => ({ id, checksum })))
  const additions = statements.map((sql, index) => {
    const table = observerContextTables[index]
    if (!sql.startsWith('CREATE TABLE `' + table + '` (')) throw Error('observer_context_statement_target')
    const body = { id: `inplace_037_0${index + 1}_${table}`, table, sql, protocol: 'observer-context-migration/v1', priorRegistryHash }
    return Object.freeze({ ...body, checksum: hash(body) })
  })
  return { prior, priorRegistryHash, additions, steps: [...prior.steps, ...additions] }
}
