import { readFile } from 'node:fs/promises'
import { loadHistoryRuntimeUpgrade } from './history-runtime-upgrade.mjs'
import { splitSqlStatements, sha256 } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { hash } from './v4-backfill-contract.mjs'

export async function loadHistoryCollectionReceiptUpgrade(root) {
  const prior = await loadHistoryRuntimeUpgrade(root, JSON.parse(await readFile(new URL('docs/architecture/history-runtime-reference-20260909.json', root), 'utf8')))
  const report = JSON.parse(await readFile(new URL('docs/architecture/strategy-write-reference-v54-20260910.json', root), 'utf8'))
  const reference = report.historyCollectionReceipts
  const source = 'server/db/migrations/inplace/051_history_collection_receipts.sql'
  const bytes = await readFile(new URL(source, root)), sourceSha256 = sha256(bytes)
  if (!report.passed || report.existingDatabaseWrites !== 0 || report.referenceDatabaseRemoved !== true
    || report.serverUuid !== 'ac423207-6ef3-11f1-b302-000c29fda104' || !reference?.passed || !reference.foreignKeysVerified
    || reference.migrationSha256 !== sourceSha256 || !reference.checks.includes('actual-account-and-user-foreign-keys')) throw Error('history_collection_reference_invalid')
  const table = 'terminal_history_collection_receipts_v4', statements = splitSqlStatements(bytes.toString('utf8'))
  if (statements.length !== 1 || !statements[0].startsWith(`CREATE TABLE ${table} (`)
    || !reference.canonicalDdl?.startsWith(`CREATE TABLE \`${table}\` (`)) throw Error('history_collection_ddl_invalid')
  const body = { id: `inplace_051_01_${table}`, table, operation: 'CREATE', protocol: 'history-collection-receipt-structure/v1',
    source, sourceSha256, sql: statements[0], priorRegistryHash: hash(prior.steps.map(({ id, checksum }) => ({ id, checksum }))),
    beforeHash: null, afterHash: tableDefinitionHash(reference.canonicalDdl) }
  const step = { ...body, checksum: hash(body) }
  return { prior, steps: [...prior.steps, step], added: [step], finalTableHashes: { ...prior.finalTableHashes, [table]: step.afterHash }, referenceHash: hash(report) }
}
