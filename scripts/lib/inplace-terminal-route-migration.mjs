import { readFile } from 'node:fs/promises'
import { loadAccountRootMigration } from './inplace-account-root-migration.mjs'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'

export const terminalRouteTables = Object.freeze(['terminal_account_bindings', 'bridge_connection_sessions'])

// Defines the append-only registry. This loader does not execute or validate live database state.
export async function loadTerminalRouteMigration(root) {
  const prior = await loadAccountRootMigration(root)
  if (prior.steps.length !== 148) throw Error('terminal_route_prior_version')
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/036_terminal_route_tables.sql', root), 'utf8'))
  if (statements.length !== terminalRouteTables.length) throw Error('terminal_route_statement_count')
  const priorRegistryHash = hash(prior.steps.map(({ id, checksum }) => ({ id, checksum })))
  const additions = statements.map((sql, index) => {
    const table = terminalRouteTables[index]
    if (!sql.startsWith('CREATE TABLE `' + table + '` (')) throw Error('terminal_route_statement_target')
    const body = { id: `inplace_036_0${index + 1}_${table}`, table, sql, protocol: 'terminal-route-migration/v1', priorRegistryHash }
    return Object.freeze({ ...body, checksum: hash(body) })
  })
  return { prior, priorRegistryHash, additions, steps: [...prior.steps, ...additions] }
}
