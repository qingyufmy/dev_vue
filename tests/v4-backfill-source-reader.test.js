import { describe, expect, it, vi } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { inspectBackfillWave, migrationStructureFingerprint } from '../scripts/lib/v4-backfill-preflight.mjs'
import { openBackfillSourceReader, readTableMetadata, sourcePageQuery } from '../scripts/lib/v4-backfill-source-reader.mjs'
import { readBackfillTargetIdentity } from '../scripts/lib/v4-backfill-mysql-repository.mjs'

const uuid = '22222222-2222-2222-2222-222222222222'
const schema = { charset_name: 'utf8mb4', collation_name: 'utf8mb4_bin' }
const ddl = "CREATE TABLE `samples` (\n  `id` bigint NOT NULL,\n  `tag` varchar(20) COLLATE utf8mb4_bin NOT NULL,\n  `value` text,\n  PRIMARY KEY (`id`,`tag`)\n) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin"
const columns = [
  { name: 'id', type: 'bigint', nullable: 'NO', charset_name: null, collation_name: null, extra: '' },
  { name: 'tag', type: 'varchar(20)', nullable: 'NO', charset_name: 'utf8mb4', collation_name: 'utf8mb4_bin', extra: '' },
  { name: 'value', type: 'text', nullable: 'YES', charset_name: 'utf8mb4', collation_name: 'utf8mb4_bin', extra: '' },
]
const indexes = [{ name: 'id', position: 1, prefix_length: null, direction: 'A' }, { name: 'tag', position: 2, prefix_length: null, direction: 'A' }]
const structuralHash = migrationStructureFingerprint(schema, [{ name: 'samples', ddl }]).sha256
const source = () => ({ serverUuid: uuid, database: 'frozen', originalDatabase: 'original', snapshotHash: 'a'.repeat(64), structureHash: structuralHash })
const tableHash = hash({ table: 'samples', columns, indexes })
const hex = v => v === null ? null : Buffer.from(v).toString('hex')
const row = (id, tag, value) => ({ byte_size: String([id, tag, value].reduce((n, v) => n + (v === null ? 0 : Buffer.byteLength(v)), 0)), c0: hex(id), c1: hex(tag), c2: hex(value) })
function fixture(database = 'frozen') {
  const f = { database, ddl, engine: 'InnoDB', columns: structuredClone(columns), indexes: structuredClone(indexes), pages: [], objects: 0 }
  f.connection = {
    query: vi.fn(async sql => {
      if (sql.startsWith('SELECT DATABASE()')) return [[{ db: f.database, server_uuid: uuid }]]
      if (sql.includes('FROM information_schema.SCHEMATA')) return [[schema]]
      if (sql.includes('FROM information_schema.TABLES')) return [[{ table_name: 'samples', table_type: 'BASE TABLE', engine: f.engine }]]
      if (sql.startsWith('SHOW CREATE TABLE')) return [[{ 'Create Table': f.ddl }]]
      if (sql.includes('COUNT(*) AS object_count')) return [[{ object_count: f.objects }]]
      if (sql.includes('FROM schema_migrations')) return [[{ id: '025', checksum_sha256: 'x', status: 'completed', statement_count: 5, completed_statements: 5 }]]
      if (sql.includes('FROM schema_migration_events')) return [[]]
      if (/^(SET |START TRANSACTION)/.test(sql)) return [[]]
      throw new Error('unexpected query')
    }),
    execute: vi.fn(async sql => {
      if (sql.includes('FROM information_schema.COLUMNS')) return [f.columns]
      if (sql.includes('FROM information_schema.STATISTICS')) return [f.indexes]
      if (sql.startsWith('SELECT CAST(')) return [f.pages.shift() ?? []]
      throw new Error('unexpected execute')
    }), rollback: vi.fn(), destroy: vi.fn(),
  }
  return f
}

describe('stable read-only source pages', () => {
  it('rejects engines without the supported consistent-snapshot guarantee', async () => {
    const f = fixture(); f.engine = 'MyISAM'
    await expect(openBackfillSourceReader(f.connection, source(), 'samples', tableHash)).rejects.toThrow('backfill_nontransactional_engine_unsupported')
    expect(f.connection.rollback).toHaveBeenCalledOnce()
  })
  it('rejects concurrent reads and close, then sanitizes a failed data query', async () => {
    const f = fixture()
    const reader = await openBackfillSourceReader(f.connection, source(), 'samples', tableHash)
    let fail
    f.connection.execute.mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject }))
    const pending = reader.readPage()
    await expect(reader.readPage()).rejects.toThrow('backfill_reader_unavailable')
    await expect(reader.close()).rejects.toThrow('backfill_reader_busy')
    fail(new Error('secret server details'))
    await expect(pending).rejects.toThrow('backfill_source_read_failed')
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    await expect(reader.readPage()).rejects.toThrow('backfill_reader_unavailable')
  })
  it('preserves NULL, empty text, exact decimals and datetime wall-clock bytes', async () => {
    const f = fixture()
    f.pages.push([row('9007199254740993', '甲', null), row('9007199254740994', '乙', ''), row('9007199254740995', '丙', '2026-09-06 08:00:00.123|1234567890.00000001')])
    const reader = await openBackfillSourceReader(f.connection, source(), 'samples', tableHash)
    const page = await reader.readPage(null, 4)
    expect(page.rows[0].pk[0].value).toBe('9007199254740993')
    expect(page.rows[0].envelope.cells[2].valueHex).toBeNull()
    expect(page.rows[1].envelope.cells[2].valueHex).toBe('')
    expect(Buffer.from(page.rows[2].envelope.cells[2].valueHex, 'hex').toString()).toBe('2026-09-06 08:00:00.123|1234567890.00000001')
    expect(page.rows[0].sourceHash).toBe(hash(page.rows[0].envelope))
    expect(page.exhausted).toBe(true); expect(page.snapshotContentVerified).toBe(false)
    expect(f.connection.query.mock.calls.map(([sql]) => sql)).toContain('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    await reader.close(); await reader.close()
    expect(f.connection.rollback).toHaveBeenCalledOnce()
  })
  it('uses lexicographic composite PK predicates, explicit SQL collation and bound values', async () => {
    const f = fixture(), metadata = await readTableMetadata(f.connection, 'samples')
    const cursor = [{ type: 'integer', value: '9007199254740993' }, { type: 'text', value: "x' OR 1=1" }]
    const q = sourcePageQuery(metadata, cursor, 10)
    expect(q.sql).toContain('(`id`>CAST(? AS SIGNED)) OR (`id`=CAST(? AS SIGNED) AND `tag`>CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin)')
    expect(q.sql).toContain('ORDER BY `id` ASC,`tag` ASC LIMIT ?')
    expect(q.sql).not.toMatch(/OFFSET|9007199254740993|OR 1=1/)
    expect(q.params.slice(-4)).toEqual(['9007199254740993', '9007199254740993', "x' OR 1=1", 10])
  })
  it('binds cursors to source/snapshot/table metadata and closes on mismatch', async () => {
    const f = fixture(); f.pages.push([row('1', 'a', 'data')])
    const reader = await openBackfillSourceReader(f.connection, source(), 'samples', tableHash)
    const page = await reader.readPage(null, 1)
    expect(page.exhausted).toBe(false)
    page.nextCursor.bindingHash = 'f'.repeat(64)
    await expect(reader.readPage(page.nextCursor)).rejects.toMatchObject({ code: 'backfill_cursor_binding_mismatch' })
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    await expect(reader.readPage()).rejects.toMatchObject({ code: 'backfill_reader_unavailable' })
  })
  it('returns a stable terminal empty page without manufacturing a new cursor', async () => {
    const f = fixture(); f.pages.push([row('1', 'a', 'data')], [])
    const reader = await openBackfillSourceReader(f.connection, source(), 'samples', tableHash)
    const first = await reader.readPage(null, 1), last = await reader.readPage(first.nextCursor, 1)
    expect(last.rows).toEqual([]); expect(last.exhausted).toBe(true); expect(last.nextCursor).toEqual(first.nextCursor)
    await reader.close()
  })
  it('rejects row truncation and duplicates before emitting a usable page', async () => {
    for (const mode of ['length', 'duplicate']) {
      const f = fixture(), data = row('1', 'a', 'data')
      if (mode === 'length') data.byte_size = '100'
      f.pages.push(mode === 'duplicate' ? [data, data] : [data])
      const reader = await openBackfillSourceReader(f.connection, source(), 'samples', tableHash)
      await expect(reader.readPage()).rejects.toMatchObject({ code: mode === 'length' ? 'backfill_source_length_mismatch' : 'backfill_source_page_not_advancing' })
      expect(f.connection.rollback).toHaveBeenCalledOnce()
    }
  })
  it('bounds each SQL result and permits a smaller-page retry without advancing', async () => {
    const f = fixture()
    f.pages.push([{ byte_size: '100000', c0: null, c1: null, c2: null }], [row('1', 'a', 'data')])
    const reader = await openBackfillSourceReader(f.connection, source(), 'samples', tableHash)
    await expect(reader.readPage(null, 100)).rejects.toMatchObject({ code: 'backfill_source_row_requires_smaller_page' })
    expect(f.connection.rollback).not.toHaveBeenCalled()
    expect((await reader.readPage(null, 1)).rows).toHaveLength(1)
    await reader.close()
  })
  it('rejects unsupported float/no-PK/prefix/descending tables', async () => {
    for (const mode of ['float', 'missing', 'prefix', 'descending']) {
      const f = fixture()
      if (mode === 'float') f.columns[2].type = 'double'
      if (mode === 'missing') f.indexes = []
      if (mode === 'prefix') f.indexes[1].prefix_length = 3
      if (mode === 'descending') f.indexes[1].direction = 'D'
      await expect(openBackfillSourceReader(f.connection, source(), 'samples', tableHash)).rejects.toThrow()
      expect(f.connection.rollback).toHaveBeenCalledOnce()
    }
  })
  it('rejects metadata or database identity drift and destroys a failed rollback connection', async () => {
    const f = fixture('wrong')
    f.connection.rollback.mockRejectedValue(new Error('secret connection detail'))
    await expect(openBackfillSourceReader(f.connection, source(), 'samples', tableHash)).rejects.toMatchObject({ code: 'backfill_source_identity_mismatch' })
    expect(f.connection.destroy).toHaveBeenCalledOnce()
    const g = fixture(); g.columns[2].nullable = 'NO'
    await expect(openBackfillSourceReader(g.connection, source(), 'samples', tableHash)).rejects.toMatchObject({ code: 'backfill_source_table_drift' })
  })
  it('rejects unrepresentable cursors and SQL identifiers before issuing a data query', async () => {
    const f = fixture(), m = await readTableMetadata(f.connection, 'samples')
    expect(() => sourcePageQuery(m, [{ type: 'integer', value: '9223372036854775808' }, { type: 'text', value: 'a' }], 1)).toThrow('backfill_cursor_integer_out_of_range')
    await expect(openBackfillSourceReader(f.connection, source(), 'samples;DROP', tableHash)).rejects.toThrow('backfill_identifier_invalid')
    expect(() => sourcePageQuery(m, null, 501)).toThrow('backfill_page_limit_invalid')
  })
})

describe('actual structure preflight without enabling backfill', () => {
  it('ignores only table-level auto-increment counters, never column default text', () => {
    const fingerprint = sql => migrationStructureFingerprint(schema, [{ name: 'samples', ddl: sql }]).sha256
    expect(fingerprint(ddl)).toBe(fingerprint(ddl.replace('AUTO_INCREMENT=4', 'AUTO_INCREMENT=900')))
    expect(fingerprint(ddl)).not.toBe(fingerprint(ddl.replace('bigint', 'int')))
    const literal = ddl.replace('`value` text', "`value` varchar(30) DEFAULT 'AUTO_INCREMENT=4'")
    expect(fingerprint(literal)).not.toBe(fingerprint(literal.replace("'AUTO_INCREMENT=4'", "'AUTO_INCREMENT=5'")))
  })
  it('reports schema drift even when migration journal is unchanged, never upgrades admission', async () => {
    const s = fixture(), t = fixture('target')
    const identity = await readBackfillTargetIdentity(t.connection)
    const request = { source: source(), target: { serverUuid: uuid, database: 'target', structureHash: structuralHash, journalHash: identity.schemaHash }, wave: { manifestHash: 'c'.repeat(64), executable: false, blockers: ['G-TIME'] } }
    const first = await inspectBackfillWave(s.connection, t.connection, request)
    expect(first.readyForBackfill).toBe(false)
    expect(first.blockers).toContain('source:content_seal_not_verified')
    expect(first.blockers).toContain('wave:not_executable')
    t.ddl = ddl.replace('bigint', 'int')
    const changed = await inspectBackfillWave(s.connection, t.connection, request)
    expect(changed.blockers).toContain('target:structure_drift')
    expect(changed.blockers).not.toContain('target:journal_drift')
    t.objects = 1
    expect((await inspectBackfillWave(s.connection, t.connection, request)).blockers).toContain('target:backfill_executable_schema_objects_present')
  })
})
