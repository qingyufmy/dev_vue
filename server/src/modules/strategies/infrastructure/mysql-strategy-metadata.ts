import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise'
import type { StrategyDetail, UpdateStrategyMetadataInput } from '../domain/strategy.js'
import { StrategyAccessError } from '../domain/strategy.js'
import { writeOwnedStrategy } from './mysql-owned-strategy-write.js'

export async function updateStrategyMetadataWithReceipt(pool: Pool, input: UpdateStrategyMetadataInput,
  prepare: () => Pick<UpdateStrategyMetadataInput, 'name' | 'description'>,
  read: (connection: PoolConnection) => Promise<StrategyDetail | null>): Promise<StrategyDetail> {
  return writeOwnedStrategy(pool, input, 'update_metadata', { name: input.name, description: input.description }, async connection => {
    const metadata = prepare()
    const [updated] = await connection.execute<ResultSetHeader>(`UPDATE strategies
      SET name=?,description=?,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3)
      WHERE id=? AND owner_user_id=? AND scope='user' AND revision=?`,
    [metadata.name, metadata.description, input.strategyId, input.userId, input.expectedRevision])
    if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_revision_conflict', 412)
  }, read)
}
