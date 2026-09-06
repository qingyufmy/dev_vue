import { BackfillError, exactKeys, hash, hashPattern, requireBackfill as check } from './v4-backfill-contract.mjs'
import { schemaFingerprint } from './v4-schema-fingerprint.mjs'
import { readBackfillTargetIdentity } from './v4-backfill-mysql-repository.mjs'

export function safeIdentifier(value) {
  check(typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value), 'backfill_identifier_invalid')
  return '`' + value + '`'
}
export function validateSourceBinding(source) {
  exactKeys(source, ['serverUuid', 'database', 'originalDatabase', 'snapshotHash', 'structureHash'])
  safeIdentifier(source.database); safeIdentifier(source.originalDatabase)
  check(source.database !== source.originalDatabase, 'backfill_source_not_mirror')
  check(typeof source.serverUuid === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(source.serverUuid), 'backfill_source_identity_invalid')
  check([source.snapshotHash, source.structureHash].every(v => typeof v === 'string' && hashPattern.test(v)), 'backfill_source_hash_invalid')
}
export async function readConnectionIdentity(connection) {
  const [[row]] = await connection.query('SELECT DATABASE() AS db, @@server_uuid AS server_uuid')
  return { database: row.db, serverUuid: row.server_uuid }
}

export function migrationStructureFingerprint(schema, definitions) {
  return schemaFingerprint(schema, definitions.map(item => ({ ...item,
    ddl: item.ddl.replace(/^\) ENGINE=[^\r\n]*$/gm, line => line.replace(/ AUTO_INCREMENT=[0-9]+\b/, '')),
  })))
}
export async function readMigrationStructure(connection) {
  const [schemas] = await connection.query('SELECT DEFAULT_CHARACTER_SET_NAME charset_name,DEFAULT_COLLATION_NAME collation_name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()')
  check(schemas.length === 1, 'backfill_schema_missing')
  const [tables] = await connection.query('SELECT TABLE_NAME table_name,TABLE_TYPE table_type,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
  check(tables.length > 0 && tables.length <= 1000, 'backfill_table_inventory_invalid')
  const definitions = []
  for (const table of tables) {
    check(table.table_type === 'BASE TABLE', 'backfill_unsupported_schema_object')
    check(table.engine === 'InnoDB', 'backfill_nontransactional_engine_unsupported')
    const [rows] = await connection.query('SHOW CREATE TABLE ' + safeIdentifier(table.table_name))
    check(rows.length === 1 && typeof rows[0]['Create Table'] === 'string', 'backfill_definition_missing')
    definitions.push({ name: table.table_name, ddl: rows[0]['Create Table'] })
  }
  // Executable schema objects require their own definer/scope review, never silently omit them.
  for (const [table, column] of [['TRIGGERS', 'TRIGGER_SCHEMA'], ['ROUTINES', 'ROUTINE_SCHEMA'], ['EVENTS', 'EVENT_SCHEMA']]) {
    const [[row]] = await connection.query(`SELECT COUNT(*) AS object_count FROM information_schema.${table} WHERE ${column}=DATABASE()`)
    check(String(row.object_count) === '0', 'backfill_executable_schema_objects_present')
  }
  return migrationStructureFingerprint(schemas[0], definitions)
}

export async function inspectBackfillWave(sourceConnection, targetConnection, request) {
  request = structuredClone(request)
  exactKeys(request, ['source', 'target', 'wave'])
  validateSourceBinding(request.source)
  exactKeys(request.target, ['serverUuid', 'database', 'structureHash', 'journalHash'])
  safeIdentifier(request.target.database)
  check(![request.source.database, request.source.originalDatabase].includes(request.target.database), 'backfill_target_is_source')
  check(typeof request.target.serverUuid === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.target.serverUuid), 'backfill_target_identity_invalid')
  check([request.target.structureHash, request.target.journalHash].every(v => typeof v === 'string' && hashPattern.test(v)), 'backfill_target_hash_invalid')
  exactKeys(request.wave, ['manifestHash', 'executable', 'blockers'])
  check(typeof request.wave.manifestHash === 'string' && hashPattern.test(request.wave.manifestHash) && typeof request.wave.executable === 'boolean' && Array.isArray(request.wave.blockers) && request.wave.blockers.every(v => typeof v === 'string'), 'backfill_wave_invalid')
  const blockers = [...request.wave.blockers]
  const observations = {}
  for (const [role, connection] of [['source', sourceConnection], ['target', targetConnection]]) {
    try {
      const identity = await readConnectionIdentity(connection)
      check(identity.database === request[role].database && identity.serverUuid === request[role].serverUuid, 'backfill_connection_identity_mismatch')
      const structure = await readMigrationStructure(connection)
      observations[role] = { ...identity, structureHash: structure.sha256, tableCount: structure.tableCount }
      if (structure.sha256 !== request[role].structureHash) blockers.push(role + ':structure_drift')
      if (role === 'target') {
        const journal = await readBackfillTargetIdentity(connection)
        observations.target.journalHash = journal.schemaHash
        if (journal.schemaHash !== request.target.journalHash) blockers.push('target:journal_drift')
      }
    } catch (error) { blockers.push(role + ':' + (error instanceof BackfillError ? error.code : 'inspection_failed')) }
  }
  if (!request.wave.executable) blockers.push('wave:not_executable')
  blockers.push('source:content_seal_not_verified', 'wave:approved_apply_path_not_implemented')
  return { readyForBackfill: false, snapshotContentVerified: false, requestHash: hash(request), observations, blockers: [...new Set(blockers)].sort() }
}
