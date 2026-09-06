import { BackfillError, canonical, exactKeys, hash, primaryKey, requireBackfill as check } from './v4-backfill-contract.mjs'
import { readConnectionIdentity, readMigrationStructure, safeIdentifier, validateSourceBinding } from './v4-backfill-preflight.mjs'

const PAGE_BYTES = 2 * 1024 * 1024
const INTEGER = /^(?:tinyint|smallint|mediumint|int|bigint)(?:\(\d+\))?(?: unsigned)?$/i
const TEXT = /^(?:varchar|char)\(\d+\)$/i
const BINARY = /^(?:varbinary|binary)\(\d+\)$/i

export async function readTableMetadata(connection, table) {
  safeIdentifier(table)
  const [columns] = await connection.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,CHARACTER_SET_NAME charset_name,COLLATION_NAME collation_name,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
  const [indexes] = await connection.execute("SELECT COLUMN_NAME name,SEQ_IN_INDEX position,SUB_PART prefix_length,COLLATION direction FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [table])
  check(columns.length > 0 && columns.length <= 128 && indexes.length > 0 && indexes.length <= 8, 'backfill_source_table_unsupported')
  for (const column of columns) {
    safeIdentifier(column.name)
    check(!/^(?:float|double|real|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i.test(column.type), 'backfill_source_type_requires_special_reader')
  }
  const pk = indexes.map((index, i) => {
    const column = columns.find(c => c.name === index.name)
    check(column && column.nullable === 'NO' && Number(index.position) === i + 1 && index.prefix_length === null && index.direction === 'A', 'backfill_source_pk_unsupported')
    const kind = INTEGER.test(column.type) ? 'integer' : TEXT.test(column.type) ? 'text' : BINARY.test(column.type) ? 'binary' : null
    check(kind && (kind !== 'text' || ['utf8mb4', 'utf8mb3', 'utf8', 'ascii'].includes(column.charset_name)), 'backfill_source_pk_unsupported')
    if (kind === 'text') safeIdentifier(column.collation_name)
    return { ...column, kind }
  })
  return { table, columns, pk, fingerprint: hash({ table, columns, indexes }) }
}

function operand(column, value, params) {
  check(value.type === column.kind, 'backfill_cursor_type_mismatch')
  if (column.kind === 'integer') {
    const base = /^(tinyint|smallint|mediumint|int|bigint)/i.exec(column.type)?.[1].toLowerCase()
    const bits = BigInt({ tinyint: 8, smallint: 16, mediumint: 24, int: 32, bigint: 64 }[base])
    const unsigned = /unsigned/i.test(column.type), n = BigInt(value.value)
    check(n >= (unsigned ? 0n : -(2n ** (bits - 1n))) && n <= (unsigned ? 2n ** bits - 1n : 2n ** (bits - 1n) - 1n), 'backfill_cursor_integer_out_of_range')
  }
  if (column.kind === 'text') {
    check([...value.value].length <= Number(/\((\d+)\)/.exec(column.type)[1]), 'backfill_cursor_text_too_long')
    check(column.charset_name !== 'ascii' || /^[\x00-\x7f]*$/.test(value.value), 'backfill_cursor_encoding_invalid')
    check(!['utf8mb3', 'utf8'].includes(column.charset_name) || ![...value.value].some(c => c.codePointAt(0) > 0xffff), 'backfill_cursor_encoding_invalid')
  }
  params.push(value.value)
  if (column.kind === 'integer') return /unsigned/i.test(column.type) ? 'CAST(? AS UNSIGNED)' : 'CAST(? AS SIGNED)'
  if (column.kind === 'binary') return 'UNHEX(?)'
  return `CONVERT(? USING ${column.charset_name}) COLLATE ${column.collation_name}`
}
export function sourcePageQuery(metadata, cursorPk, limit) {
  check(Number.isInteger(limit) && limit >= 1 && limit <= 500, 'backfill_page_limit_invalid')
  if (cursorPk !== null) { primaryKey(cursorPk); check(cursorPk.length === metadata.pk.length, 'backfill_cursor_shape_mismatch') }
  const params = [], perRowBytes = Math.floor(PAGE_BYTES / limit)
  const total = metadata.columns.map(c => `COALESCE(OCTET_LENGTH(CAST(${safeIdentifier(c.name)} AS BINARY)),0)`).join('+')
  const columns = metadata.columns.map((c, i) => {
    params.push(perRowBytes)
    return `CASE WHEN (${total})<=? THEN HEX(CAST(${safeIdentifier(c.name)} AS BINARY)) ELSE NULL END AS c${i}`
  })
  let where = ''
  if (cursorPk !== null) where = ' WHERE ' + metadata.pk.map((column, i) => '(' + metadata.pk.slice(0, i + 1).map((part, j) => safeIdentifier(part.name) + (j === i ? '>' : '=') + operand(part, cursorPk[j], params)).join(' AND ') + ')').join(' OR ')
  // mysql2 sends JS numbers as DOUBLE; MySQL 8.4 rejects that type for LIMIT.
  // Keep a bound parameter, using the already-validated integer as decimal text.
  params.push(String(limit))
  const sql = `SELECT CAST((${total}) AS CHAR) AS byte_size,${columns.join(',')} FROM ${safeIdentifier(metadata.table)}${where} ORDER BY ${metadata.pk.map(c => safeIdentifier(c.name) + ' ASC').join(',')} LIMIT ?`
  check(Buffer.byteLength(sql) <= 256 * 1024, 'backfill_source_query_too_large')
  return { sql, params, perRowBytes }
}

function decodeRow(metadata, row, perRowBytes) {
  check(typeof row.byte_size === 'string' && /^\d+$/.test(row.byte_size), 'backfill_source_length_invalid')
  check(BigInt(row.byte_size) <= BigInt(perRowBytes), 'backfill_source_row_requires_smaller_page')
  const cells = metadata.columns.map((column, i) => {
    const hex = row['c' + i]
    check(hex === null || (typeof hex === 'string' && /^(?:[a-fA-F0-9]{2})*$/.test(hex)), 'backfill_source_hex_invalid')
    return { column: column.name, type: column.type, charset: column.charset_name, valueHex: hex === null ? null : hex.toLowerCase() }
  })
  check(cells.reduce((n, c) => n + BigInt((c.valueHex?.length ?? 0) / 2), 0n) === BigInt(row.byte_size), 'backfill_source_length_mismatch')
  const pk = metadata.pk.map(column => {
    const hex = cells.find(c => c.column === column.name).valueHex
    check(hex !== null, 'backfill_source_pk_null')
    if (column.kind === 'binary') return { type: 'binary', value: hex }
    const bytes = Buffer.from(hex, 'hex'), value = bytes.toString('utf8')
    check(Buffer.from(value, 'utf8').equals(bytes), 'backfill_source_pk_encoding_invalid')
    return { type: column.kind, value }
  })
  primaryKey(pk)
  const envelope = { encoding: 'mysql-sql-value-hex-v1', table: metadata.table, cells }
  return { pk, sourceHash: hash(envelope), envelope }
}

export async function openBackfillSourceReader(connection, source, table, expectedTableHash) {
  source = structuredClone(source)
  validateSourceBinding(source); safeIdentifier(table)
  check(typeof expectedTableHash === 'string' && /^[a-f0-9]{64}$/.test(expectedTableHash), 'backfill_source_table_hash_invalid')
  let closed = false, busy = false, pages = 0, totalBytes = 0
  const close = async () => {
    if (!closed) {
      closed = true
      try { await connection.rollback() }
      catch { connection.destroy(); throw new BackfillError('backfill_source_rollback_failed') }
    }
  }
  try {
    await connection.query("SET SESSION time_zone='+00:00'")
    await connection.query('SET SESSION max_execution_time=10000')
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    const identity = await readConnectionIdentity(connection)
    check(identity.database === source.database && identity.serverUuid === source.serverUuid, 'backfill_source_identity_mismatch')
    const structure = await readMigrationStructure(connection)
    check(structure.sha256 === source.structureHash, 'backfill_source_structure_drift')
    const metadata = await readTableMetadata(connection, table)
    check(metadata.fingerprint === expectedTableHash, 'backfill_source_table_drift')
    const bindingHash = hash({ source, table, expectedTableHash })
    return {
      bindingHash,
      async readPage(cursor = null, limit = 100) {
        check(!closed && !busy, 'backfill_reader_unavailable')
        busy = true
        try {
          cursor = structuredClone(cursor)
          check(pages < 1000 && totalBytes < 64 * 1024 * 1024, 'backfill_reader_budget_exhausted')
          if (cursor !== null) {
            exactKeys(cursor, ['version', 'bindingHash', 'pk'])
            check(cursor.version === 1 && cursor.bindingHash === bindingHash, 'backfill_cursor_binding_mismatch')
          }
          const query = sourcePageQuery(metadata, cursor?.pk ?? null, limit)
          const [raw] = await connection.execute(query.sql, query.params)
          check(raw.length <= limit, 'backfill_source_page_overflow')
          const rows = raw.map(row => decodeRow(metadata, row, query.perRowBytes))
          check(new Set(rows.map(row => hash(row.pk))).size === rows.length && !rows.some(row => cursor && canonical(row.pk) === canonical(cursor.pk)), 'backfill_source_page_not_advancing')
          const bytes = Buffer.byteLength(canonical(rows))
          check(bytes <= PAGE_BYTES, 'backfill_source_page_too_large')
          check(totalBytes + bytes <= 64 * 1024 * 1024, 'backfill_reader_budget_exhausted')
          pages++; totalBytes += bytes
          return { rows, nextCursor: rows.length ? { version: 1, bindingHash, pk: rows.at(-1).pk } : cursor,
            exhausted: rows.length < limit, snapshotContentVerified: false, readyForBackfill: false }
        } catch (error) {
          if (error instanceof BackfillError && ['backfill_source_row_requires_smaller_page', 'backfill_source_page_too_large'].includes(error.code)) throw error
          await close().catch(() => {})
          throw error instanceof BackfillError ? error : new BackfillError('backfill_source_read_failed')
        } finally { busy = false }
      },
      async close() { check(!busy, 'backfill_reader_busy'); await close() },
    }
  } catch (error) {
    await close().catch(() => {})
    throw error instanceof BackfillError ? error : new BackfillError('backfill_source_open_failed')
  }
}
