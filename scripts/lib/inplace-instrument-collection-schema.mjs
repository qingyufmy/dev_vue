import { readFile } from 'node:fs/promises'
import { loadRiskPolicyReceiptUpgrade } from './risk-policy-receipt-upgrade.mjs'
import { splitSqlStatements, sha256 } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'

export async function loadInstrumentCollectionMigration(root) {
  const reference = JSON.parse(await readFile(new URL('docs/architecture/risk-policy-receipt-and-release-reference-v2-20260909.json', root), 'utf8'))
  const prior = await loadRiskPolicyReceiptUpgrade(root, reference)
  if (prior.steps.length !== 175) throw Error('instrument_schema_prior_version')
  const source = 'server/db/migrations/inplace/045_instrument_collection_requests.sql'
  const bytes = await readFile(new URL(source, root))
  // Reviewed source identity; never silently bless edits after registration.
  if (sha256(bytes) !== 'f1821bf57bbffac9f10dce3039cb016b8de073badb135251a49e144fe3342e90') throw Error('instrument_schema_source_changed')
  const statements = splitSqlStatements(bytes.toString('utf8'))
  if (statements.length !== 1 || !/^CREATE TABLE instrument_collection_requests_v4\s*\(/.test(statements[0])) throw Error('instrument_schema_scope')
  const body = { id: 'inplace_045_01_instrument_collection_requests_v4', table: 'instrument_collection_requests_v4',
    protocol: 'instrument-collection-structure/v1', source, sourceSha256: sha256(bytes), sql: statements[0],
    priorRegistryHash: hash(prior.steps.map(({ id, checksum }) => ({ id, checksum }))) }
  const step = { ...body, checksum: hash(body) }
  return { prior, step, steps: [...prior.steps, step] }
}

export function inspectInstrumentCollectionPrerequisites({ tables, columns, keys }) {
  const problems = []
  for (const [table, type] of [['users', 'int'], ['trading_accounts', 'bigint unsigned']]) {
    if (!tables.some(row => row.name === table && row.engine === 'InnoDB')) problems.push(`${table}_engine`)
    if (!columns.some(row => row.tableName === table && row.name === 'id' && row.type === type && row.nullable === 'NO')) problems.push(`${table}_id_type`)
    const primary = keys.filter(row => row.tableName === table && row.indexName === 'PRIMARY')
    if (primary.length !== 1 || primary[0].columnName !== 'id' || Number(primary[0].nonUnique) !== 0) problems.push(`${table}_primary_key`)
  }
  return { ready: problems.length === 0, problems, targetExists: tables.some(row => row.name === 'instrument_collection_requests_v4') }
}
