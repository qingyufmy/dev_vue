import { readSchemaFingerprint } from './v4-schema-fingerprint.mjs'

const SOURCE_DATABASE = 'dev_vue'
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/
const RESTORE_DATABASE_PATTERN = /^dev_vue_m1_source_\d{8}_\d{2}$/
// MySQL server_uuid values are canonical UUID strings, but deployments and
// test fixtures are not required to use a particular RFC version/variant.
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const MYSQL_84_PATTERN = /^8\.4\.\d+(?:[.-][0-9a-z._-]+)?$/i
const MAX_TABLES = 512
const DEFAULT_TIMEOUT_MS = 60_000
const ROLLBACK_TIMEOUT_MS = 1_000

const FORBIDDEN_DATABASES = new Set(['a', 'b', 'dev_vue_a', 'dev_vue_b'])

/**
 * Stable, intentionally detail-free error raised by the backup preflight.
 * Driver errors, SQL text, and database contents are never attached to it.
 */
export class BackupPreflightError extends Error {
  constructor(code) {
    super(code)
    this.name = 'BackupPreflightError'
    this.code = code
  }
}

/**
 * Inspect one explicitly selected database using a bounded read-only snapshot.
 *
 * This is an observation of the selected database, not proof that a frozen
 * backup exists or that a restore/import has happened.  The transaction gives
 * the row-count scan a consistent read snapshot; information_schema and DDL
 * metadata remain observational, so an external backup process must freeze and
 * attest its schema DDL separately.
 */
export async function inspectBackupDatabase(connection, {
  database,
  expectedServerUuid,
  role,
  sourceDatabase = SOURCE_DATABASE,
  restoreDatabase,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  validateConnection(connection)
  validateInspectionOptions({ database, expectedServerUuid, role, sourceDatabase, restoreDatabase, timeoutMs })

  const deadline = Date.now() + timeoutMs
  let connectionAborted = false
  const query = createBoundedQuery(connection, deadline, () => { connectionAborted = true })
  let transactionStarted = false
  let operationError = null
  let result = null

  try {
    const identity = await readIdentity(query)
    validateIdentity(identity, database, expectedServerUuid)

    await query("SET SESSION time_zone = '+00:00'")
    await query('SET SESSION MAX_EXECUTION_TIME = 10000')
    await query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    transactionStarted = true
    await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')

    const serverUuid = normalizeUuid(identity.server_uuid)
    const mysqlVersion = await readAndValidateMysqlVersion(query)
    const settings = await readOptionalServerSettings(query)

    const tableRows = await readTableMetadata(query, database)
    const tables = normalizeTableMetadata(tableRows)
    if (tables.length > MAX_TABLES) throw new BackupPreflightError('backup_preflight_table_limit_exceeded')

    const columnRows = await readColumnMetadata(query, database)
    const columnMap = normalizeColumnMetadata(columnRows, tables)

    const primaryRows = await readPrimaryKeyMetadata(query, database)
    const primaryKeyMap = normalizePrimaryKeyMetadata(primaryRows, tables, columnMap)

    const objectCounts = await readSourceObjectCounts(query, database)
    if (objectCounts.triggers > 0 || objectCounts.routines > 0 || objectCounts.events > 0) {
      throw new BackupPreflightError('backup_preflight_active_objects_present')
    }

    const fingerprintConnection = { query }
    let beforeFingerprint
    try {
      beforeFingerprint = await readSchemaFingerprint(fingerprintConnection)
    } catch (error) {
      if (error instanceof BackupPreflightError && error.code === 'backup_preflight_timeout') throw error
      throw new BackupPreflightError('backup_preflight_fingerprint_failed')
    }
    validateFingerprintTables(beforeFingerprint, tables)

    const observedTables = []
    let totalRows = 0n
    for (const table of tables) {
      const rowCount = await readTableCount(query, database, table.name)
      totalRows += rowCount
      observedTables.push({
        name: table.name,
        rowCount: rowCount.toString(),
        columns: columnMap.get(table.name),
        primaryKey: primaryKeyMap.get(table.name),
      })
    }

    let afterFingerprint
    try {
      afterFingerprint = await readSchemaFingerprint(fingerprintConnection)
    } catch (error) {
      if (error instanceof BackupPreflightError && error.code === 'backup_preflight_timeout') throw error
      throw new BackupPreflightError('backup_preflight_fingerprint_failed')
    }
    validateFingerprintTables(afterFingerprint, tables)
    if (beforeFingerprint?.sha256 !== afterFingerprint?.sha256) {
      throw new BackupPreflightError('backup_preflight_source_changed')
    }

    result = {
      version: 1,
      kind: 'v4_backup_database_observation',
      role,
      database,
      serverUuid,
      mysqlVersion,
      gtidMode: settings.gtidMode,
      logBin: settings.logBin,
      eventScheduler: settings.eventScheduler,
      observedAtUtc: new Date().toISOString(),
      schemaFingerprint: afterFingerprint,
      sourceObjects: objectCounts,
      tables: observedTables,
      totalRows: totalRows.toString(),
    }
  } catch (error) {
    operationError = sanitizeError(error)
  }

  if (transactionStarted && !connectionAborted) {
    try {
      await runRollback(connection)
    } catch {
      // Cleanup failure is itself a safety failure.  Do not return an
      // observation whose snapshot could not be closed deterministically.
      throw new BackupPreflightError('backup_preflight_rollback_failed')
    }
  }

  if (operationError) throw operationError
  return result
}

function validateConnection(connection) {
  if (!connection || typeof connection.query !== 'function' || typeof connection.destroy !== 'function') {
    throw new BackupPreflightError('backup_preflight_connection_invalid')
  }
}

function validateInspectionOptions({ database, expectedServerUuid, role, sourceDatabase, restoreDatabase, timeoutMs }) {
  validateIdentifier(database, 'backup_preflight_database_invalid')
  if (FORBIDDEN_DATABASES.has(database)) throw new BackupPreflightError('backup_preflight_database_forbidden')

  if (!['source', 'restored-source'].includes(role)) {
    throw new BackupPreflightError('backup_preflight_role_invalid')
  }

  if (sourceDatabase !== SOURCE_DATABASE) {
    throw new BackupPreflightError('backup_preflight_source_database_invalid')
  }
  validateIdentifier(sourceDatabase, 'backup_preflight_source_database_invalid')

  if (restoreDatabase !== undefined) {
    validateIdentifier(restoreDatabase, 'backup_preflight_restore_database_invalid')
    if (FORBIDDEN_DATABASES.has(restoreDatabase)) throw new BackupPreflightError('backup_preflight_restore_database_forbidden')
    if (restoreDatabase === sourceDatabase) throw new BackupPreflightError('backup_preflight_restore_database_is_source')
    if (!RESTORE_DATABASE_PATTERN.test(restoreDatabase)) {
      throw new BackupPreflightError('backup_preflight_restore_database_invalid')
    }
  }

  if (role === 'source') {
    if (database !== sourceDatabase) throw new BackupPreflightError('backup_preflight_source_database_mismatch')
  } else {
    if (restoreDatabase === undefined) throw new BackupPreflightError('backup_preflight_restore_database_required')
    if (database !== restoreDatabase) throw new BackupPreflightError('backup_preflight_restore_database_mismatch')
  }

  if (typeof expectedServerUuid !== 'string' || !UUID_PATTERN.test(expectedServerUuid)) {
    throw new BackupPreflightError('backup_preflight_expected_server_uuid_invalid')
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new BackupPreflightError('backup_preflight_timeout_invalid')
  }
}

function validateIdentifier(value, code) {
  if (typeof value !== 'string' || value.length > 64 || !IDENTIFIER_PATTERN.test(value)) {
    throw new BackupPreflightError(code)
  }
}

async function readIdentity(query) {
  const rows = await readRows(query, 'SELECT DATABASE() AS database_name,@@server_uuid AS server_uuid')
  if (rows.length !== 1) throw new BackupPreflightError('backup_preflight_identity_invalid')
  return rows[0]
}

function validateIdentity(identity, expectedDatabase, expectedServerUuid) {
  const selectedDatabase = identity?.database_name ?? identity?.db ?? identity?.database
  if (selectedDatabase !== expectedDatabase) {
    throw new BackupPreflightError('backup_preflight_database_mismatch')
  }
  const actualServerUuid = identity?.server_uuid
  if (typeof actualServerUuid !== 'string' || actualServerUuid.toLowerCase() !== expectedServerUuid.toLowerCase()) {
    throw new BackupPreflightError('backup_preflight_server_uuid_mismatch')
  }
  if (!UUID_PATTERN.test(actualServerUuid)) {
    throw new BackupPreflightError('backup_preflight_server_uuid_invalid')
  }
}

function normalizeUuid(value) {
  return typeof value === 'string' ? value.toLowerCase() : value
}

async function readAndValidateMysqlVersion(query) {
  const rows = await readRows(query, 'SELECT VERSION() AS mysql_version')
  if (rows.length !== 1 || typeof rows[0].mysql_version !== 'string') {
    throw new BackupPreflightError('backup_preflight_mysql_version_missing')
  }
  const match = rows[0].mysql_version.trim().match(MYSQL_84_PATTERN)
  if (!match) throw new BackupPreflightError('backup_preflight_mysql_version_unsupported')
  const numericVersion = rows[0].mysql_version.trim().match(/^8\.4\.\d+/i)
  return numericVersion?.[0] ?? match[0]
}

async function readOptionalServerSettings(query) {
  try {
    const rows = await readRows(query,
      'SELECT @@gtid_mode AS gtid_mode,@@log_bin AS log_bin,@@event_scheduler AS event_scheduler')
    if (rows.length !== 1) return { gtidMode: null, logBin: null, eventScheduler: null }
    return {
      gtidMode: normalizeSetting(rows[0].gtid_mode, ['OFF', 'OFF_PERMISSIVE', 'ON_PERMISSIVE', 'ON']),
      logBin: normalizeBoolean(rows[0].log_bin),
      eventScheduler: normalizeSetting(rows[0].event_scheduler, ['OFF', 'ON', 'DISABLED']),
    }
  } catch (error) {
    if (error instanceof BackupPreflightError && error.code === 'backup_preflight_timeout') throw error
    return { gtidMode: null, logBin: null, eventScheduler: null }
  }
}

function normalizeSetting(value, allowed) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return allowed.includes(normalized) ? normalized : null
}

function normalizeBoolean(value) {
  if (value === true || value === 1 || value === '1' || (typeof value === 'string' && value.trim().toUpperCase() === 'ON')) return true
  if (value === false || value === 0 || value === '0' || (typeof value === 'string' && ['OFF', 'DISABLED'].includes(value.trim().toUpperCase()))) return false
  return null
}

async function readTableMetadata(query, database) {
  return readRows(query, `SELECT TABLE_NAME AS table_name,TABLE_TYPE AS table_type,ENGINE AS engine
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [database])
}

function normalizeTableMetadata(rows) {
  if (!Array.isArray(rows)) throw new BackupPreflightError('backup_preflight_table_metadata_invalid')
  if (rows.length === 0) throw new BackupPreflightError('backup_preflight_no_tables')
  const names = new Set()
  const tables = []
  for (const row of rows) {
    const name = row?.table_name ?? row?.name
    validateMetadataIdentifier(name, 'backup_preflight_unknown_identifier')
    if (names.has(name)) throw new BackupPreflightError('backup_preflight_unknown_identifier')
    names.add(name)
    const type = row?.table_type ?? row?.type
    if (type === 'VIEW') throw new BackupPreflightError('backup_preflight_view_present')
    if (type !== 'BASE TABLE') throw new BackupPreflightError('backup_preflight_table_type_unknown')
    const engine = row?.engine ?? row?.ENGINE
    if (typeof engine !== 'string' || engine.toLowerCase() !== 'innodb') {
      throw new BackupPreflightError('backup_preflight_non_innodb_table')
    }
    tables.push({ name })
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name))
}

function validateFingerprintTables(fingerprint, tables) {
  if (!fingerprint || !Array.isArray(fingerprint.tables) || fingerprint.tableCount !== tables.length) {
    throw new BackupPreflightError('backup_preflight_source_changed')
  }
  const expectedNames = new Set(tables.map(table => table.name))
  const actualNames = new Set()
  for (const table of fingerprint.tables) {
    if (typeof table?.name !== 'string' || actualNames.has(table.name) || !expectedNames.has(table.name)) {
      throw new BackupPreflightError('backup_preflight_source_changed')
    }
    actualNames.add(table.name)
  }
  if (actualNames.size !== expectedNames.size) throw new BackupPreflightError('backup_preflight_source_changed')
}

async function readColumnMetadata(query, database) {
  return readRows(query, `SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type,
    IS_NULLABLE AS is_nullable,ORDINAL_POSITION AS ordinal_position,CHARACTER_SET_NAME AS character_set_name,
    COLLATION_NAME AS collation_name
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME,ORDINAL_POSITION`, [database])
}

function normalizeColumnMetadata(rows, tables) {
  if (!Array.isArray(rows)) throw new BackupPreflightError('backup_preflight_column_metadata_invalid')
  const tableNames = new Set(tables.map(table => table.name))
  const map = new Map(tables.map(table => [table.name, []]))
  const seen = new Set()
  for (const row of rows) {
    const tableName = row?.table_name
    const name = row?.column_name ?? row?.name
    validateMetadataIdentifier(tableName, 'backup_preflight_unknown_identifier')
    validateMetadataIdentifier(name, 'backup_preflight_unknown_identifier')
    if (!tableNames.has(tableName)) throw new BackupPreflightError('backup_preflight_unknown_identifier')
    const type = row?.column_type ?? row?.type
    if (typeof type !== 'string' || type.length === 0 || type.length > 1024 || /[\u0000-\u001f\u007f]/.test(type)) {
      throw new BackupPreflightError('backup_preflight_column_metadata_invalid')
    }
    const ordinal = normalizePositiveInteger(row?.ordinal_position ?? row?.ordinal)
    const nullable = row?.is_nullable ?? row?.nullable
    if (!['YES', 'NO'].includes(nullable)) throw new BackupPreflightError('backup_preflight_column_metadata_invalid')
    const charset = normalizeOptionalMetadataString(row?.character_set_name ?? row?.charset)
    const collation = normalizeOptionalMetadataString(row?.collation_name ?? row?.collation)
    const key = `${tableName}\u0000${name}`
    if (seen.has(key)) throw new BackupPreflightError('backup_preflight_unknown_identifier')
    seen.add(key)
    map.get(tableName).push({
      name,
      type,
      nullable,
      ordinal,
      charset,
      collation,
    })
  }

  for (const [tableName, columns] of map) {
    columns.sort((a, b) => a.ordinal - b.ordinal)
    for (let index = 0; index < columns.length; index++) {
      if (columns[index].ordinal !== index + 1) throw new BackupPreflightError('backup_preflight_column_metadata_invalid')
    }
    if (columns.length === 0) throw new BackupPreflightError('backup_preflight_columns_missing')
  }
  return map
}

async function readPrimaryKeyMetadata(query, database) {
  return readRows(query, `SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND INDEX_NAME = 'PRIMARY'
    ORDER BY TABLE_NAME,SEQ_IN_INDEX`, [database])
}

function normalizePrimaryKeyMetadata(rows, tables, columnMap) {
  if (!Array.isArray(rows)) throw new BackupPreflightError('backup_preflight_primary_key_metadata_invalid')
  const tableNames = new Set(tables.map(table => table.name))
  const statsMap = new Map(tables.map(table => [table.name, []]))
  for (const row of rows) {
    const tableName = row?.table_name
    const columnName = row?.column_name
    validateMetadataIdentifier(tableName, 'backup_preflight_unknown_identifier')
    validateMetadataIdentifier(columnName, 'backup_preflight_unknown_identifier')
    if (!tableNames.has(tableName) || !columnMap.get(tableName)?.some(column => column.name === columnName)) {
      throw new BackupPreflightError('backup_preflight_unknown_identifier')
    }
    const sequence = normalizePositiveInteger(row?.seq_in_index ?? row?.sequence_in_index)
    statsMap.get(tableName).push({ columnName, sequence })
  }

  const result = new Map()
  for (const table of tables) {
    const stats = statsMap.get(table.name)
    if (stats.length === 0) throw new BackupPreflightError('backup_preflight_primary_key_missing')
    stats.sort((a, b) => a.sequence - b.sequence)
    const keyNames = new Set()
    for (let index = 0; index < stats.length; index++) {
      if (stats[index].sequence !== index + 1 || keyNames.has(stats[index].columnName)) {
        throw new BackupPreflightError('backup_preflight_primary_key_metadata_invalid')
      }
      keyNames.add(stats[index].columnName)
    }
    const primaryKey = stats.map(item => item.columnName)
    result.set(table.name, primaryKey)
  }
  return result
}

function normalizePositiveInteger(value) {
  if (typeof value === 'bigint') {
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new BackupPreflightError('backup_preflight_metadata_count_invalid')
    return Number(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const integer = BigInt(value)
    if (integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new BackupPreflightError('backup_preflight_metadata_count_invalid')
    return Number(integer)
  }
  throw new BackupPreflightError('backup_preflight_metadata_count_invalid')
}

function normalizeOptionalMetadataString(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BackupPreflightError('backup_preflight_column_metadata_invalid')
  }
  return value
}

async function readSourceObjectCounts(query, database) {
  // mysql2 connections are stateful; keep all metadata reads serialized so a
  // single transaction never has concurrent commands racing on the socket.
  const triggers = await readCount(query,
    `SELECT COUNT(*) AS object_count FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`, [database])
  const routines = await readCount(query,
    `SELECT COUNT(*) AS object_count FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`, [database])
  const events = await readCount(query,
    `SELECT COUNT(*) AS object_count FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`, [database])
  const toSafeNumber = count => {
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new BackupPreflightError('backup_preflight_object_count_invalid')
    return Number(count)
  }
  return { triggers: toSafeNumber(triggers), routines: toSafeNumber(routines), events: toSafeNumber(events) }
}

async function readTableCount(query, database, tableName) {
  validateMetadataIdentifier(tableName, 'backup_preflight_unknown_identifier')
  return readCount(query, `SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(database)}.${quoteIdentifier(tableName)}`)
}

async function readCount(query, sql, params) {
  const rows = await readRows(query, sql, params)
  if (rows.length !== 1) throw new BackupPreflightError('backup_preflight_count_invalid')
  const value = rows[0].row_count ?? rows[0].object_count ?? rows[0].count ?? rows[0].cnt
  try {
    if (typeof value === 'bigint') {
      if (value < 0n) throw new Error('negative')
      return value
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('number')
      return BigInt(value)
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  } catch {
    throw new BackupPreflightError('backup_preflight_count_invalid')
  }
  throw new BackupPreflightError('backup_preflight_count_invalid')
}

function validateMetadataIdentifier(value, code) {
  if (typeof value !== 'string' || value.length > 64 || !IDENTIFIER_PATTERN.test(value)) {
    throw new BackupPreflightError(code)
  }
}

function quoteIdentifier(value) {
  validateMetadataIdentifier(value, 'backup_preflight_unknown_identifier')
  return `\`${value}\``
}

async function readRows(query, sql, params) {
  const result = await query(sql, params)
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
  if (Array.isArray(result)) return result
  throw new BackupPreflightError('backup_preflight_query_result_invalid')
}

function createBoundedQuery(connection, deadline, onAbort) {
  return async function boundedQuery(sql, params) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      onAbort?.()
      destroyConnection(connection)
      throw new BackupPreflightError('backup_preflight_timeout')
    }
    let timer
    let timedOut = false
    try {
      return await Promise.race([
        Promise.resolve().then(() => params === undefined ? connection.query(sql) : connection.query(sql, params)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            onAbort?.()
            destroyConnection(connection)
            reject(new BackupPreflightError('backup_preflight_timeout'))
          }, remaining)
        }),
      ])
    } catch (error) {
      if (timedOut) throw new BackupPreflightError('backup_preflight_timeout')
      throw sanitizeError(error)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

async function runRollback(connection) {
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(() => connection.query('ROLLBACK')),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          destroyConnection(connection)
          reject(new BackupPreflightError('backup_preflight_rollback_failed'))
        }, ROLLBACK_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    destroyConnection(connection)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function destroyConnection(connection) {
  try {
    const result = connection.destroy?.()
    if (result && typeof result.catch === 'function') result.catch(() => undefined)
  } catch {
    // Destruction is best effort; the public error remains the bounded,
    // detail-free timeout/rollback code.
  }
}

function sanitizeError(error) {
  if (error instanceof BackupPreflightError) return error
  return new BackupPreflightError('backup_preflight_query_failed')
}
