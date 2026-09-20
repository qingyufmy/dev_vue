import type { Pool, RowDataPacket } from 'mysql2/promise'

/** Additive development migration 029 / inplace 081; never performs schema writes. */
export async function assertMarketSourceSchemaReady(pool: Pick<Pool, 'execute'>) {
  const [history] = await pool.execute<RowDataPacket[]>(
    'SELECT checksum_sha256,status FROM database_upgrade_steps_v4 WHERE id=?', ['inplace_081_01_market_source_selections'])
  if (history.length !== 1 || history[0]!.status !== 'completed'
    || history[0]!.checksum_sha256 !== 'e7e5ba695eba1502926f6457ab280b05fbda90d9aa71a09040edb02559f4199e') throw new Error('market_source_schema_not_ready')
  const [columns] = await pool.execute<RowDataPacket[]>(
    'SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLLATION_NAME collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['market_source_selections'])
  const expected = [['pool_key', 'varchar(40)', 'NO', 'ascii_bin'], ['standard_symbol', 'varchar(64)', 'NO', 'ascii_bin'],
    ['revision', 'bigint unsigned', 'NO', null], ['source_generation', 'bigint unsigned', 'NO', null],
    ['state_json', 'json', 'NO', null], ['updated_at_utc', 'datetime(3)', 'NO', null]]
  if (JSON.stringify(columns.map(c => [c.name, c.type, c.nullable, c.collation])) !== JSON.stringify(expected)) throw new Error('market_source_schema_not_ready')
  const [indexes] = await pool.execute<RowDataPacket[]>(
    'SELECT INDEX_NAME name,COLUMN_NAME col,NON_UNIQUE nonUnique,SUB_PART subPart FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', ['market_source_selections'])
  if (JSON.stringify(indexes.map(i => [i.name, i.col, Number(i.nonUnique), i.subPart])) !== JSON.stringify([
    ['PRIMARY', 'pool_key', 0, null], ['PRIMARY', 'standard_symbol', 0, null],
  ])) throw new Error('market_source_schema_not_ready')
}
