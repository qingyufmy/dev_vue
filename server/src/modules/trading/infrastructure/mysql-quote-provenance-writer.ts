import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { QuoteProvenanceWriter } from '../application/quote-provenance-writer.js'
import { TradingAccessError } from '../domain/trading.js'

class QuoteProvenanceSchemaError extends Error {
  readonly code = 'quote_provenance_schema_not_ready'
  constructor() { super('quote_provenance_schema_not_ready') }
}

/** Transitional capability guard; full startup must additionally verify the reviewed migration/table hashes. */
export async function assertMysqlQuoteProvenanceCapability(connection: Pick<PoolConnection, 'execute'>): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT c.CHECK_CLAUSE clause,t.ENFORCED enforced
    FROM information_schema.TABLE_CONSTRAINTS t INNER JOIN information_schema.CHECK_CONSTRAINTS c
      ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
    WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME='trading_projection_provenance_v4'
      AND t.CONSTRAINT_TYPE='CHECK' AND t.CONSTRAINT_NAME='chk_projection_provenance_kind'`)
  const clause=String(rows[0]?.clause ?? '').replace(/\\'/g,"'").replace(/_(?:ascii|utf8mb4|utf8mb3)(?=')/gi,'').replace(/[\s\x60()]/g,'')
  if (rows.length !== 1 || rows[0]?.enforced !== 'YES'
    || clause !== "resource_kindin'account.metrics','positions','pending_orders','market.quote'") {
    throw new QuoteProvenanceSchemaError()
  }
}
export function createMysqlQuoteProvenanceWriter(connection: PoolConnection): QuoteProvenanceWriter {
  return { async write(input) {
    const {route,projection,ownership}=structuredClone(input), data=projection.data
    if (projection.resource !== 'market.quote' || projection.accountId !== route.accountId || data.accountId !== route.accountId
      || projection.resourceId !== data.symbol || !/^[A-Za-z0-9._-]{1,64}$/.test(data.symbol)
      || !Number.isSafeInteger(projection.revision) || projection.revision < 1 || data.revision !== projection.revision
      || ownership.ownershipRevision !== route.ownershipRevision || !ownership.intervalId
      || !Number.isFinite(Date.parse(data.observedAt)) || new Date(data.observedAt).toISOString() !== data.observedAt) {
      throw new TradingAccessError('trading_context_invalid',400)
    }
    await assertMysqlQuoteProvenanceCapability(connection)
    await connection.execute(`INSERT INTO trading_projection_provenance_v4
      (trading_account_id,resource_kind,resource_id,user_id,ownership_interval_id,ownership_revision,
        terminal_profile_id,terminal_instance_id,connection_epoch,projection_revision,observed_at_utc)
      VALUES (?,'market.quote',?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),ownership_interval_id=VALUES(ownership_interval_id),
        ownership_revision=VALUES(ownership_revision),terminal_profile_id=VALUES(terminal_profile_id),
        terminal_instance_id=VALUES(terminal_instance_id),connection_epoch=VALUES(connection_epoch),
        projection_revision=VALUES(projection_revision),observed_at_utc=VALUES(observed_at_utc)`,
    [route.accountId,projection.resourceId,route.userId,ownership.intervalId,ownership.ownershipRevision,
      route.terminalProfileId,route.terminalInstanceId,route.connectionEpoch,projection.revision,data.observedAt.replace('T',' ').replace('Z','')])
  } }
}
