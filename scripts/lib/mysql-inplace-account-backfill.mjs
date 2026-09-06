import { MysqlBackfillRepository } from './v4-backfill-mysql-repository.mjs'
import { hash, requireBackfill as check, inplaceAccountTargets } from './v4-backfill-contract.mjs'
import { inplaceColumnSteps } from './dev-vue-column-upgrade.mjs'
import { loadFoundationSteps, tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { loadAccountBuildSteps, executeAccountBuild, inspectAccountBuild } from './inplace-account-build.mjs'
import { mysqlColumnStore, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { loadSourceEvidenceStep, executeSourceEvidence, inspectSourceEvidence } from './inplace-source-evidence-upgrade.mjs'
import { sourceEvidencePayload, insertSourceEvidence } from './v4-source-row-evidence.mjs'

const root = new URL('../../', import.meta.url)
const sourceNames = ['users', 'trading_accounts', 'mt5_account_ownership_history']

// Logical IDs survive final table renaming; only this fixed map resolves temporary storage.
export function inplaceAccountTable(logicalTable) {
  check(Object.hasOwn(inplaceAccountTargets, logicalTable), 'backfill_inplace_target_invalid')
  return inplaceAccountTargets[logicalTable]
}

export async function readInplaceAccountTargetIdentity(connection, { sourceEvidence = false } = {}) {
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(identity.db), 'backfill_inplace_database_invalid')
  check(await verifyInplaceJournal(connection), 'backfill_inplace_journal_required')
  const foundation = await loadFoundationSteps(root), build = await loadAccountBuildSteps(root)
  const evidence = sourceEvidence ? await loadSourceEvidenceStep(root) : null
  const result = sourceEvidence
    ? await executeSourceEvidence(inspectSourceEvidence(connection, mysqlColumnStore(connection, true)), foundation, build, evidence)
    : await executeAccountBuild(inspectAccountBuild(connection, mysqlColumnStore(connection, true)), foundation, build)
  check(result.steps.every(step => step.status === 'completed'), 'backfill_inplace_schema_not_complete')
  const sources = []
  for (const name of sourceNames) {
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
    check(typeof row?.['Create Table'] === 'string', 'backfill_inplace_source_missing')
    sources.push({ name, hash: tableDefinitionHash(row['Create Table']) })
  }
  const mode = sourceEvidence ? 'inplace-account-v2' : 'inplace-account-v1'
  return { serverUuid: identity.uuid, database: identity.db, storageMode: mode,
    schemaHash: hash({ mode, sources, routes: inplaceAccountTargets,
      steps: [...inplaceColumnSteps, ...foundation, ...build, ...(evidence ? [evidence] : [])].map(step => ({ id: step.id, checksum: step.checksum })) }) }
}

// Reuse the existing transaction/unknown-commit protocol and all journal operations.
// This adapter does not read the incompatible legacy schema_migrations layout.
export class MysqlInplaceAccountBackfillRepository extends MysqlBackfillRepository {
  constructor(pool, { sourceEvidence = false } = {}) {
    super(pool)
    check(typeof sourceEvidence === 'boolean', 'backfill_source_evidence_mode_invalid')
    this.sourceEvidence = sourceEvidence
  }
  transaction(work) {
    return super.transaction(tx => {
      tx.targetIdentity = () => readInplaceAccountTargetIdentity(tx.connection, { sourceEvidence: this.sourceEvidence })
      if (this.sourceEvidence) {
        const insertReceipt = tx.insertReceipt.bind(tx)
        tx.insertReceipt = async (run, stream, batch, row) => {
          sourceEvidencePayload(stream, row)
          await insertReceipt(run, stream, batch, row)
          await insertSourceEvidence(tx.connection, run, stream, row)
        }
      }
      return work(tx)
    })
  }
}
