// Refresh a previously incomplete account state without creating an order intent.
// This is intentionally limited to halted/incomplete accounts, so opening the
// Risk Center does not turn into a continuous MT5 polling path.

import { queryAll, queryOne, parseBeijing } from '../../db.js'
import { sendBridgeCommand, isBridgeAlive } from '../../bridge-ws.js'
import { stripBrokerSuffix } from './utils.js'
import { resolveEffectiveRiskPolicy } from './risk-policy.js'
import { refreshRiskAccountState } from './risk-state.js'

const midpoint = quote => {
  const bid = Number(quote?.bid), ask = Number(quote?.ask)
  return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null
}

async function refreshOne(userId, row) {
  const symbolRow = await queryOne(`SELECT symbol FROM order_intents
    WHERE user_id = ? AND trading_account_id = ? AND symbol IS NOT NULL AND symbol <> ''
    ORDER BY id DESC LIMIT 1`, [userId, row.trading_account_id])
  const symbol = String(symbolRow?.symbol || 'XAUUSD').trim().toUpperCase()
  const result = await sendBridgeCommand(userId, 'risk_snapshot', {
    symbol,
    last_deal_time_msc: Number(row.last_deal_time_msc || 0),
    last_deal_ticket: Number(row.last_deal_ticket || 0),
    baseline_from_utc_msc: Number(row.last_deal_time_msc || 0) ? 0
      : (parseBeijing(row.last_risk_snapshot_at || row.first_verified_at)?.getTime() || Date.now()),
  }, 10_000, { noFallback: true })
  if (!result || result.status !== 'success') {
    return { account_id: Number(row.trading_account_id), refreshed: false, error: String(result?.error || result?.message || 'risk_snapshot_failed') }
  }

  const instruments = {}
  for (const item of Object.values(result.instruments || {})) {
    if (item?.name) instruments[stripBrokerSuffix(item.name)] = item
  }
  const accountCurrency = String(result.account?.currency || '').toUpperCase()
  const fxRates = {}
  const quoteCurrencies = new Set([...(result.positions || []), ...(result.pending || [])]
    .map(item => instruments[stripBrokerSuffix(item.symbol)]?.currency_profit || stripBrokerSuffix(item.symbol).slice(3, 6))
    .map(value => String(value || '').toUpperCase()).filter(Boolean))
  for (const currency of quoteCurrencies) {
    if (!currency || !accountCurrency || currency === accountCurrency) continue
    for (const pair of [`${currency}${accountCurrency}`, `${accountCurrency}${currency}`]) {
      const quote = await sendBridgeCommand(userId, 'quote', { symbol: pair }, 5_000, { noFallback: true })
      const rate = midpoint(quote)
      if (rate) { fxRates[pair] = rate; break }
    }
  }

  const resolved = await resolveEffectiveRiskPolicy({ userId, tradingAccountId: Number(row.trading_account_id) })
  const state = await refreshRiskAccountState(userId, Number(row.trading_account_id), {
    account: result.account || {}, positions: result.positions || [], pending: result.pending || [],
    instruments, fxRates, snapshot_complete: result.complete === true,
    data_incomplete_reasons: result.incomplete_reasons || [],
    risk_snapshot_version: Number(result.snapshot_version || 0),
    timezone_offset_minutes:result.timezone_offset_minutes == null
      || result.timezone_offset_minutes === '' ? null : Number(result.timezone_offset_minutes),
    clock_status:result.clock_status || '',
    businessDate: result.business_date, increment: result.increment || {},
  }, resolved.policy)
  return { account_id: Number(row.trading_account_id), refreshed: true, state }
}

export async function refreshIncompleteRiskAccounts(userId) {
  if (!isBridgeAlive(userId)) return { attempted: 0, refreshed: 0, results: [], bridge_connected: false }
  const rows = await queryAll(`SELECT ta.id AS trading_account_id, ta.first_verified_at,
      ras.last_deal_time_msc, ras.last_deal_ticket, ras.last_risk_snapshot_at
    FROM trading_accounts ta JOIN risk_account_state ras ON ras.trading_account_id = ta.id
    WHERE ta.user_id = ? AND ta.is_deleted = 0
      AND (ras.data_complete = 0 OR ras.halt_reason = 'R3_RISK_DATA_INCOMPLETE')`, [userId])
  const results = []
  for (const row of rows) {
    try { results.push(await refreshOne(userId, row)) }
    catch (error) { results.push({ account_id: Number(row.trading_account_id), refreshed: false, error: String(error?.message || error) }) }
  }
  return { attempted: rows.length, refreshed: results.filter(item => item.refreshed).length, results, bridge_connected: true }
}
