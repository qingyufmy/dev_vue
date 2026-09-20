import { createHash } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { executionWorkflowSchema } from './execution-workflow-schema.js'

function schemaHash(ddl: string): string {
  return createHash('sha256').update(ddl.replace(/\r\n/g, '\n')
    .replace(/CHARACTER SET utf8mb4 COLLATE (utf8mb4_[a-z0-9_]+)/g, 'COLLATE $1')
    .replace(/(\) ENGINE=[^\n]*?) AUTO_INCREMENT=\d+(?= |$)/, '$1')).digest('hex')
}

// Admit only the frozen execution workflow schema and all transitive foreign-key parents.
export async function assertMysqlExecutionWorkflowSchemaReady(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  const requiredSteps = executionWorkflowSchema.steps
  const requiredTables = executionWorkflowSchema.tables
  const connection = await pool.getConnection().catch(() => { throw Error('execution_workflow_schema_not_ready') })
  let lock: string | undefined, destroyed = false
  try {
    const [[identity]] = await connection.query<RowDataPacket[]>('SELECT DATABASE() db,@@session.time_zone timezone')
    if (!identity?.db || identity.timezone !== '+00:00') throw Error('identity')
    const name = `aurum:inplace:${identity.db}`
    // Concurrent startup/readiness checks share the upgrade lock; wait briefly, never bypass it.
    const [[claim]] = await connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?,2) acquired', [name])
    if (Number(claim?.acquired) !== 1) throw Error('upgrade_busy')
    lock = name
    const [history] = await connection.query<RowDataPacket[]>(
      'SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id LIMIT 1001')
    const byId = new Map(history.map(row => [row.id, row]))
    if (history.length > 1000 || byId.size !== history.length || history.some(row => row.status !== 'completed')
      || requiredSteps.some(step => byId.get(step.id)?.checksum !== step.checksum)) throw Error('history')
    for (const requirement of requiredTables) {
      const [[row]] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${requirement.table}\``)
      if (typeof row?.['Create Table'] !== 'string' || schemaHash(row['Create Table']) !== requirement.schemaSha256) throw Error('schema')
    }
    const [triggers] = await connection.query<RowDataPacket[]>(
      'SELECT EVENT_OBJECT_TABLE tableName FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()')
    const tables = new Set<string>(requiredTables.map(row => row.table))
    if (triggers.some(row => tables.has(row.tableName))) throw Error('trigger')
  } catch {
    throw Error('execution_workflow_schema_not_ready')
  } finally {
    if (lock) {
      try {
        const [[release]] = await connection.execute<RowDataPacket[]>('SELECT RELEASE_LOCK(?) released', [lock])
        if (Number(release?.released) !== 1) throw Error('lock_release')
      } catch { connection.destroy(); destroyed = true }
    }
    if (!destroyed) connection.release()
    else throw Error('execution_workflow_schema_not_ready')
  }
}
