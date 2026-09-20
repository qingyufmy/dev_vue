import { createHash } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'

export interface BridgeInstallationSchemaRequirements {
  steps: readonly { id: string; checksum: string }[]
  tables: readonly { table: string; schemaSha256: string }[]
}
const names = ['bridge_installation_request_limits', 'bridge_installation_authorizations', 'bridge_installation_requests', 'bridge_refresh_sessions']
const schemaHash = (ddl: string) => createHash('sha256').update(ddl.replace(/\r\n/g, '\n')
  .replace(/CHARACTER SET utf8mb4 COLLATE (utf8mb4_[a-z0-9_]+)/g, 'COLLATE $1')
  .replace(/(\) ENGINE=[^\n]*?) AUTO_INCREMENT=\d+(?= |$)/, '$1')).digest('hex')

/** Read-only admission under the same named lock used by the inplace upgrader. */
export async function assertBridgeInstallationSchema(pool: Pick<Pool, 'getConnection'>, schema: BridgeInstallationSchemaRequirements): Promise<void> {
  if (schema.steps.length !== 279 || new Set(schema.steps.map(row => row.id)).size !== 279
    || !schema.steps.some(row => row.id === 'inplace_080_01a_limits_collation_correction')
    || schema.tables.length !== names.length || new Set(schema.tables.map(row => row.table)).size !== names.length
    || schema.tables.some(row => !names.includes(row.table))) throw Error('bridge_installation_schema_not_ready')
  const connection = await pool.getConnection().catch(() => { throw Error('bridge_installation_schema_not_ready') })
  let lock: string | undefined, destroyed = false
  try {
    const [[identity]] = await connection.query<RowDataPacket[]>('SELECT DATABASE() db,@@session.time_zone timezone')
    if (!identity?.db || identity.timezone !== '+00:00') throw Error('identity')
    const name = /^dev_vue_workflow_schema_ref_[a-f0-9]{32}$/.test(String(identity.db))
      ? `aurum:biref:${String(identity.db).slice(-32)}` : `aurum:inplace:${identity.db}`
    if (Buffer.byteLength(name, 'utf8') > 64) throw Error('lock_name_too_long')
    // Concurrent startup/readiness checks share the upgrade lock; wait briefly, never bypass it.
    const [[claim]] = await connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?,2) acquired', [name])
    if (Number(claim?.acquired) !== 1) throw Error('upgrade_busy')
    lock = name
    const [history] = await connection.query<RowDataPacket[]>('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id LIMIT 1001')
    const byId = new Map(history.map(row => [row.id, row]))
    if (history.length > 1000 || byId.size !== history.length || history.some(row => row.status !== 'completed')
      || schema.steps.some(row => byId.get(row.id)?.checksum !== row.checksum)) throw Error('history')
    for (const requirement of schema.tables) {
      const [[table]] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${requirement.table}\``)
      if (typeof table?.['Create Table'] !== 'string' || schemaHash(table['Create Table']) !== requirement.schemaSha256) throw Error('schema')
    }
    const [triggers] = await connection.query<RowDataPacket[]>('SELECT EVENT_OBJECT_TABLE tableName FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()')
    if (triggers.some(row => names.includes(row.tableName))) throw Error('trigger')
  } catch { throw Error('bridge_installation_schema_not_ready') }
  finally {
    if (lock) {
      try {
        const [[release]] = await connection.execute<RowDataPacket[]>('SELECT RELEASE_LOCK(?) released', [lock])
        if (Number(release?.released) !== 1) throw Error('release')
      } catch { destroyed = true; connection.destroy() }
    }
    if (!destroyed) connection.release()
    else throw Error('bridge_installation_schema_not_ready')
  }
}
