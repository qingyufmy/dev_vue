import { readFile } from 'node:fs/promises'
import { loadObserverRegistrySeed } from './observer-registry-seed.mjs'
import { loadRiskStructureSource } from './risk-structure-source.mjs'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'

// Append-only registration. Execution requires a separate reviewed store/coordinator.
export async function loadRiskStructureMigration(root) {
  const observer = await loadObserverRegistrySeed(root)
  const prior = { context: observer.prior, seed: observer.step, steps: [...observer.prior.steps, observer.step] }
  if (prior.steps.length !== 166) throw Error('risk_structure_prior_version')
  const source = await loadRiskStructureSource(root)
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/043_risk_core_structures.sql', root), 'utf8'))
  if (hash(statements) !== hash(source.statements.map(row => row.sql))) throw Error('risk_structure_sql_drift')
  const priorRegistryHash = hash(prior.steps.map(({ id, checksum }) => ({ id, checksum })))
  const additions = statements.map((sql, index) => {
    const reference = source.statements[index]
    const body = { id: `inplace_043_${String(index + 1).padStart(2, '0')}_${reference.table}`, table: reference.table,
      sql, protocol: 'risk-core-structure/v1', priorRegistryHash,
      source: reference.source, sourceSha256: reference.sourceSha256, sourceStatementSha256: reference.statementSha256 }
    return Object.freeze({ ...body, checksum: hash(body) })
  })
  return { prior, priorRegistryHash, additions, steps: [...prior.steps, ...additions] }
}
