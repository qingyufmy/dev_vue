import type { Pool, RowDataPacket } from 'mysql2/promise'
/** Public market providers are active administrator identities, never arbitrary account owners. */
export function createMysqlMarketProviders(pool: Pick<Pool, 'execute'>) {
  return { async list(): Promise<number[]> {
    const [rows] = await pool.execute<(RowDataPacket & { id: number })[]>(
      "SELECT id FROM users WHERE role='admin' AND deletion_status='active' AND deleted_at IS NULL ORDER BY id LIMIT 101")
    if (rows.length > 100) throw new Error('market_provider_inventory_limit')
    return rows.map(row => Number(row.id))
  } }
}
