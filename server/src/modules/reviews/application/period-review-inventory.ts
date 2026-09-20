import { belongsToReviewPeriod, freezeReviewPeriod, type ReviewPeriod } from '../domain/review-period.js'

export interface PeriodTradeInventory {
  accountId: string
  rangeStartUtcMsc: number
  rangeEndUtcMsc: number
  asOfUtcMsc: number
  completionHash: string
  /** Full closed-trade inventory, including explicit exclusions and unresolved records. */
  records: Array<{ id: string; revision: number; closedAtUtcMsc: number
    source: 'system' | 'manual' | 'other_ea' | 'mixed' | 'unknown'; attribution: 'exact' | 'partial' | 'unresolved'
    evidenceHash: string; accountCurrency: string | null }>
}

/** This gate consumes an authoritative inventory; it must not be fed only cases already generated. */
export function selectPeriodReviewTrades(periodInput: ReviewPeriod, inventory: PeriodTradeInventory) {
  const period = freezeReviewPeriod(periodInput,inventory.asOfUtcMsc)
  if (!/^[1-9]\d{0,19}$/.test(inventory.accountId) || !/^[a-f0-9]{64}$/.test(inventory.completionHash)
    || inventory.rangeStartUtcMsc > period.start.utcMsc || inventory.rangeEndUtcMsc < inventory.asOfUtcMsc
    || !Number.isSafeInteger(inventory.rangeStartUtcMsc) || !Number.isSafeInteger(inventory.rangeEndUtcMsc)
    || inventory.records.length>10000 || new Set(inventory.records.map(r=>r.id)).size!==inventory.records.length
    || inventory.records.some(r=>!r.id || !Number.isSafeInteger(r.closedAtUtcMsc) || r.closedAtUtcMsc<=0
      || r.closedAtUtcMsc>inventory.asOfUtcMsc || !['system','manual','other_ea','mixed','unknown'].includes(r.source))) {
    return { status:'unresolved' as const, reason:'period_inventory_incomplete' }
  }
  const records=inventory.records.filter(r=>belongsToReviewPeriod(period,r.closedAtUtcMsc))
  if (records.some(r=>r.attribution!=='exact' || ['unknown','mixed'].includes(r.source)
    || !Number.isSafeInteger(r.revision) || r.revision<1 || !/^[a-f0-9]{64}$/.test(r.evidenceHash))) {
    return { status:'unresolved' as const, reason:'period_trade_source_incomplete' }
  }
  const selected=records.filter(r=>r.source==='system')
  if (!selected.length) return { status:'empty' as const, period, excludedCount:records.length }
  const currencies=new Set(selected.map(r=>r.accountCurrency))
  if(currencies.size!==1 || currencies.has(null) || currencies.has('')) return {status:'unresolved' as const,reason:'period_currency_incomplete'}
  return {status:'selected' as const,period,accountId:inventory.accountId,accountCurrency:selected[0]!.accountCurrency!,
    asOfUtcMsc:inventory.asOfUtcMsc,completionHash:inventory.completionHash,
    records:structuredClone(selected).sort((a,b)=>a.closedAtUtcMsc-b.closedAtUtcMsc || a.id.localeCompare(b.id)),
    exclusions:records.filter(r=>r.source!=='system').map(r=>({id:r.id,source:r.source,evidenceHash:r.evidenceHash}))}
}
