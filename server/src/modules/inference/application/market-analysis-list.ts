import { InferenceError, type MarketAnalysisSummary } from '../domain/inference.js'

export interface MarketAnalysisListScope { userId: number; symbol: string | null; strategyId: string | null }
export interface MarketAnalysisListPosition { createdAt: string; id: string }
export interface MarketAnalysisListRow { item: MarketAnalysisSummary; createdAt: string }
export interface MarketAnalysisListReader {
  readPage(input: MarketAnalysisListScope & { limit: number; after: MarketAnalysisListPosition | null }): Promise<MarketAnalysisListRow[]>
}
export interface MarketAnalysisListQuery { pageSize?: unknown; cursor?: unknown; symbol?: unknown; strategyId?: unknown }

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/
const validTime = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const invalid = () => new InferenceError('analysis_list_request_invalid', 400)

export class MarketAnalysisListService {
  constructor(private readonly reader: MarketAnalysisListReader) {}

  async list(userId: number, query: MarketAnalysisListQuery = {}) {
    if (!Number.isSafeInteger(userId) || userId < 1 || userId > 2147483647) throw invalid()
    if (Object.keys(query).some(key => !['pageSize', 'cursor', 'symbol', 'strategyId'].includes(key))) throw invalid()
    const rawSize = query.pageSize ?? 50
    const pageSize = typeof rawSize === 'string' && /^[1-9][0-9]{0,2}$/.test(rawSize) ? Number(rawSize) : rawSize
    if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw invalid()
    const symbol = query.symbol === undefined ? null : query.symbol
    const strategyId = query.strategyId === undefined ? null : query.strategyId
    if (symbol !== null && (typeof symbol !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(symbol))) throw invalid()
    if (strategyId !== null && (typeof strategyId !== 'string' || !idPattern.test(strategyId))) throw invalid()
    const scope: MarketAnalysisListScope = { userId, symbol, strategyId }
    let after: MarketAnalysisListPosition | null = null
    if (query.cursor !== undefined && query.cursor !== null) {
      try {
        if (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(query.cursor)) throw invalid()
        const bytes = Buffer.from(query.cursor, 'base64url')
        if (bytes.toString('base64url') !== query.cursor) throw invalid()
        const value = JSON.parse(bytes.toString('utf8'))
        if (!value || Object.keys(value).sort().join(',') !== 'createdAt,id,strategyId,symbol,userId,version'
          || value.version !== 1 || value.userId !== userId || value.symbol !== symbol || value.strategyId !== strategyId
          || !validTime(value.createdAt) || typeof value.id !== 'string' || !idPattern.test(value.id)) throw invalid()
        after = { createdAt: value.createdAt, id: value.id }
      } catch { throw invalid() }
    }
    const rows = await this.reader.readPage({ ...scope, limit: pageSize + 1, after })
    if (rows.length > pageSize + 1 || rows.some(row => !validTime(row.createdAt) || !idPattern.test(row.item.id)
      || row.item.userId !== userId || symbol !== null && row.item.symbol !== symbol
      || strategyId !== null && row.item.strategyId !== strategyId)) throw new InferenceError('analysis_list_response_invalid', 503)
    const selected = rows.slice(0, pageSize)
    const last = selected.at(-1)
    const nextCursor = rows.length > pageSize && last
      ? Buffer.from(JSON.stringify({ version: 1, ...scope, createdAt: last.createdAt, id: last.item.id })).toString('base64url') : null
    return { items: selected.map(row => row.item), nextCursor }
  }
}
