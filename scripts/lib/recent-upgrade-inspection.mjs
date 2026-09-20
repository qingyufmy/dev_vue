import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { verifyInplaceJournal } from './mysql-inplace-column-store.mjs'

const column = (name, type, nullable = 'NO', collation = null, defaultValue = null) => [name, type, nullable, collation, defaultValue, '']
const index = (name, columnName, unique = 0) => [name, columnName, unique, null, 'BTREE', 'YES', 'A']
const fk = (purpose) => [`fk_model_assignment_${purpose}`, `${purpose}_model_profile_id`, 'ai_model_profiles', 'id', 'NO ACTION', 'NO ACTION']
export const recentSources = [
  { migrationId: '20260914_029_market_source_selections', id: 'inplace_081_01_market_source_selections', table: 'market_source_selections',
    hash: 'dd175e7c7d4ec3419657e93214b8ac386aab62f86a4efec1f74809f95b7a39e3',
    columns: [column('pool_key','varchar(40)','NO','ascii_bin'),column('standard_symbol','varchar(64)','NO','ascii_bin'),column('revision','bigint unsigned'),column('source_generation','bigint unsigned'),column('state_json','json'),column('updated_at_utc','datetime(3)')],
    indexes: [index('PRIMARY','pool_key'),index('PRIMARY','standard_symbol')], foreignKeys: [] },
  { migrationId: '20260915_030_model_configuration_receipts', id: 'inplace_082_01_model_configuration_receipts', table: 'model_configuration_receipts_v4',
    hash: 'fc9e8e33853d2a8ce7279df52ff86baadf4e7877f5fb91348b430ebb38ac2e51',
    columns: [column('actor_user_id','int'),column('request_id','varchar(64)','NO','utf8mb4_unicode_ci'),column('model_profile_id','int'),column('request_sha256','char(64)','NO','utf8mb4_unicode_ci'),column('result_json','json'),column('created_at_utc','datetime(3)')],
    indexes: [index('PRIMARY','actor_user_id'),index('PRIMARY','request_id'),index('idx_model_configuration_audit','model_profile_id',1),index('idx_model_configuration_audit','created_at_utc',1)], foreignKeys: [] },
  { migrationId: '20260915_031_model_assignments', id: 'inplace_083_01_model_assignments', table: 'user_model_assignments_v4',
    hash: '5548a01c2fb9f89bc40a4c5193ae91d4a9a08ec193c25e7145bdacdb3d718f01',
    columns: [column('user_id','int'),column('analysis_model_profile_id','int','YES'),column('trader_model_profile_id','int','YES'),column('review_model_profile_id','int','YES'),column('revision','bigint unsigned','NO',null,'1'),column('updated_at_utc','datetime(3)')],
    indexes: [index('PRIMARY','user_id'),index('fk_model_assignment_analysis','analysis_model_profile_id',1),index('fk_model_assignment_review','review_model_profile_id',1),index('fk_model_assignment_trader','trader_model_profile_id',1)],
    foreignKeys: [fk('analysis'),fk('review'),fk('trader')] },
]

export async function loadRecentSources(root) {
  return Promise.all(recentSources.map(async source => {
    const bytes = await readFile(new URL(`server/db/migrations/${source.migrationId}.sql`, root))
    if (sha256(bytes) !== source.hash || splitSqlStatements(bytes.toString()).length !== 1) throw new Error('upgrade_source_changed')
    return { ...source, checksum: sha256(JSON.stringify({ id: source.id, migrationId: source.migrationId, migrationChecksum: source.hash })) }
  }))
}
export function classifyRecentSource(source, actual, history) {
  if (history && history.checksum !== source.checksum) return { status: 'history_conflict', differences: ['checksum'] }
  if (!actual) return { status: history ? 'history_conflict' : 'pending', differences: history ? ['table_missing'] : [] }
  const expected = { table: ['BASE TABLE','InnoDB','utf8mb4_unicode_ci'], columns: source.columns, indexes: source.indexes, foreignKeys: source.foreignKeys, triggers: [], checks: [] }
  const differences = Object.keys(expected).filter(key => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]))
  if (differences.length) return { status: 'schema_conflict', differences }
  if (!history) return { status: 'reconciliation_required', differences: [] }
  return { status: history.status === 'completed' ? 'completed' : 'recovery_required', differences: [] }
}
export async function inspectRecentUpgrades(db, sources) {
  const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  const hasJournal = await verifyInplaceJournal(db)
  const steps = []
  for (const source of sources) {
    const [tables] = await db.execute('SELECT TABLE_TYPE kind,ENGINE engine,TABLE_COLLATION collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [source.table])
    let actual = null
    if (tables.length) {
      const [columns] = await db.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLLATION_NAME collation,COLUMN_DEFAULT defaultValue,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [source.table])
      const [indexes] = await db.execute('SELECT INDEX_NAME name,COLUMN_NAME col,NON_UNIQUE nonUnique,SUB_PART subPart,INDEX_TYPE type,IS_VISIBLE visible,COLLATION direction FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY BINARY INDEX_NAME,SEQ_IN_INDEX', [source.table])
      const [keys] = await db.execute('SELECT k.CONSTRAINT_NAME name,k.COLUMN_NAME col,k.REFERENCED_TABLE_NAME target,k.REFERENCED_COLUMN_NAME targetCol,r.UPDATE_RULE updateRule,r.DELETE_RULE deleteRule,k.REFERENCED_TABLE_SCHEMA targetSchema FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION', [source.table])
      const [triggers] = await db.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [source.table])
      const [checks] = await db.execute("SELECT CONSTRAINT_NAME name FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_TYPE='CHECK'", [source.table])
      actual = { table: [tables[0].kind,tables[0].engine,tables[0].collation],
        columns: columns.map(c => [c.name,c.type,c.nullable,c.collation,c.defaultValue === null ? null : String(c.defaultValue),c.extra]),
        indexes: indexes.map(i => [i.name,i.col,Number(i.nonUnique),i.subPart,i.type,i.visible,i.direction]),
        foreignKeys: keys.map(k => [k.name,k.col,k.targetSchema === identity.db ? k.target : `${k.targetSchema}.${k.target}`,k.targetCol,k.updateRule,k.deleteRule]), triggers, checks }
    }
    const [history] = hasJournal ? await db.execute('SELECT checksum_sha256 checksum,status FROM database_upgrade_steps_v4 WHERE id=?',[source.id]) : [[]]
    steps.push({ migrationId: source.migrationId, id: source.id, table: source.table, sourceChecksum: source.hash, checksum: source.checksum, ...classifyRecentSource(source,actual,history[0]), observedSchemaHash: actual ? sha256(JSON.stringify(actual)) : null })
  }
  return { scope: 'recent_029_031_only', executable: false, writes: false, identity, journal: hasJournal ? 'available' : 'missing', steps }
}
