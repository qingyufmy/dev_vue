import { hash } from './v4-backfill-contract.mjs'
import { equivalentRestoredDdl } from './restore-ddl-equivalence.mjs'

export function verifyRiskRestoredSnapshot(source, restored) {
  if (!Array.isArray(source) || !Array.isArray(restored) || source.length === 0
    || new Set(source.map(row => row.name)).size !== source.length
    || hash(source.map(row => row.name)) !== hash(restored.map(row => row.name))) throw Error('risk_backup_tables_mismatch')
  const differences = []
  for (const [index, row] of source.entries()) {
    const target = restored[index]
    if (row.rows !== target.rows || row.rowsSha256 !== target.rowsSha256) throw Error('risk_backup_rows_mismatch')
    if (hash(row.columns) !== hash(target.columns)) throw Error('risk_backup_columns_mismatch')
    const result = equivalentRestoredDdl(row.ddl, target.ddl, row.columns)
    if (!result.equivalent) throw Error('risk_backup_ddl_mismatch')
    if (result.differences.length) differences.push({ table: row.name, differences: result.differences })
  }
  return { tableCount: source.length, rowParity: true, columnMetadataParity: true, semanticDdlParity: true, differences }
}
