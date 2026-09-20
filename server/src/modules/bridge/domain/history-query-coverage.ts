export interface HistoryQueryCoverage {
  version: 1
  status: 'complete'
  range_start_utc_msc: number
  range_end_utc_msc: number
  source_revision: string
  collected_at_utc_msc: number
}

/** Optional explicit provider assertion. Absence never implies completeness. */
export function validHistoryQueryCoverage(value: unknown, resource: unknown, revision: unknown, observed: number): value is HistoryQueryCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['history.orders','history.deals','history.trades'].includes(String(resource))) return false
  const v = value as Record<string, unknown>
  const keys = ['version','status','range_start_utc_msc','range_end_utc_msc','source_revision','collected_at_utc_msc']
  if (Object.keys(v).length !== keys.length || !keys.every(key => Object.hasOwn(v,key))) return false
  const start = v.range_start_utc_msc, end = v.range_end_utc_msc, collected = v.collected_at_utc_msc
  return typeof revision === 'string' && revision.length > 0 && revision.length <= 128
    && v.version === 1 && v.status === 'complete' && v.source_revision === revision
    && [start,end,collected].every(n => Number.isSafeInteger(n) && Number(n) > 0)
    && Number(start) < Number(end) && Number(end) <= Number(collected) && Number(collected) <= observed
}
