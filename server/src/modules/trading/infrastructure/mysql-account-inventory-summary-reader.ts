import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AccountInventorySummaryReader } from '../application/account-inventory-summary-reader.js'

interface InventoryRow extends RowDataPacket {
  positions_revision: number; pending_orders_revision: number; has_positions: number; has_pending_orders: number
}
export function createAccountInventorySummaryReader(connection: Pick<PoolConnection, 'execute'>): AccountInventorySummaryReader {
  return { async lockAccount(accountId) {
    await connection.execute('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', [accountId])
  }, async read(scope) {
    const [rows] = await connection.execute<InventoryRow[]>(`SELECT COALESCE(pr.revision,0) positions_revision,
      COALESCE(orr.revision,0) pending_orders_revision,
      EXISTS(SELECT 1 FROM open_position_snapshots p WHERE p.trading_account_id=own.trading_account_id
        AND LEFT(UPPER(JSON_UNQUOTE(JSON_EXTRACT(p.payload_json,'$.symbol'))),CHAR_LENGTH(?))=UPPER(?)) has_positions,
      EXISTS(SELECT 1 FROM pending_order_snapshots o WHERE o.trading_account_id=own.trading_account_id
        AND LEFT(UPPER(JSON_UNQUOTE(JSON_EXTRACT(o.payload_json,'$.symbol'))),CHAR_LENGTH(?))=UPPER(?)) has_pending_orders
      FROM trading_account_ownerships own
      LEFT JOIN trading_projection_revisions pr ON pr.trading_account_id=own.trading_account_id AND pr.resource_kind='positions' AND pr.resource_id='open'
      LEFT JOIN trading_projection_revisions orr ON orr.trading_account_id=own.trading_account_id AND orr.resource_kind='pending_orders' AND orr.resource_id='open'
      WHERE own.user_id=? AND own.trading_account_id=? AND own.role='owner' AND own.revoked_at_utc IS NULL FOR SHARE`,
    [scope.symbol, scope.symbol, scope.symbol, scope.symbol, scope.userId, scope.accountId])
    if (rows.length !== 1) return null
    const row = rows[0]!
    return { positionsRevision: Number(row.positions_revision), pendingOrdersRevision: Number(row.pending_orders_revision),
      hasPositions: Number(row.has_positions) === 1, hasPendingOrders: Number(row.has_pending_orders) === 1 }
  }, async readPositions(scope) {
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT p.payload_json FROM open_position_snapshots p
      INNER JOIN trading_account_ownerships own ON own.trading_account_id=p.trading_account_id
      WHERE own.user_id=? AND own.trading_account_id=? AND own.role='owner' AND own.revoked_at_utc IS NULL
      ORDER BY p.ticket LIMIT 1001`, [scope.userId,scope.accountId])
    return rows.map(row => typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json)
  }, async readPendingOrders(scope) {
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT p.payload_json FROM pending_order_snapshots p
      INNER JOIN trading_account_ownerships own ON own.trading_account_id=p.trading_account_id
      WHERE own.user_id=? AND own.trading_account_id=? AND own.role='owner' AND own.revoked_at_utc IS NULL
      ORDER BY p.ticket LIMIT 1001`, [scope.userId,scope.accountId])
    return rows.map(row => typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json)
  }, async readRevisions(scope) {
    const [rows] = await connection.execute<(RowDataPacket & { account_revision: number | null; quote_revision: number | null;
      contract_revision: number | null; positions_revision: number | null; pending_orders_revision: number | null })[]>(
      `SELECT ars.revision account_revision,q.revision quote_revision,i.revision contract_revision,
        pr.revision positions_revision,orr.revision pending_orders_revision
      FROM trading_account_ownerships own
      LEFT JOIN account_runtime_snapshots ars ON ars.trading_account_id=own.trading_account_id
      LEFT JOIN market_quotes q ON q.trading_account_id=own.trading_account_id AND q.symbol=(SELECT matched.symbol FROM market_quotes matched CROSS JOIN (SELECT ? standard_symbol) requested WHERE matched.trading_account_id=q.trading_account_id AND LEFT(UPPER(matched.symbol),CHAR_LENGTH(requested.standard_symbol))=UPPER(requested.standard_symbol))
      LEFT JOIN market_instrument_snapshots i ON i.trading_account_id=own.trading_account_id AND i.symbol=(SELECT matched.symbol FROM market_instrument_snapshots matched CROSS JOIN (SELECT ? standard_symbol) requested WHERE matched.trading_account_id=i.trading_account_id AND LEFT(UPPER(matched.symbol),CHAR_LENGTH(requested.standard_symbol))=UPPER(requested.standard_symbol))
      LEFT JOIN trading_projection_revisions pr ON pr.trading_account_id=own.trading_account_id AND pr.resource_kind='positions' AND pr.resource_id='open'
      LEFT JOIN trading_projection_revisions orr ON orr.trading_account_id=own.trading_account_id AND orr.resource_kind='pending_orders' AND orr.resource_id='open'
      WHERE own.user_id=? AND own.trading_account_id=? AND own.role='owner' AND own.revoked_at_utc IS NULL FOR SHARE`,
    [scope.symbol, scope.symbol, scope.userId, scope.accountId])
    if (rows.length !== 1) return null
    const row = rows[0]!, revision = (value: number | null) => value === null ? null : Number(value)
    return { accountRevision: revision(row.account_revision), quoteRevision: revision(row.quote_revision),
      contractRevision: revision(row.contract_revision), positionsRevision: revision(row.positions_revision), pendingOrdersRevision: revision(row.pending_orders_revision) }
  } }
}
