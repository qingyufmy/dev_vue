import { createHash } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { assertBridgeInstallationSchema, type BridgeInstallationSchemaRequirements } from '../src/modules/bridge/infrastructure/mysql-bridge-installation-schema-readiness.js'

const names = ['bridge_installation_request_limits', 'bridge_installation_authorizations', 'bridge_installation_requests', 'bridge_refresh_sessions']
function fixture() {
  const ddls = new Map(names.map(table => [table, `CREATE TABLE \`${table}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB`]))
  const steps = Array.from({ length: 278 }, (_, index) => ({ id: index === 271 ? 'inplace_080_01a_limits_collation_correction' : `step-${index + 1}`, checksum: String(index + 1).padStart(64, '0') }))
  const requirements: BridgeInstallationSchemaRequirements = { steps, tables: [...ddls].map(([table, ddl]) => ({ table, schemaSha256: createHash('sha256').update(ddl).digest('hex') })) }
  const state = { db: 'reference_only', history: steps.map(row => ({ ...row, status: 'completed' })), lock: 1, release: 1, timezone: '+00:00', triggers: [] as { tableName: string }[] }
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT DATABASE()')) return [[{ db: state.db, timezone: state.timezone }], []]
    if (sql.startsWith('SELECT id,checksum_sha256')) return [state.history, []]
    if (sql.startsWith('SHOW CREATE TABLE')) {
      const name = /`([^`]+)`/.exec(sql)?.[1] ?? ''
      return [[{ 'Create Table': ddls.get(name) }], []]
    }
    if (sql.includes('information_schema.TRIGGERS')) return [state.triggers, []]
    throw Error('unexpected read')
  })
  const execute = vi.fn(async (sql: string, _values?: unknown[]) => sql.includes('GET_LOCK') ? [[{ acquired: state.lock }], []] : [[{ released: state.release }], []])
  const connection = { query, execute, release: vi.fn(), destroy: vi.fn() }
  const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool
  return { requirements, ddls, state, connection, pool }
}
describe('Bridge installation startup admission (read-only SQL doubles)', () => {
  it('requires all 278 completed checksums including correction and four actual table hashes without writing', async () => {
    const f = fixture()
    await assertBridgeInstallationSchema(f.pool, f.requirements)
    expect(f.connection.query.mock.calls.filter(([sql]) => sql.startsWith('SHOW CREATE TABLE'))).toHaveLength(4)
    expect(f.connection.query.mock.calls.every(([sql]) => /^(SELECT|SHOW) /.test(sql))).toBe(true)
    expect(f.connection.release).toHaveBeenCalledOnce()
  })
  it.each(['missing-step', 'started-step', 'wrong-checksum', 'duplicate-step', 'missing-table', 'wrong-hash', 'trigger'])('fails closed on %s', async problem => {
    const f = fixture()
    if (problem === 'missing-step') f.state.history.pop()
    if (problem === 'started-step') f.state.history[270]!.status = 'started'
    if (problem === 'wrong-checksum') f.state.history[270]!.checksum = 'f'.repeat(64)
    if (problem === 'duplicate-step') f.state.history.push(f.state.history[0]!)
    if (problem === 'missing-table') f.ddls.delete('bridge_installation_requests')
    if (problem === 'wrong-hash') f.ddls.set('bridge_refresh_sessions', 'CREATE TABLE old_profile_schema (id INT)')
    if (problem === 'trigger') f.state.triggers.push({ tableName: 'bridge_installation_authorizations' })
    await expect(assertBridgeInstallationSchema(f.pool, f.requirements)).rejects.toThrow('bridge_installation_schema_not_ready')
    expect(f.connection.release).toHaveBeenCalledOnce()
  })
  it('rejects a pre-080 requirements artifact before opening a connection', async () => {
    const f = fixture()
    await expect(assertBridgeInstallationSchema(f.pool, { ...f.requirements, steps: f.requirements.steps.slice(0, 267) })).rejects.toThrow('bridge_installation_schema_not_ready')
    expect(f.pool.getConnection).not.toHaveBeenCalled()
  })
  it('rejects an uncorrected 271-step artifact or one that omits the correction identity', async () => {
    const f = fixture()
    await expect(assertBridgeInstallationSchema(f.pool, { ...f.requirements, steps: f.requirements.steps.slice(0, 271) })).rejects.toThrow('bridge_installation_schema_not_ready')
    const steps = f.requirements.steps.map(row => ({ ...row }))
    steps[271]!.id = 'unrelated-correction'
    await expect(assertBridgeInstallationSchema(f.pool, { ...f.requirements, steps })).rejects.toThrow('bridge_installation_schema_not_ready')
    expect(f.pool.getConnection).not.toHaveBeenCalled()
  })
  it.each(['missing', 'started', 'checksum'])('rejects %s correction evidence even with all 271 original steps complete', async problem => {
    const f = fixture()
    if (problem === 'missing') f.state.history.pop()
    if (problem === 'started') f.state.history[271]!.status = 'started'
    if (problem === 'checksum') f.state.history[271]!.checksum = 'f'.repeat(64)
    await expect(assertBridgeInstallationSchema(f.pool, f.requirements)).rejects.toThrow('bridge_installation_schema_not_ready')
  })
  it('does not release an upgrade lock held by another connection', async () => {
    const f = fixture(); f.state.lock = 0
    await expect(assertBridgeInstallationSchema(f.pool, f.requirements)).rejects.toThrow('bridge_installation_schema_not_ready')
    expect(f.connection.execute).toHaveBeenCalledTimes(1)
    expect(f.connection.release).toHaveBeenCalledOnce()
  })
  it('destroys a connection when its lock cannot be released', async () => {
    const f = fixture(); f.state.release = 0
    await expect(assertBridgeInstallationSchema(f.pool, f.requirements)).rejects.toThrow('bridge_installation_schema_not_ready')
    expect(f.connection.destroy).toHaveBeenCalledOnce()
    expect(f.connection.release).not.toHaveBeenCalled()
  })
  it('shares the short reference lock with the reference upgrader and rejects oversized other names', async () => {
    const f = fixture(); f.state.db = `dev_vue_workflow_schema_ref_${'a'.repeat(32)}`
    await assertBridgeInstallationSchema(f.pool, f.requirements)
    expect(f.connection.execute.mock.calls[0]?.[1]).toEqual([`aurum:biref:${'a'.repeat(32)}`])
    expect(f.connection.execute.mock.calls[1]?.[1]).toEqual([`aurum:biref:${'a'.repeat(32)}`])
    const other = fixture(); other.state.db = 'b'.repeat(64)
    await expect(assertBridgeInstallationSchema(other.pool, other.requirements)).rejects.toThrow('bridge_installation_schema_not_ready')
    expect(other.connection.execute).not.toHaveBeenCalled()
    expect(other.connection.release).toHaveBeenCalledOnce()
  })
})
