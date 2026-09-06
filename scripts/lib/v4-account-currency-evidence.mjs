import { hash, requireBackfill as check } from './v4-backfill-contract.mjs'

export function reviewAccountCurrencyEvidence({ intervals, daily, totals, accountMap, entities }) {
  check(Array.isArray(intervals) && Array.isArray(daily) && Array.isArray(totals) && accountMap instanceof Map && Array.isArray(entities), 'currency_evidence_input_invalid')
  const history = new Map(), current = new Map(entities.map(entity => [entity.targetAccountId, entity.currency]))
  const issues = [], referenced = new Set(), currencies = new Set(), seen = new Set()
  const issue = (code, locator) => issues.push({ code, locatorHash: hash(locator) })
  for (const interval of intervals) {
    if (history.has(interval.id)) issue('duplicate_interval', interval.id)
    history.set(interval.id, interval)
  }
  for (const [kind, rows] of [['daily', daily], ['totals', totals]]) for (const row of rows) {
    const locator = [kind, row.ownership_history_id, ...(kind === 'daily' ? [row.business_date] : [])], key = hash(locator)
    if (seen.has(key)) issue('duplicate_currency_record', locator)
    seen.add(key)
    const owner = history.get(row.ownership_history_id), account = accountMap.get(row.trading_account_id)
    if (!owner || owner.trading_account_id !== row.trading_account_id || !account || !current.has(account.targetAccountId)) {
      issue('currency_record_ownership_mismatch', locator); continue
    }
    referenced.add(owner.id)
    if (typeof row.account_currency !== 'string' || !/^[\x21-\x7e]{1,12}$/.test(row.account_currency)) {
      issue('currency_missing_or_unrepresentable', locator); continue
    }
    currencies.add(row.account_currency)
    if (row.account_currency !== current.get(account.targetAccountId)) issue('currency_differs_from_current_entity', locator)
  }
  issues.sort((a, b) => a.code.localeCompare(b.code) || a.locatorHash.localeCompare(b.locatorHash))
  const stable = rows => rows.map(row => hash({ ...row })).sort()
  return { kind: 'account-currency-evidence-v1', counts: { historicalIntervals: intervals.length, dailyRows: daily.length,
    totalRows: totals.length, referencedIntervals: referenced.size, unreferencedIntervals: intervals.length - referenced.size, distinctCurrencies: currencies.size },
    issues, recordedCurrencyConsistent: issues.length === 0, historicalCurrencyProven: false, historicalPlatformProven: false,
    provenanceLimit: 'legacy_performance_currency_can_be_overwritten_or_inherited_from_current_binding',
    sourceHash: hash({ intervals: stable(intervals), daily: stable(daily), totals: stable(totals),
      mappings: [...accountMap].sort(([a], [b]) => a.localeCompare(b)), currencies: [...current].sort(([a], [b]) => a.localeCompare(b)) }) }
}
