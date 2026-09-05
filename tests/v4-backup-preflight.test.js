import { describe, expect, it } from 'vitest'
import { BackupPreflightError, inspectBackupDatabase } from '../scripts/lib/v4-backup-preflight.mjs'

const serverUuid = '00000000-0000-0000-0000-000000000001'
const restoreDatabase = 'dev_vue_m1_source_20260905_01'

function fixture(overrides = {}) {
  return {
    database: 'dev_vue',
    serverUuid,
    version: '8.4.8',
    tables: [{ table_name: 'users', table_type: 'BASE TABLE', engine: 'InnoDB' }],
    columns: [
      { table_name: 'users', column_name: 'id', column_type: 'bigint unsigned', is_nullable: 'NO', ordinal_position: 1, character_set_name: null, collation_name: null, column_key: 'PRI' },
      { table_name: 'users', column_name: 'email', column_type: 'varchar(255)', is_nullable: 'NO', ordinal_position: 2, character_set_name: 'utf8mb4', collation_name: 'utf8mb4_bin', column_key: '' },
    ],
    primary: [{ table_name: 'users', column_name: 'id', seq_in_index: 1 }],
    counts: { users: '9007199254740993' },
    objects: { triggers: '0', routines: '0', events: '0' },
    schema: { charset_name: 'utf8mb4', collation_name: 'utf8mb4_unicode_ci' },
    ddl: { users: 'CREATE TABLE users (id bigint unsigned NOT NULL PRIMARY KEY, email varchar(255) NOT NULL) ENGINE=InnoDB' },
    failRollback: false,
    hangOn: null,
    destroyCalls: 0,
    calls: [],
    ...overrides,
  }
}

function fakeConnection(state) {
  return {
    calls: state.calls,
    async query(sql, params) {
      state.calls.push({ sql, params })
      const normalized = sql.replace(/\s+/g, ' ').trim()
      const upper = normalized.toUpperCase()
      if (state.hangOn && state.hangOn.test(normalized)) return new Promise(() => {})
      if (/^(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE|RENAME|GRANT|REVOKE|SET\s+GLOBAL|FLUSH|CALL)\b/.test(upper)) {
        throw new Error('write_or_global_sql_forbidden')
      }
      if (upper === 'ROLLBACK') {
        if (state.failRollback) throw new Error('rollback driver detail must stay private')
        return [{ affectedRows: 0 }]
      }
      if (upper.startsWith('SET SESSION') || upper.startsWith('START TRANSACTION')) return [{ affectedRows: 0 }]
      if (normalized.includes('FROM information_schema.SCHEMATA')) return [[state.schema]]
      if (normalized.includes('VERSION()')) return [[{ mysql_version: state.version }]]
      if (normalized.includes('@@gtid_mode')) return [[{ gtid_mode: 'ON', log_bin: 1, event_scheduler: 'OFF' }]]
      if (normalized.includes('FROM information_schema.TABLES')) {
        if (normalized.includes('TABLE_NAME table_name')) {
          return [[...state.tables].map(table => ({ table_name: table.table_name, table_type: table.table_type }))]
        }
        return [[...state.tables]]
      }
      if (normalized.includes('FROM information_schema.COLUMNS')) return [[...state.columns]]
      if (normalized.includes('FROM information_schema.STATISTICS')) return [[...state.primary]]
      if (normalized.includes('FROM information_schema.TRIGGERS')) return [[{ object_count: state.objects.triggers }]]
      if (normalized.includes('FROM information_schema.ROUTINES')) return [[{ object_count: state.objects.routines }]]
      if (normalized.includes('FROM information_schema.EVENTS')) return [[{ object_count: state.objects.events }]]
      if (normalized.includes('DATABASE()')) return [[{ database_name: state.database, server_uuid: state.serverUuid }]]
      if (upper.startsWith('SHOW CREATE TABLE')) {
        const name = normalized.match(/SHOW CREATE TABLE `([^`]+)`/)?.[1]
        return [[{ 'Create Table': state.ddl[name] }]]
      }
      if (upper.startsWith('SELECT COUNT(*) AS ROW_COUNT FROM')) {
        const name = normalized.match(/FROM `[^`]+`\.`([^`]+)`/)?.[1]
        return [[{ row_count: state.counts[name] ?? '0' }]]
      }
      throw new Error(`unexpected query ${normalized}`)
    },
    destroy() {
      state.destroyCalls += 1
    },
  }
}

async function inspect(state, options = {}) {
  const connection = fakeConnection(state)
  const result = await inspectBackupDatabase(connection, {
    database: state.database,
    expectedServerUuid: state.serverUuid,
    role: state.database === 'dev_vue' ? 'source' : 'restored-source',
    sourceDatabase: 'dev_vue',
    restoreDatabase: state.database === 'dev_vue' ? undefined : state.database,
    ...options,
  })
  return { result, connection }
}

function expectCode(action, code) {
  return expect(action).rejects.toMatchObject({ name: 'BackupPreflightError', code, message: code })
}

describe('V4 backup source/restore read-only preflight', () => {
  it('returns precise metadata and BigInt counts without row payloads', async () => {
    const state = fixture()
    const { result, connection } = await inspect(state)
    expect(result).toMatchObject({
      version: 1,
      kind: 'v4_backup_database_observation',
      role: 'source',
      database: 'dev_vue',
      serverUuid,
      mysqlVersion: '8.4.8',
      gtidMode: 'ON',
      logBin: true,
      eventScheduler: 'OFF',
      sourceObjects: { triggers: 0, routines: 0, events: 0 },
      totalRows: '9007199254740993',
    })
    expect(result.observedAtUtc).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(result.tables).toEqual([{
      name: 'users',
      rowCount: '9007199254740993',
      columns: [
        { name: 'id', type: 'bigint unsigned', nullable: 'NO', ordinal: 1, charset: null, collation: null },
        { name: 'email', type: 'varchar(255)', nullable: 'NO', ordinal: 2, charset: 'utf8mb4', collation: 'utf8mb4_bin' },
      ],
      primaryKey: ['id'],
    }])
    expect(JSON.stringify(result)).not.toContain('CREATE TABLE')
    expect(JSON.stringify(result)).not.toContain('row-payload')
    const directSql = connection.calls.map(call => call.sql).filter(sql => !/^\s*SHOW CREATE TABLE/i.test(sql)).join('\n')
    expect(directSql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|SET\s+GLOBAL|FLUSH)\b/im)
    expect(connection.calls.at(-1).sql).toBe('ROLLBACK')
    const isolationIndex = connection.calls.findIndex(call => /SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ/i.test(call.sql))
    const startIndex = connection.calls.findIndex(call => /START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY/i.test(call.sql))
    expect(isolationIndex).toBeGreaterThan(-1)
    expect(isolationIndex).toBeLessThan(startIndex)
    expect(connection.calls.filter(call => /SELECT COUNT\(\*\) AS row_count/i.test(call.sql))).toHaveLength(1)
  })

  it('validates identity and target names before table inspection', async () => {
    const wrongServer = fixture({ serverUuid: '00000000-0000-0000-0000-000000000002' })
    await expectCode(inspect(wrongServer, { expectedServerUuid: serverUuid }), 'backup_preflight_server_uuid_mismatch')
    expect(wrongServer.calls).toHaveLength(1)

    const wrongName = fixture({ database: 'dev_vue_m1_source_20260905_01' })
    await expectCode(inspect(wrongName, { role: 'source', restoreDatabase: undefined }), 'backup_preflight_source_database_mismatch')
    expect(wrongName.calls).toHaveLength(0)

    const sourceAsRestore = fixture({ database: 'dev_vue' })
    await expectCode(inspect(sourceAsRestore, { role: 'restored-source', restoreDatabase: 'dev_vue' }), 'backup_preflight_restore_database_is_source')
    expect(sourceAsRestore.calls).toHaveLength(0)

    const aDatabase = fixture({ database: 'dev_vue_a' })
    await expectCode(inspect(aDatabase, { role: 'source' }), 'backup_preflight_database_forbidden')
    expect(aDatabase.calls).toHaveLength(0)
  })

  it('rejects views, non-InnoDB tables, active objects and missing primary keys', async () => {
    const view = fixture({ tables: [{ table_name: 'users', table_type: 'VIEW', engine: null }] })
    await expectCode(inspect(view), 'backup_preflight_view_present')

    const nonInnoDb = fixture({ tables: [{ table_name: 'users', table_type: 'BASE TABLE', engine: 'MyISAM' }] })
    await expectCode(inspect(nonInnoDb), 'backup_preflight_non_innodb_table')

    const active = fixture({ objects: { triggers: '1', routines: '0', events: '0' } })
    await expectCode(inspect(active), 'backup_preflight_active_objects_present')

    // COLUMN_KEY=PRI is deliberately retained: it must not mask missing STATISTICS.
    const noPrimary = fixture({ primary: [] })
    await expectCode(inspect(noPrimary), 'backup_preflight_primary_key_missing')
    await expectCode(inspect(fixture({ tables: [] })), 'backup_preflight_no_tables')
  })

  it('bounds table inventory and detects fingerprint drift', async () => {
    const tooMany = fixture({ tables: Array.from({ length: 513 }, (_, index) => ({ table_name: `table_${index}`, table_type: 'BASE TABLE', engine: 'InnoDB' })) })
    await expectCode(inspect(tooMany), 'backup_preflight_table_limit_exceeded')

    const drifting = fixture({ ddl: { users: 'CREATE TABLE users (id bigint unsigned NOT NULL PRIMARY KEY, email varchar(255) NULL) ENGINE=InnoDB' } })
    const connection = fakeConnection(drifting)
    // Change the DDL after the first SHOW CREATE read, simulating concurrent DDL.
    const originalQuery = connection.query.bind(connection)
    let shows = 0
    connection.query = async (sql, params) => {
      const response = await originalQuery(sql, params)
      if (/SHOW CREATE TABLE/i.test(sql) && ++shows === 1) drifting.ddl.users = 'CREATE TABLE users (id bigint unsigned NOT NULL PRIMARY KEY, email varchar(255) NOT NULL) ENGINE=InnoDB'
      return response
    }
    await expectCode(inspectBackupDatabase(connection, {
      database: 'dev_vue', expectedServerUuid: serverUuid, role: 'source', sourceDatabase: 'dev_vue', timeoutMs: 5000,
    }), 'backup_preflight_source_changed')
  })

  it('always rolls back and sanitizes rollback failures', async () => {
    await expectCode(inspect(fixture({ failRollback: true })), 'backup_preflight_rollback_failed')
    const failed = fixture({ failRollback: true })
    try { await inspect(failed) } catch (error) {
      expect(error).toBeInstanceOf(BackupPreflightError)
      expect(error.message).toBe('backup_preflight_rollback_failed')
      expect(error.message).not.toContain('rollback driver detail')
      expect(failed.calls.at(-1).sql).toBe('ROLLBACK')
    }
  })

  it('aborts a hung query at the overall deadline and destroys the connection', async () => {
    const state = fixture({ hangOn: /FROM `dev_vue`\.`users`/i })
    const connection = fakeConnection(state)
    await expectCode(inspectBackupDatabase(connection, {
      database: 'dev_vue', expectedServerUuid: serverUuid, role: 'source', sourceDatabase: 'dev_vue', timeoutMs: 20,
    }), 'backup_preflight_timeout')
    expect(state.destroyCalls).toBe(1)
    expect(state.calls.at(-1).sql).not.toBe('ROLLBACK')
  })

  it('supports the exact restored-source scope and index-defined composite order', async () => {
    const state = fixture({ database: restoreDatabase, primary: [
      { table_name: 'users', column_name: 'id', seq_in_index: 2 },
      { table_name: 'users', column_name: 'email', seq_in_index: 1 },
    ] })
    const { result } = await inspect(state)
    expect(result).toMatchObject({ role: 'restored-source', database: restoreDatabase })
    expect(result.tables[0].primaryKey).toEqual(['email', 'id'])
    expect(state.calls.some(call => call.sql.includes(`FROM \`${restoreDatabase}\`.\`users\``))).toBe(true)
    const duplicate = fixture({ primary: [
      { table_name: 'users', column_name: 'id', seq_in_index: 1 },
      { table_name: 'users', column_name: 'email', seq_in_index: 2 },
      { table_name: 'users', column_name: 'id', seq_in_index: 3 },
    ] })
    await expectCode(inspect(duplicate), 'backup_preflight_primary_key_metadata_invalid')
  })

  it('requires a cancellable connection and rejects malformed metadata or unsafe counts', async () => {
    await expectCode(inspectBackupDatabase({ query: async () => [] }, {}), 'backup_preflight_connection_invalid')
    await expectCode(inspect(fixture({ version: '5.7.44' })), 'backup_preflight_mysql_version_unsupported')
    await expectCode(inspect(fixture({ counts: { users: Number.MAX_SAFE_INTEGER + 1 } })), 'backup_preflight_count_invalid')
    await expectCode(inspect(fixture({ tables: [{ table_name: 'other.users', table_type: 'BASE TABLE', engine: 'InnoDB' }] })), 'backup_preflight_unknown_identifier')
  })
})
