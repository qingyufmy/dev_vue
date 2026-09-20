import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { MarketAnalysisListReader, MarketAnalysisListRow } from '../application/market-analysis-list.js'
import type { MarketAnalysisSummary } from '../domain/inference.js'

interface AnalysisRow extends RowDataPacket {
  id: string; owner_user_id: number; strategy_id: string; strategy_version_id: string; standard_symbol: string
  market_bias: MarketAnalysisSummary['marketBias']; opportunity: MarketAnalysisSummary['opportunity']; confidence: string
  summary: string; analyzed_at_utc: Date; valid_until_utc: Date; created_at_utc: Date; input_snapshot_hash: string; revision: number
}

export class MysqlMarketAnalysisListReader implements MarketAnalysisListReader {
  constructor(private readonly pool: Pick<Pool, 'execute'>) {}

  async readPage(input: Parameters<MarketAnalysisListReader['readPage']>[0]): Promise<MarketAnalysisListRow[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 2 || input.limit > 201) throw new Error('analysis_list_limit_invalid')
    const where = ['a.owner_user_id=?']
    const parameters: (number | string)[] = [input.userId]
    if (input.symbol !== null) { where.push('BINARY a.standard_symbol=BINARY ?'); parameters.push(input.symbol) }
    if (input.strategyId !== null) { where.push('a.strategy_id=?'); parameters.push(input.strategyId) }
    if (input.after) {
      where.push('(a.created_at_utc<? OR (a.created_at_utc=? AND a.id<?))')
      const createdAt = input.after.createdAt.replace('T', ' ').replace('Z', '')
      parameters.push(createdAt, createdAt, input.after.id)
    }
    parameters.push(String(input.limit))
    const [rows] = await this.pool.execute<AnalysisRow[]>(`SELECT a.id,a.owner_user_id,
      CAST(a.strategy_id AS CHAR) strategy_id,CAST(a.strategy_version_id AS CHAR) strategy_version_id,
      a.standard_symbol,a.market_bias,a.opportunity,a.confidence,a.summary,a.analyzed_at_utc,a.valid_until_utc,
      a.created_at_utc,s.payload_sha256 input_snapshot_hash,a.revision
      FROM market_analyses a INNER JOIN inference_snapshots s ON s.id=a.input_snapshot_id
      WHERE ${where.join(' AND ')} ORDER BY a.created_at_utc DESC,a.id DESC LIMIT ?`, parameters)
    return rows.map(row => ({ createdAt: row.created_at_utc.toISOString(), item: {
      id: row.id, userId: row.owner_user_id, strategyId: row.strategy_id, strategyVersionId: row.strategy_version_id,
      symbol: row.standard_symbol, marketBias: row.market_bias, opportunity: row.opportunity, confidence: Number(row.confidence),
      summary: row.summary, analyzedAt: row.analyzed_at_utc.toISOString(), validUntil: row.valid_until_utc.toISOString(),
      inputSnapshotHash: row.input_snapshot_hash, revision: row.revision,
    } }))
  }
}
