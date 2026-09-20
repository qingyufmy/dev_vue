import { quoteProvenanceSchema } from './quote-provenance-schema.js'
import { createHash } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { inplaceAccountSchema } from './inplace-account-schema.js'
import { instrumentCollectionSchema } from './instrument-collection-schema.js'

function schemaHash(ddl: string): string {
  return createHash('sha256').update(ddl.replace(/\r\n/g, '\n')
    .replace(/CHARACTER SET utf8mb4 COLLATE (utf8mb4_[a-z0-9_]+)/g, 'COLLATE $1')
    .replace(/(\) ENGINE=[^\n]*?) AUTO_INCREMENT=\d+(?= |$)/, '$1')).digest('hex')
}

// Current supported upgrade profile plus the required management singleton. Never writes or populates data.
// Future compatible steps are allowed; any unfinished step or consumed-schema drift rejects readiness.
export async function assertMysqlTradingSchemaReady(pool: Pick<Pool, 'getConnection'>,
  principalReadSchema?: (connection: Pick<PoolConnection, 'query'>) => Promise<void>,
  additional?: { steps: readonly { id: string; checksum: string }[]; tables: readonly { table: string; schemaSha256: string }[] }): Promise<void> {
  const steps = [...inplaceAccountSchema.steps, ...additional?.steps ?? []]
  const tables = [...inplaceAccountSchema.tables, ...additional?.tables ?? []]
  const connection = await pool.getConnection().catch(() => { throw Error('trading_schema_not_ready') })
  let lock: string | undefined, destroyed = false
  try {
    const [[identity]] = await connection.query<RowDataPacket[]>('SELECT DATABASE() db,@@session.time_zone timezone')
    if (!identity?.db || identity.timezone !== '+00:00') throw Error('identity')
    lock = `aurum:inplace:${identity.db}`
    // Concurrent startup/readiness checks share the upgrade lock; wait briefly, never bypass it.
    const [[claim]] = await connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?,2) acquired', [lock])
    if (Number(claim?.acquired) !== 1) { lock = undefined; throw Error('upgrade_busy') }
    const [history] = await connection.query<RowDataPacket[]>(
      'SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id LIMIT 1001')
    const byId = new Map(history.map(row => [row.id, row]))
    if (history.length > 1000 || byId.size !== history.length || history.some(row => row.status !== 'completed')
      || steps.some(step => byId.get(step.id)?.checksum !== step.checksum)) throw Error('history')
    // A recorded upgrade selects its reviewed table version; never accept either hash without journal proof.
    const quoteUpgrade=byId.get(quoteProvenanceSchema.step.id)
    const consumedTables=tables.map(requirement=>{
      if (!quoteUpgrade || requirement.table !== quoteProvenanceSchema.table) return requirement
      if (requirement.schemaSha256 !== quoteProvenanceSchema.beforeHash
        || quoteProvenanceSchema.steps.some(step=>byId.get(step.id)?.checksum !== step.checksum)) throw Error('quote_profile')
      return {...requirement,schemaSha256:quoteProvenanceSchema.afterHash}
    })
    if (quoteUpgrade && (quoteUpgrade.checksum !== quoteProvenanceSchema.step.checksum
      || quoteProvenanceSchema.steps.some(step=>byId.get(step.id)?.checksum !== step.checksum))) throw Error('quote_history')
    for (const requirement of consumedTables) {
      if (requirement.table === 'users' && principalReadSchema) {
        await principalReadSchema(connection)
        continue
      }
      const [[row]] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${requirement.table}\``)
      if (typeof row?.['Create Table'] !== 'string' || schemaHash(row['Create Table']) !== requirement.schemaSha256) throw Error('schema')
    }
    const [triggers] = await connection.query<RowDataPacket[]>(
      'SELECT EVENT_OBJECT_TABLE tableName FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()')
    const guarded = new Set<string>(tables.map(row => row.table))
    if (triggers.some(row => guarded.has(row.tableName))) throw Error('trigger')
    const [registry] = await connection.query<RowDataPacket[]>(
      'SELECT CAST(revision AS CHAR) revision FROM observer_management_registry WHERE id=1 LIMIT 1')
    const revision = registry[0]?.revision
    if (registry.length !== 1 || typeof revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(revision)
      || BigInt(revision) >= BigInt(Number.MAX_SAFE_INTEGER)) throw Error('observer_registry')
  } catch {
    // Do not expose SQL, connection strings or driver messages through health/startup errors.
    throw Error('trading_schema_not_ready')
  } finally {
    if (lock) {
      try {
        const [[release]] = await connection.execute<RowDataPacket[]>('SELECT RELEASE_LOCK(?) released', [lock])
        if (Number(release?.released) !== 1) throw Error('lock_release')
      } catch { connection.destroy(); destroyed = true }
    }
    if (!destroyed) connection.release()
    else throw Error('trading_schema_not_ready')
  }
}

export async function assertMysqlInstrumentCollectionSchemaReady(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  await assertMysqlTradingSchemaReady(pool, undefined, instrumentCollectionSchema)
}


/** Requires the complete reviewed 205-step history as well as the upgraded consumed table. */
export async function assertMysqlQuoteProvenanceSchemaReady(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  await assertMysqlTradingSchemaReady(pool,undefined,{steps:quoteProvenanceSchema.steps,tables:[]})
}
