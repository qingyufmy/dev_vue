import { MysqlLearningCourseBackfillRepository } from './mysql-learning-course-backfill.mjs'
import { MysqlLearningProgressBackfillRepository } from './mysql-learning-progress-backfill.mjs'
import { loadLearningCompletionCoordinator } from './inplace-learning-completion-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { recoveryLearningDefinitionHash } from './learning-completion-recovery-rendering.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { hash, requireBackfill as check } from './v4-backfill-contract.mjs'

const root = new URL('../../', import.meta.url)
export function learningVerificationPool(pool) {
  return { async getConnection() {
    const connection = await pool.getConnection()
    // Historical verification takes row locks. Permit those reads but reject
    // business and journal writes before forwarding SQL to the real connection.
    return new Proxy(connection, { get(target, key) {
      if (key === 'query' || key === 'execute') return (sql, ...args) => {
        if (typeof sql !== 'string' || !/^(SELECT\s|SHOW\s|SET SESSION\s)/i.test(sql)) throw Error('learning_verify_write_forbidden')
        return target[key](sql, ...args)
      }
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
}
// Verify the full 64-step database, then retain the original manifest's identity
// for the unchanged 62-step import surface. This adapter exposes verification only.
export async function readLearningVerificationIdentityV2(connection, kind) {
  check(['courses','progress'].includes(kind), 'learning_verify_domain')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(['dev_vue','dev_vue_m1_source_20260907_02'].includes(identity.db)
    && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'learning_verify_identity')
  check(await verifyInplaceJournal(connection), 'learning_verify_journal')
  const plan = await loadLearningCompletionCoordinator(root), base = plan.store(connection)
  const store = { ...base, async tableHash(name) {
    const value = await base.tableHash(name)
    if (identity.db !== 'dev_vue_m1_source_20260907_02' || !['learning_courses','learning_lessons','learning_progress','learning_media_references'].includes(name)) return value
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
    return recoveryLearningDefinitionHash(identity.db, name, row['Create Table'])
  } }
  const result = await coordinateInplaceSchema(store, plan)
  check(result.structureComplete && result.steps.every(row => row.status === 'completed'), 'learning_verify_schema_incomplete')
  const sourceTable = kind === 'courses' ? 'courses' : 'progress', version = kind === 'courses' ? 'course' : 'progress'
  const [[source]] = await connection.query(`SHOW CREATE TABLE \`${sourceTable}\``)
  const storageMode = `inplace-learning-${version}-v1`
  return { serverUuid: identity.uuid, database: identity.db, storageMode,
    schemaHash: hash({ adapterVersion: `learning-${version}/v1`, storageMode, source: tableDefinitionHash(source['Create Table']),
      steps: plan.steps.slice(0, 62).map(({ id, checksum }) => ({ id, checksum })) }) }
}
export class MysqlLearningCourseVerificationV2 extends MysqlLearningCourseBackfillRepository {
  transaction(work) { return super.transaction(tx => { tx.targetIdentity = () => readLearningVerificationIdentityV2(tx.connection, 'courses'); return work(tx) }) }
}
export class MysqlLearningProgressVerificationV2 extends MysqlLearningProgressBackfillRepository {
  transaction(work) { return super.transaction(tx => { tx.targetIdentity = () => readLearningVerificationIdentityV2(tx.connection, 'progress'); return work(tx) }) }
}
