export interface TradeMoneyCurrency {
  accountCurrency: string | null
  currencyEvidence: 'unknown' | 'explicit_record'
}

export function recordMoneyCurrency(record: Record<string, unknown>): TradeMoneyCurrency {
  if (record.currency_evidence === undefined || record.currency_evidence === 'unknown') return { accountCurrency: null, currencyEvidence: 'unknown' }
  if (record.currency_evidence !== 'explicit_record' || typeof record.account_currency !== 'string'
    || !/^[A-Za-z][A-Za-z0-9._-]{0,15}$/.test(record.account_currency)) throw new Error('trade_history_currency_evidence_invalid')
  return { accountCurrency: record.account_currency, currencyEvidence: 'explicit_record' }
}

export function combineMoneyCurrencies(facts: TradeMoneyCurrency[]): TradeMoneyCurrency & { conflicting: boolean } {
  const known = new Set(facts.filter(fact => fact.currencyEvidence === 'explicit_record' && fact.accountCurrency !== null).map(fact => fact.accountCurrency))
  const conflicting = known.size > 1
  const complete = facts.length > 0 && !conflicting && facts.every(fact => fact.currencyEvidence === 'explicit_record' && fact.accountCurrency !== null)
  return { accountCurrency: complete ? facts[0]!.accountCurrency : null, currencyEvidence: complete ? 'explicit_record' : 'unknown', conflicting }
}
