import { readFile } from 'node:fs/promises'
import { loadLegacyCandlePromotion } from './inplace-legacy-candle-promotion.mjs'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'

// Registration only: execution must preserve the promoted 164-step historical checks.
export async function loadTradingContextChanges(root) {
  const prior = await loadLegacyCandlePromotion(root)
  if (prior.steps.length !== 164) throw Error('context_changes_prior_version')
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/041_trading_context_changes.sql', root), 'utf8'))
  if (statements.length !== 1 || !statements[0].startsWith('CREATE TABLE `trading_context_changes_v4` (')) throw Error('context_changes_sql_target')
  const priorRegistryHash = hash(prior.steps.map(({ id, checksum }) => ({ id, checksum })))
  const body = { id: 'inplace_041_01_trading_context_changes_v4', table: 'trading_context_changes_v4',
    sql: statements[0], protocol: 'trading-context-changes/v1', priorRegistryHash }
  const step = Object.freeze({ ...body, checksum: hash(body) })
  return { prior, priorRegistryHash, additions: [step], steps: [...prior.steps, step] }
}
