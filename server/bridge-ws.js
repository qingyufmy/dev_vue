import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import { queryOne, queryAll, queryRun, withTransaction, beijingNow } from './db.js'
import { ADMIN_CACHE_TTL_MS, CORS_ORIGINS } from './config.js'
import { isCorsOriginAllowed } from './cors-origin.js'
import { getRedis, isRedisAvailable } from './redis.js'
import { stripBrokerSuffix, utcMscToTerminalTime } from './routes/ai/utils.js'
import { getRegisteredAutoSchedulerState } from './routes/ai/runtime-state-registry.js'
import { weeklyRiskLockResult } from './jobs/weekly-risk-window.js'
import { localizeAuditRow } from './audit-localization.js'
import { collapseRecoveryAuditRows } from './routes/ai/audit-log-view.js'
import { buildAiAccessContext, observerAccessError, observerWsActionAllowed } from './routes/ai/observer-access.js'
import { getDefaultObserverSource, getDefaultObserverSourceClock, observerSourceSupportsSymbol, resolveObserverSourceForUser } from './routes/ai/observer-channels.js'
import { tokenVersionMatches } from './middleware/auth.js'
import { BRIDGE_V3_WS_PATH, createBridgeV3Gateway } from './bridge-v3/gateway.js'
import { setBridgeReleaseNotifier } from './bridge-v3/release-events.js'
import {
  bridgeHistoryTemporarilyUnavailableResult,
  createBridgeV3BusinessAdapter,
  isBridgeHistoryReadsEnabled,
} from './bridge-v3/business-adapter.js'
import { createObserverQuoteFeedManager } from './observer-quote-feed.js'
import { applyDefaultObserverClockBootstrap, trustedTerminalClock,
  validateExecutionClockContext } from './routes/ai/terminal-clock.js'
import { getInferenceSnapshotEvidence, getInferenceVisualizationSnapshot } from './routes/ai/inference-snapshots.js'
import { executionValidationRejection, readExecutionValidation } from './routes/ai/signal-execution-validation.js'

export { applyDefaultObserverClockBootstrap } from './routes/ai/terminal-clock.js'

import { JWT_SECRET } from './config.js'

// Per-user browser/admin state. Bridge connections are owned exclusively by
// the V3 gateway; this module keeps only browser sockets and V3 read-model
// metadata.
const browsers = new Map()      // userId -> Set<ws>
const adminBrowsers = new Set() // authenticated admin console sockets
const historyPlatformPrepareJobs = new Map()
const riskSnapshotRefreshTimers = new Map()
let adminUserId = null          // cached admin userId for fallback
let adminUserIdLastCheck = 0
const ADMIN_CACHE_TTL = ADMIN_CACHE_TTL_MS
let wss = null
let bridgeV3Business = null
const bridgeV3MarketStates = new Map()
const bridgeV3TradingAccounts = new Map()
const bridgeV3PreferredTerminals = new Map()
const bridgeV3LatestTerminalIdentities = new Map()
let adminEventSeq = 0
const adminEventThrottle = new Map()

const OBSERVER_QUOTE_INTERVAL_MS = 1000
const OBSERVER_QUOTE_FRESH_MS = 2500
let defaultObserverClockCache = null
let defaultObserverClockRefresh = null
let defaultObserverClockLastRefresh = 0
export const BRIDGE_WS_LIMITS = Object.freeze({
  maxPayloadBytes: 32 * 1024 * 1024,
  maxBrowserMessageBytes: 256 * 1024,
})

async function refreshDefaultObserverClock() {
  if (defaultObserverClockRefresh) return defaultObserverClockRefresh
  defaultObserverClockRefresh = getDefaultObserverSourceClock()
    .then(clock => {
      defaultObserverClockLastRefresh = Date.now()
      defaultObserverClockCache = clock ? {
        ...clock,
        clock_status:clock.source_clock_status,
      } : null
      return defaultObserverClockCache
    })
    .catch(error => {
      defaultObserverClockLastRefresh = Date.now()
      console.warn('[BridgeWS] Default observer clock refresh failed:', error.message)
      return defaultObserverClockCache
    })
    .finally(() => { defaultObserverClockRefresh = null })
  return defaultObserverClockRefresh
}

function observerQuoteTradeMode(quote) {
  const explicit = Number(quote?.symbol_trade_mode)
  if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 4) return explicit
  const marketState = String(quote?.market_state || '').toLowerCase()
  if (marketState === 'open') return 4
  if (marketState === 'closed' || marketState === 'stale') return 0
  if (marketState === 'restricted') return 3
  return -1
}

const observerQuoteFeeds = createObserverQuoteFeedManager({
  intervalMs:OBSERVER_QUOTE_INTERVAL_MS,
  freshMs:OBSERVER_QUOTE_FRESH_MS,
  fetchQuote:async descriptor => {
    if (!isBridgeAlive(descriptor.sourceUserId)) {
      return { status:'error', code:'observer_source_offline', message:'observer_source_offline' }
    }
    const ai = await import('./routes/ai/index.js')
    const params = {
      symbol:descriptor.symbol,
      ...(descriptor.terminalInstanceId ? {
        terminal_instance_id:descriptor.terminalInstanceId,
        account_ref:descriptor.accountRef,
      } : {}),
    }
    const quote = await ai.mt5Bridge(descriptor.sourceUserId, 'quote', params, { noFallback:true })
    if (quote?.status === 'success') recordBridgeMarketState(descriptor.sourceUserId, quote, Date.now(), {
      terminalInstanceId:descriptor.terminalInstanceId,
      tradingAccountId:descriptor.tradingAccountId,
    })
    return quote
  },
  publish:(ws, quote) => {
    if (ws?.readyState !== 1) return false
    ws.send(JSON.stringify({
      type: 'platform_market_tick',
      quote,
      trade_mode:observerQuoteTradeMode(quote),
      _source:'observer_quote_feed',
    }))
    return true
  },
})

export function wsMessageByteLength(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8')
  if (Buffer.isBuffer(data)) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  return Buffer.byteLength(String(data ?? ''), 'utf8')
}

export function isAllowedBrowserWsOrigin(req, type) {
  if (type !== 'browser' && type !== 'admin') return true
  const origin = String(req?.headers?.origin || '').trim()
  if (!origin) return false
  return isCorsOriginAllowed(origin, CORS_ORIGINS)
}

function hasAccountBridgeConnection(userId, accountId) {
  const numericUserId = Number(userId)
  const numericAccountId = Number(accountId)
  const connectedIds = new Set((bridgeV3Business?.connectedTerminals(numericUserId) || [])
    .map(route => route.terminal_instance_id))
  const bindings = bridgeV3TradingAccounts.get(numericUserId)
  return [...(bindings || [])].some(([terminalId, boundAccountId]) =>
    connectedIds.has(terminalId) && Number(boundAccountId) === numericAccountId)
}

function bridgeV3RouteForAccount(userId, accountId) {
  const bindings = bridgeV3TradingAccounts.get(Number(userId))
  return (bridgeV3Business?.connectedTerminals(Number(userId)) || []).find(route =>
    Number(bindings?.get(route.terminal_instance_id) || 0) === Number(accountId)) || null
}

function bridgeV3RouteForContext(userId, tradingAccountId = null) {
  const numericUserId = Number(userId)
  if (tradingAccountId) {
    const accountRoute = bridgeV3RouteForAccount(numericUserId, tradingAccountId)
    if (accountRoute) return accountRoute
  }
  const routes = bridgeV3Business?.connectedTerminals(numericUserId) || []
  if (routes.length === 1) return routes[0]
  const preferredTerminal = bridgeV3PreferredTerminals.get(numericUserId)
  return routes.find(route => route.terminal_instance_id === preferredTerminal) || null
}

export function getBridgeDataRoute(userId, tradingAccountId = null, { strictAccount = false } = {}) {
  if (strictAccount && Number(tradingAccountId) > 0) {
    return bridgeV3RouteForAccount(userId, tradingAccountId)
  }
  return bridgeV3RouteForContext(userId, tradingAccountId)
}

function bridgeRouteParams(route) {
  return route ? {
    terminal_instance_id:route.terminal_instance_id,
    account_ref:route.account_ref,
  } : {}
}

function bridgeTerminalIdentityKey(userId, terminalInstanceId) {
  return `${Number(userId)}:${String(terminalInstanceId || '').trim()}`
}

export function buildBridgeTerminalIdentity({ userId, terminal, accountId } = {}) {
  return {
    userId:Number(userId),
    terminal_instance_id:String(terminal?.terminal_instance_id || '').trim(),
    broker_server:String(terminal?.account_ref?.broker_server || '').trim().toUpperCase(),
    login:String(terminal?.account_ref?.login || '').trim(),
    trading_account_id:Number(accountId) || null,
  }
}

export function classifyBridgeIdentityEvent(previous, current) {
  if (!previous) return 'account_switched'
  const same = String(previous.terminal_instance_id || '')
    === String(current?.terminal_instance_id || '')
    && String(previous.broker_server || '').trim().toUpperCase()
      === String(current?.broker_server || '').trim().toUpperCase()
    && String(previous.login || '').trim() === String(current?.login || '').trim()
    && Number(previous.trading_account_id || 0) === Number(current?.trading_account_id || 0)
  return same ? 'bridge_reconnected' : 'account_switched'
}

function observerQuoteDescriptor(dataUserId, observerContext, dataRoute, symbol) {
  return {
    sourceUserId:Number(dataUserId),
    tradingAccountId:Number(observerContext?.channel?.trading_account_id) || null,
    terminalInstanceId:dataRoute?.terminal_instance_id || null,
    accountRef:dataRoute?.account_ref || null,
    symbol:String(symbol || '').trim().toUpperCase(),
  }
}

function bridgePlatform(userId, tradingAccountId = null) {
  const route = bridgeV3RouteForContext(userId, tradingAccountId)
  return route?.platform || null
}

// Prepare the default platform range as part of terminal readiness.  This
// deliberately reuses the existing exact-range history_page/history action;
// the Bridge planner decides whether coverage subtraction makes the request a
// no-op.  No legacy date-only/full-history fallback is allowed here.
async function preparePlatformHistoryOnTerminalReady(userId, route, accountId) {
  if (!hasHistoryExactRangeCapability(route) || !bridgeV3Business?.execute) {
    return { status:'skipped', reason:'history_exact_range_unsupported' }
  }
  const key = `${Number(userId)}:${Number(accountId) || 0}:${String(route.terminal_instance_id || '')}`
  const existing = historyPlatformPrepareJobs.get(key)
  if (existing) return existing
  const task = (async () => {
    const nowUtcMsc = Date.now()
    const range = await resolveHistoryRange(Number(userId), { history_scope:'platform' }, route, nowUtcMsc)
    const cursorMode = hasHistoryCursorCapability(route)
    const prepareStatusMode = hasHistoryPrepareStatusCapability(route)
    const params = {
      ...(prepareStatusMode ? {} : { page_size:normalizeBridgePageSize(20) }),
      range_start_utc_msc:range.range_start_utc_msc,
      range_end_utc_msc:range.range_end_utc_msc,
      allowed_start_utc_msc:range.allowed_start_utc_msc,
      system_start_utc_msc:range.system_start_utc_msc,
      effective_start_utc_msc:range.effective_start_utc_msc,
      captured_end_utc_msc:range.captured_end_utc_msc,
      ...(prepareStatusMode ? {} : { force_refresh:true }),
      terminal_instance_id:route.terminal_instance_id,
      account_ref:route.account_ref,
    }
    const action = prepareStatusMode
      ? 'history_prepare_status_v1'
      : (cursorMode ? 'history_page' : 'history')
    const result = await bridgeV3Business.execute(Number(userId), action, params, {
      timeoutMs:prepareStatusMode ? 5_000 : 30_000,
      noFallback:true,
    })
    return { status:result?.status || 'error', history_range:range,
      error:result?.error || result?.code || null }
  })()
  historyPlatformPrepareJobs.set(key, task)
  try {
    return await task
  } finally {
    historyPlatformPrepareJobs.delete(key)
  }
}

function queueIncompleteRiskSnapshotRefresh(userId, ai, delayMs = 250) {
  const numericUserId = Number(userId)
  const existing = riskSnapshotRefreshTimers.get(numericUserId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    riskSnapshotRefreshTimers.delete(numericUserId)
    ai.refreshIncompleteRiskAccounts(numericUserId).then(result => {
      if (Number(result?.refreshed || 0) <= 0) return
      broadcastAdminEvent('risk', 'snapshot_refreshed', {
        user_id:numericUserId,
        refreshed:Number(result.refreshed),
      }, { scopes:['risk-audit'], refresh:true })
    }).catch(error => {
      console.warn(`[RiskSnapshot] Background refresh failed user=${numericUserId}:`, error.message)
    })
  }, Math.max(0, Number(delayMs) || 0))
  timer.unref?.()
  riskSnapshotRefreshTimers.set(numericUserId, timer)
}

async function synchronizeBridgeV3TerminalIdentity({ userId, terminal, connectionGeneration }) {
  const route = (bridgeV3Business?.connectedTerminals(Number(userId)) || [])
    .find(item => item.terminal_instance_id === terminal.terminal_instance_id
      && Number(item.connection_generation) === Number(connectionGeneration))
  if (!route) return
  broadcastAdminEvent('bridge', 'connected', {
    user_id:Number(userId),
    connected:true,
    alive:true,
    platform:route.platform,
    terminal_instance_id:route.terminal_instance_id,
  }, { scopes:['overview', 'users', 'ai-operations', 'risk-audit'] })
  const account = await bridgeV3Business.execute(Number(userId), 'account', {
    terminal_instance_id:terminal.terminal_instance_id,
    account_ref:terminal.account_ref,
  }, { timeoutMs:5_000 })
  if (account?.status !== 'success' || !account.server || account.login === undefined) {
    throw new Error(account?.message || account?.error || 'bridge_v3_identity_unavailable')
  }
  const ai = await import('./routes/ai/index.js')
  const identity = await ai.syncTradingAccountIdentity(Number(userId), account)
  let bindings = bridgeV3TradingAccounts.get(Number(userId))
  if (!bindings) {
    bindings = new Map()
    bridgeV3TradingAccounts.set(Number(userId), bindings)
  }
  bindings.set(terminal.terminal_instance_id, identity.accountId)
  bridgeV3PreferredTerminals.set(Number(userId), terminal.terminal_instance_id)
  if (identity.verified) {
    // Keep readiness independent from archive latency: the preparation is a
    // bounded background flight and never delays identity or risk setup.
    preparePlatformHistoryOnTerminalReady(Number(userId), route, identity.accountId)
      .catch(error => {
        // A history preparation failure must not tear down a healthy terminal;
        // the on-demand exact-range request will return the stable error and
        // can retry the missing window later.
        console.warn(`[BridgeV3] platform history preparation failed user=${userId} account=${identity.accountId}:`, error.message)
      })
    queueIncompleteRiskSnapshotRefresh(userId, ai)
  }
  const latestIdentityKey = bridgeTerminalIdentityKey(userId, terminal.terminal_instance_id)
  const currentIdentity = buildBridgeTerminalIdentity({
    userId, terminal, accountId:identity.accountId,
  })
  const previousIdentity = bridgeV3LatestTerminalIdentities.get(latestIdentityKey) || null
  bridgeV3LatestTerminalIdentities.set(latestIdentityKey, currentIdentity)
  const identityEventType = identity.ownershipTransferred
    ? 'account_switched'
    : classifyBridgeIdentityEvent(previousIdentity, currentIdentity)
  const identityEvent = {
    account:{ id:identity.accountId, server:account.server, login:account.login },
    switched:identityEventType === 'account_switched' && Boolean(identity.switched || previousIdentity),
    ownership_transferred:Boolean(identity.ownershipTransferred),
    verified:Boolean(identity.verified),
    anomaly_code:identity.anomalyCode || null,
  }
  sendToBrowsers(Number(userId), identityEventType === 'account_switched'
    ? { ...identityEvent, type:'account_switched' }
    : { ...identityEvent, type:'bridge_reconnected' })
  for (const previousUserId of identity.previousOwnerUserIds || []) {
    sendToBrowsers(previousUserId, {
      type:'account_transferred',
      account:{ server:account.server, login:account.login },
      reason:'new_trade_authorized_bridge_connected',
    })
    await ai.stopAutoScheduler(previousUserId).catch(() => {})
    await ai.removeUserRuntimeAutoSubscription(previousUserId).catch(() => {})
    if (bridgeV3Business?.hasConnectedTerminal(Number(previousUserId))) {
      await bridgeV3Business.execute(Number(previousUserId), 'toggle_trade', { enable:false })
      bridgeV3Business.disconnectUser(Number(previousUserId), 'bridge_account_ownership_transferred')
    }
  }
}

async function forgetBridgeV3TerminalIdentity({ userId, terminal }) {
  const bindings = bridgeV3TradingAccounts.get(Number(userId))
  bindings?.delete(terminal.terminal_instance_id)
  if (bindings?.size === 0) bridgeV3TradingAccounts.delete(Number(userId))
  const marketStates = bridgeV3UserMarketStates(Number(userId))
  marketStates?.delete(terminal.terminal_instance_id)
  if (marketStates?.size === 0) bridgeV3MarketStates.delete(Number(userId))
  if (bridgeV3PreferredTerminals.get(Number(userId)) === terminal.terminal_instance_id) {
    const replacement = (bridgeV3Business?.connectedTerminals(Number(userId)) || [])
      .find(route => route.terminal_instance_id !== terminal.terminal_instance_id)
    if (replacement) bridgeV3PreferredTerminals.set(Number(userId), replacement.terminal_instance_id)
    else bridgeV3PreferredTerminals.delete(Number(userId))
  }
  broadcastAdminEvent('bridge', 'disconnected', {
    user_id:Number(userId),
    connected:isBridgeAlive(Number(userId)),
    alive:isBridgeAlive(Number(userId)),
    platform:terminal.platform,
    terminal_instance_id:terminal.terminal_instance_id,
  }, { scopes:['overview', 'users', 'ai-operations', 'risk-audit'] })
  if (!isBridgeAlive(Number(userId))) {
    const ai = await import('./routes/ai/index.js')
    await Promise.allSettled([
      ai.stopAutoScheduler(Number(userId)),
      ai.removeUserRuntimeAutoSubscription(Number(userId)),
    ])
  }
}

const TRADE_REF_KEYS = new Set([
  'ticket', 'order', 'order_id', 'order_ticket', 'position', 'position_id',
  'position_ticket', 'deal', 'deal_id', 'deal_ticket', 'trade_ticket', 'pending_ticket'
])

function addTradeRef(refs, value) {
  if (value === null || value === undefined || value === '') return
  const normalized = String(value).trim()
  if (normalized && normalized !== '0') refs.add(normalized)
}

function collectTradeRefsFromValue(value, refs, depth = 0) {
  if (!value || depth > 4) return
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return
    try { collectTradeRefsFromValue(JSON.parse(trimmed), refs, depth + 1) } catch {}
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTradeRefsFromValue(item, refs, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (TRADE_REF_KEYS.has(key.toLowerCase())) addTradeRef(refs, item)
    if (item && typeof item === 'object') collectTradeRefsFromValue(item, refs, depth + 1)
  }
}

export function collectTradeRefs(record) {
  const refs = new Set()
  collectTradeRefsFromValue(record, refs)
  if (record?.execution_result) collectTradeRefsFromValue(record.execution_result, refs)
  return [...refs]
}

export function buildSignalRefIndex(rows, toSignal = row => row) {
  const index = new Map()
  for (const row of rows || []) {
    const signal = toSignal(row)
    for (const ref of collectTradeRefs(row)) {
      if (!index.has(ref)) index.set(ref, [])
      const bucket = index.get(ref)
      if (!bucket.some(item => String(item.id) === String(signal.id))) bucket.push(signal)
    }
  }
  return index
}

const SIGNAL_PENDING_ACTIONS = new Set([
  'ai_cancel_pending',
  'ai_cancel_pending_failed',
  'pending_superseded',
  'pending_supersede_failed',
])

const SIGNAL_PENDING_ACTION_ALIASES = new Map([
  ['AI 取消挂单', 'ai_cancel_pending'],
  ['AI 取消挂单失败', 'ai_cancel_pending_failed'],
  ['旧挂单已替换', 'pending_superseded'],
  ['旧挂单替换失败', 'pending_supersede_failed'],
])

function parseAuditPayload(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return {} }
}

export function buildSignalPendingActions(rows = [], executionResult = null) {
  const actions = rows
    .map(row => ({ ...row, action:SIGNAL_PENDING_ACTION_ALIASES.get(String(row?.action || '')) || String(row?.action || '') }))
    .filter(row => SIGNAL_PENDING_ACTIONS.has(row.action))
    .map(row => {
      const request = parseAuditPayload(row.request_json ?? row.request)
      const result = parseAuditPayload(row.result_json ?? row.result)
      const failed = String(row.action).endsWith('_failed') || ['error', 'failed'].includes(String(row.status || result.status || '').toLowerCase())
      const superseded = row.action === 'pending_superseded'
      return {
        ticket: String(request.ticket ?? result.ticket ?? '').trim() || null,
        pending_type: String(request.pending_type || '').trim() || null,
        status: failed ? 'failed' : superseded ? 'superseded' : 'cancelled',
        reason: String(request.reason || '').trim() || null,
        message: failed ? String(request.error || result.message || result.error || '').trim() || null : null,
        created_at: row.created_at || null,
      }
    })
  const execution = parseAuditPayload(executionResult)
  const reason = String(execution.reason || '')
  if (reason === 'pending_cancelled' && !actions.some(action => action.status === 'cancelled')) {
    actions.push({
      ticket:null,
      pending_type:null,
      status:'cancelled',
      count:Number(execution.details?.count || 0),
      reason:String(execution.details?.pending_action_reason || '').trim() || '策略判断原挂单逻辑已经失效，系统已取消当前策略对应的挂单',
      message:null,
      created_at:null,
    })
  } else if (reason === 'pending_cancel_failed' && !actions.some(action => action.status === 'failed')) {
    actions.push({
      ticket:String(execution.details?.ticket || '').trim() || null,
      pending_type:null,
      status:'failed',
      count:0,
      reason:null,
      message:'取消当前策略挂单失败，本次未继续执行',
      created_at:null,
    })
  }
  return actions.slice(0, 20)
}

async function loadSignalPendingActions(userId, signalId, executionResult = null) {
  try {
    const rows = await queryAll(
      `SELECT action, request_json, result_json, status, created_at
       FROM trade_audit_logs
       WHERE user_id = ?
         AND JSON_VALID(request_json)
         AND CAST(JSON_UNQUOTE(JSON_EXTRACT(request_json, '$.signal_id')) AS UNSIGNED) = ?
       ORDER BY id ASC
       LIMIT 20`,
      [userId, signalId]
    )
    return buildSignalPendingActions(rows, executionResult)
  } catch (error) {
    console.warn(`[SignalDetail] Failed to load pending actions for signal ${signalId}:`, error.message)
    return []
  }
}

export function normalizeBridgeMarketState(payload, receivedAt = Date.now()) {
  if (Number(payload?.market_state_version) !== 1) return null
  const state = String(payload?.market_state || '').toLowerCase()
  if (!['open', 'closed', 'restricted', 'stale', 'unknown'].includes(state)) return null
  const optionalNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
  const symbolTradeMode = optionalNumber(payload?.symbol_trade_mode)
  const tradeMode = state === 'open' ? 4
    : state === 'closed' ? 0
      : state === 'restricted' && [1, 2, 3].includes(symbolTradeMode) ? symbolTradeMode : -1
  const reasons = {
    open: 'market_open', closed: 'market_closed', restricted: 'market_restricted',
    stale: 'market_stale_tick', unknown: 'market_unknown',
  }
  return {
    state, reason: reasons[state], detailReason: String(payload.market_reason || ''), tradeMode,
    symbolTradeMode: symbolTradeMode ?? -1,
    symbol: String(payload.symbol || ''), terminalConnected: payload.terminal_connected !== false,
    tickProgressing: Boolean(payload.tick_progressing),
    tickUnchangedSeconds: optionalNumber(payload.tick_unchanged_seconds),
    tickAgeSeconds: optionalNumber(payload.tick_age_seconds),
    checkedAtUtcMsc: optionalNumber(payload.market_checked_at_utc_msc),
    receivedAt,
  }
}

function applyBridgeMarketState(bridge, payload, userId, receivedAt = Date.now()) {
  if (!bridge) return null
  const offsetValue = payload.timezone_offset_minutes
  const offset = offsetValue !== null && offsetValue !== undefined && offsetValue !== ''
    && Number.isFinite(Number(offsetValue)) ? Number(offsetValue) : null
  if (Number.isInteger(offset) && offset >= -840 && offset <= 840) {
    bridge.timezoneOffsetMinutes = offset
  }
  if (typeof payload.clock_status === 'string' && payload.clock_status.trim()) {
    bridge.clockStatus = payload.clock_status.trim().slice(0, 64)
  }
  const residualValue = payload.clock_residual_ms
  const residual = residualValue !== null && residualValue !== undefined && residualValue !== ''
    && Number.isFinite(Number(residualValue)) ? Number(residualValue) : null
  if (residual !== null) bridge.clockResidualMs = residual
  const terminalTime = payload?.quote?.time || payload?.time || payload?.last_quote_time || null
  if (terminalTime) {
    bridge.mt5TimeStr = String(terminalTime)
    bridge.lastTickMs = receivedAt
  }
  const observedAtValue = payload?.quote?.observed_at_utc_msc ?? payload?.observed_at_utc_msc
  const observedAtUtcMsc = Number(observedAtValue)
  if (Number.isFinite(observedAtUtcMsc) && observedAtUtcMsc > 0) {
    bridge.observedAtUtcMsc = observedAtUtcMsc
  } else if (terminalTime) {
    bridge.observedAtUtcMsc = null
  }
  const normalized = normalizeBridgeMarketState(payload, receivedAt)
  if (!normalized) return null
  const previous = bridge.marketState?.state
  bridge.marketState = normalized
  if (!bridge.marketStates) bridge.marketStates = new Map()
  if (normalized.symbol) bridge.marketStates.set(stripBrokerSuffix(normalized.symbol), normalized)
  bridge.lastTradeMode = normalized.tradeMode
  if (previous && previous !== normalized.state) {
    console.log(`[BridgeWS] User ${userId}: market ${previous} -> ${normalized.state} (${normalized.detailReason || normalized.reason})`)
    broadcastAdminEvent('market', 'state_changed', {
      user_id: Number(userId),
      market_state: normalized.state,
      trade_mode: normalized.tradeMode,
      symbol: normalized.symbol || null,
      reason: normalized.detailReason || normalized.reason,
    }, { scopes:['overview', 'ai-operations', 'risk-audit'] })
  }
  return normalized
}

export function buildBrowserHeartbeatClock(sharedQuote, clockBridge, marketState, effectiveClock = null) {
  const clockSource = sharedQuote?.time
    ? { time:sharedQuote.time, observedAtUtcMsc:sharedQuote.observed_at_utc_msc }
    : clockBridge?.mt5TimeStr
      ? { time:clockBridge.mt5TimeStr, observedAtUtcMsc:clockBridge.observedAtUtcMsc }
      : marketState?.mt5TimeStr
        ? { time:marketState.mt5TimeStr, observedAtUtcMsc:marketState.observedAtUtcMsc }
        : null
  const observedAtValue = Number(clockSource?.observedAtUtcMsc)
  const heartbeatClock = {
    mt5_time:clockSource?.time || null,
    observed_at_utc_msc:Number.isFinite(observedAtValue) && observedAtValue > 0
      ? observedAtValue : null,
    timezone_offset_minutes:sharedQuote?.timezone_offset_minutes
      ?? clockBridge?.timezoneOffsetMinutes ?? marketState?.timezoneOffsetMinutes ?? null,
    clock_status:sharedQuote?.clock_status
      || clockBridge?.clockStatus || marketState?.clockStatus || 'unknown',
  }
  if (trustedTerminalClock(heartbeatClock) || !trustedTerminalClock(effectiveClock)) {
    return heartbeatClock
  }
  return {
    ...heartbeatClock,
    timezone_offset_minutes:Number(effectiveClock.timezone_offset_minutes),
    clock_status:String(effectiveClock.clock_status),
    clock_source:effectiveClock.clock_source || null,
    source_clock_status:effectiveClock.source_clock_status || null,
    source_id:Number(effectiveClock.source_id) || null,
    source_last_calibrated_at_utc_msc:
      Number(effectiveClock.source_last_calibrated_at_utc_msc) || null,
  }
}

function bridgeV3UserMarketStates(userId, create = false) {
  const numericUserId = Number(userId)
  let states = bridgeV3MarketStates.get(numericUserId)
  if (!states && create) {
    states = new Map()
    bridgeV3MarketStates.set(numericUserId, states)
  }
  return states || null
}

function bridgeV3MarketStateForContext(userId, tradingAccountId = null, terminalInstanceId = null) {
  const states = bridgeV3UserMarketStates(userId)
  if (!states) return null
  const route = terminalInstanceId
    ? { terminal_instance_id:String(terminalInstanceId) }
    : bridgeV3RouteForContext(userId, tradingAccountId)
  if (route?.terminal_instance_id && states.has(route.terminal_instance_id)) {
    return states.get(route.terminal_instance_id)
  }
  return states.size === 1 ? states.values().next().value : null
}

export function recordBridgeMarketState(userId, payload, receivedAt = Date.now(), context = {}) {
  const numericUserId = Number(userId)
  if (!bridgeV3Business?.hasConnectedTerminal(numericUserId)) return null
  const route = context.terminalInstanceId
    ? { terminal_instance_id:String(context.terminalInstanceId) }
    : bridgeV3RouteForContext(numericUserId, context.tradingAccountId)
  if (!route?.terminal_instance_id) return null
  const states = bridgeV3UserMarketStates(numericUserId, true)
  const state = states.get(route.terminal_instance_id) || { marketStates:new Map() }
  states.set(route.terminal_instance_id, state)
  return applyBridgeMarketState(state, payload, numericUserId, receivedAt)
}

const _broadcastThrottle = new Map() // userId -> lastBroadcastTime (定期清理防内存泄漏)

// 每 10 分钟清理超过 30 秒未使用的广播节流条目
setInterval(() => {
  const cutoff = Date.now() - 30000
  for (const [uid, last] of _broadcastThrottle) {
    if (last < cutoff) _broadcastThrottle.delete(uid)
  }
  for (const [key, last] of adminEventThrottle) {
    if (last < cutoff) adminEventThrottle.delete(key)
  }
}, 10 * 60 * 1000)

async function getAdminUserId() {
  const now = Date.now()
  if ((now - adminUserIdLastCheck) < ADMIN_CACHE_TTL) return adminUserId
  const row = await queryOne('SELECT id FROM users WHERE role = ? ORDER BY id LIMIT 1', ['admin'])
  adminUserId = row?.id || null
  adminUserIdLastCheck = now
  return adminUserId
}

export async function getActivePlatformBridgeUserId() {
  const channelSource = await getDefaultObserverSource().catch(error => {
    // Compatibility for deployments where migration 118 has not run yet.
    if (!String(error?.message || '').includes("doesn't exist")) {
      console.error('[BridgeWS] default observer channel lookup failed:', error.message)
    }
    return null
  })
  if (channelSource?.bridge_user_id) {
    const channelUserId = Number(channelSource.bridge_user_id)
    // A configured channel is authoritative. Never silently show another
    // account when its source is offline.
    const tradingAccountId = Number(channelSource.trading_account_id) || null
    return (tradingAccountId
      ? hasAccountBridgeConnection(channelUserId, tradingAccountId)
      : isBridgeAlive(channelUserId)) ? channelUserId : null
  }
  const configured = await queryOne(`SELECT value FROM system_config
    WHERE category = 'market_data' AND \`key\` = 'platform_market_bridge_user_id' LIMIT 1`).catch(() => null)
  const configuredId = Number(configured?.value)
  if (configuredId > 0 && isBridgeAlive(configuredId)) {
    const configuredUser = await queryOne('SELECT role FROM users WHERE id = ?', [configuredId]).catch(() => null)
    if (configuredUser?.role === 'admin') return configuredId
  }
  const cachedAdminId = await getAdminUserId()
  if (cachedAdminId && isBridgeAlive(cachedAdminId)) return cachedAdminId
  const connectedIds = getAllBridges().filter(item => item.alive).map(item => Number(item.userId))
  if (!connectedIds.length) return null
  const rows = await queryAll(`SELECT id FROM users WHERE role = 'admin' AND id IN (${connectedIds.map(() => '?').join(',')}) ORDER BY id`, connectedIds)
  return rows[0]?.id || null
}

async function resolveObserverBridgeContext(userId, user, requestedChannelId = null, { strict = true } = {}) {
  let channel
  try {
    channel = await resolveObserverSourceForUser(userId, user?.plan, requestedChannelId)
  } catch (error) {
    if (strict) throw error
    return { bridgeUserId:null, channel:null, error:String(error?.message || 'observer_channel_access_denied') }
  }
  if (channel) {
    const bridgeUserId = Number(channel.bridge_user_id)
    return {
      bridgeUserId:isBridgeAlive(bridgeUserId) ? bridgeUserId : null,
      channel:{ id:Number(channel.id), name:channel.name, slug:channel.slug,
        source_id:Number(channel.source_id), source_name:channel.source_name,
        trading_account_id:Number(channel.trading_account_id) || null,
        strategy_id:Number(channel.strategy_id) || null },
    }
  }
  return { bridgeUserId:null, channel:null }
}

async function readAutomaticAnalysisEnabled(userId) {
  const numericUserId = Number(userId)
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) return undefined
  try {
    const subscription = await queryOne(`SELECT id FROM strategy_subscriptions
      WHERE user_id = ? AND is_deleted = 0 AND execution_enabled = 1
      ORDER BY updated_at DESC, id DESC LIMIT 1`, [numericUserId])
    return Boolean(subscription)
  } catch (error) {
    console.warn(`[BridgeWS] Failed to read automatic-analysis state user=${numericUserId}:`, error.message)
    return undefined
  }
}

function canUseDefaultPlatformMarketSource(user) {
  return String(user?.role || '').toLowerCase() === 'user'
    && String(user?.plan_source || '').toLowerCase() !== 'observer_source'
}

async function resolveDefaultPlatformMarketContext(user, symbol) {
  if (!canUseDefaultPlatformMarketSource(user)) return { eligible:false, supported:false }
  const source = await getDefaultObserverSource().catch(() => null)
  if (!source) return { eligible:true, configured:false, supported:false }
  const supported = observerSourceSupportsSymbol(source, symbol)
  const bridgeUserId = Number(source.bridge_user_id) || null
  const tradingAccountId = Number(source.trading_account_id) || null
  const dataRoute = supported && bridgeUserId
    ? getBridgeDataRoute(bridgeUserId, tradingAccountId, { strictAccount:true }) : null
  return {
    eligible:true,
    configured:true,
    supported,
    alive:Boolean(supported && bridgeUserId && (tradingAccountId
      ? hasAccountBridgeConnection(bridgeUserId, tradingAccountId)
      : isBridgeAlive(bridgeUserId))),
    bridgeUserId,
    dataRoute,
    source,
  }
}

export function getPlatformMarketClockState(userId, tradingAccountId = null, terminalInstanceId = null) {
  const numericUserId = Number(userId)
  const route = terminalInstanceId
    ? (bridgeV3Business?.connectedTerminals(numericUserId) || [])
      .find(item => item.terminal_instance_id === String(terminalInstanceId))
    : getBridgeDataRoute(numericUserId, tradingAccountId, {
      strictAccount:Number(tradingAccountId) > 0,
    })
  const userConnection = bridgeV3Business?.connectedUsers?.()
    .find(item => Number(item.userId) === numericUserId)
  const marketState = bridgeV3MarketStateForContext(
    numericUserId, tradingAccountId, route?.terminal_instance_id) || {}
  return applyDefaultObserverClockBootstrap({
    bridge_user_id:numericUserId || null,
    connected:Boolean(route),
    timezone_offset_minutes:marketState.timezoneOffsetMinutes ?? null,
    clock_status:marketState.clockStatus || 'unknown',
    clock_residual_ms:marketState.clockResidualMs ?? null,
    last_seen_at_utc_msc:userConnection?.lastSeen || null,
    broker_server:route?.account_ref?.broker_server || null,
    account_login:route?.account_ref?.login || null,
    platform:String(route?.platform || bridgePlatform(numericUserId, tradingAccountId) || '').trim().toLowerCase() || null,
  }, defaultObserverClockCache)
}

export async function getEffectivePlatformMarketClockState(userId, tradingAccountId = null, terminalInstanceId = null) {
  const current = getPlatformMarketClockState(userId, tradingAccountId, terminalInstanceId)
  if (trustedTerminalClock(current)) return current
  if (!defaultObserverClockCache
    || Date.now() - defaultObserverClockLastRefresh > 60_000) await refreshDefaultObserverClock()
  return getPlatformMarketClockState(userId, tradingAccountId, terminalInstanceId)
}

export function initBridgeWS(server) {
  // Cache admin userId at startup
  getAdminUserId().catch(() => {})
  defaultObserverClockCache = null
  defaultObserverClockLastRefresh = 0
  refreshDefaultObserverClock().catch(() => {})
  wss = new WebSocketServer({ noServer: true, maxPayload: BRIDGE_WS_LIMITS.maxPayloadBytes })
  const v3Gateway = createBridgeV3Gateway({
    onTerminalReady:synchronizeBridgeV3TerminalIdentity,
    onTerminalDisconnected:forgetBridgeV3TerminalIdentity,
    onDataDelta:notifyBridgeV3DataChanged,
  })
  setBridgeReleaseNotifier(release => v3Gateway.broadcastReleaseAvailable(release))
  bridgeV3Business = createBridgeV3BusinessAdapter({ gateway:v3Gateway })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    const type = url.searchParams.get('type')
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress

    if (url.pathname === BRIDGE_V3_WS_PATH) {
      try {
        v3Gateway.handleUpgrade(req, socket, head)
      } catch (error) {
        console.error(`[BridgeV3] upgrade failed ip=${ip} error=${error.message}`)
        try { socket.destroy() } catch {}
      }
    } else if (url.pathname === '/aurum-api/bridge/ws') {
      if (type === 'bridge') {
        const body = 'This Bridge endpoint is retired. Update via /api/bridge/version.\n'
        const response = [
          'HTTP/1.1 426 Upgrade Required',
          'Connection: close',
          'Content-Type: text/plain; charset=utf-8',
          'Link: </api/bridge/version>; rel="update"',
          `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
          '',
          body,
        ].join('\r\n')
        try {
          if (typeof socket.end === 'function') socket.end(response)
          else {
            socket.write(response)
            socket.destroy()
          }
        } catch {}
        return
      }
      if (type !== 'browser' && type !== 'admin') {
        try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } catch {}
        try { socket.destroy() } catch {}
        return
      }
      if (!isAllowedBrowserWsOrigin(req, type)) {
        console.warn(`[BridgeWS] rejected ${type || 'unknown'} websocket origin`)
        try { socket.write?.('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') } catch {}
        socket.destroy()
        return
      }
      if (process.env.DEBUG_BRIDGE_WS === '1') {
        console.log(`[BridgeWS] upgrade path=/aurum-api/bridge/ws type=${type} ip=${ip}`)
      }
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req)
        })
      } catch (e) {
        console.error(`[BridgeWS] upgrade failed path=/aurum-api/bridge/ws type=${type} ip=${ip} error=${e.message}`)
        try { socket.destroy() } catch {}
      }
    } else {
      socket.destroy()
    }
  })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const type = url.searchParams.get('type')

    if (type === 'admin') return handleAdmin(ws, url, req)
    if (type === 'browser') return handleBrowser(ws, url, req)
    ws.close(4000, 'Unknown type')
  })


  return wss
}

function readCookie(req, name) {
  const raw = String(req?.headers?.cookie || '')
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    try { return decodeURIComponent(part.slice(index + 1).trim()) } catch { return '' }
  }
  return ''
}

export function browserSessionToken(req, url) {
  const cookieToken = readCookie(req, 'ws_token')
  if (cookieToken) return cookieToken
  return process.env.ALLOW_LEGACY_WS_QUERY_TOKEN === '1' ? url.searchParams.get('token') : null
}

// ============ Admin Console Connection ============

async function handleAdmin(ws, url, req) {
  const token = browserSessionToken(req, url)
  if (!token) {
    console.warn('[BridgeWS] Admin websocket auth failed: ws_token cookie missing')
    ws.close(4002, 'Session cookie required')
    return
  }
  let decoded = null
  try { decoded = jwt.verify(token, JWT_SECRET) } catch (e) { console.error('[BridgeWS] Admin JWT verify failed:', e.message) }
  const userId = decoded?.userId
  if (!userId) { ws.close(4002, 'Invalid token'); return }

  const user = await queryOne('SELECT id, role, token_version FROM users WHERE id = ?', [userId]).catch(() => null)
  if (!tokenVersionMatches(decoded, user) || String(user?.role || '').toLowerCase() !== 'admin') {
    ws.close(4003, 'Admin access required')
    return
  }

  ws._userId = Number(userId)
  adminBrowsers.add(ws)
  const send = payload => {
    if (ws.readyState !== 1) return false
    try { ws.send(JSON.stringify(payload)); return true } catch { return false }
  }
  const bridgesSnapshot = getBridgeDiagnostics()
  send({
    type:'admin_ready',
    protocol:1,
    user_id:Number(userId),
    server_time:new Date().toISOString(),
    bridge_count:bridgesSnapshot.length,
    bridges:bridgesSnapshot,
  })

  ws.on('message', data => {
    if (wsMessageByteLength(data) > BRIDGE_WS_LIMITS.maxBrowserMessageBytes) {
      ws.close(1009, 'Message too large')
      return
    }
    let msg
    try { msg = JSON.parse(data) } catch { return }
    if (msg.type === 'hb') {
      send({ type:'admin_pong', seq:msg.seq ?? null, server_time:new Date().toISOString() })
    } else if (msg.type === 'ping') {
      send({ type:'pong', ts:msg.ts ?? Date.now() })
    } else if (msg.type === 'subscribe') {
      send({
        type:'admin_subscribed',
        scopes:Array.isArray(msg.scopes) ? msg.scopes.filter(scope => typeof scope === 'string').slice(0, 20) : [],
      })
    }
  })

  const remove = () => adminBrowsers.delete(ws)
  ws.on('close', remove)
  ws.on('error', remove)
}

// ============ Browser Connection ============

async function handleBrowser(ws, url, req) {
  const token = browserSessionToken(req, url)
  if (!token) {
    console.warn('[BridgeWS] Browser websocket auth failed: ws_token cookie missing')
    ws.close(4002, 'Session cookie required')
    return
  }
  let decoded = null
  try { decoded = jwt.verify(token, JWT_SECRET) } catch (e) { console.error('[BridgeWS] Browser JWT verify failed:', e.message) }
  const userId = decoded?.userId
  if (!userId) { ws.close(4002, 'Invalid token'); return }
  const sessionUser = await queryOne(`SELECT id, token_version FROM users
    WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL`, [userId]).catch(() => null)
  if (!sessionUser || !tokenVersionMatches(decoded, sessionUser)) {
    ws.close(4002, 'Session revoked')
    return
  }

  // Register
  ws._userId = Number(userId)
  if (!browsers.has(userId)) browsers.set(userId, new Set())
  browsers.get(userId).add(ws)

  // Handle messages from browser
  ws.on('message', async (data) => {
    if (wsMessageByteLength(data) > BRIDGE_WS_LIMITS.maxBrowserMessageBytes) {
      ws.close(1009, 'Message too large')
      return
    }
    let msg
    try { msg = JSON.parse(data) } catch { return }

    if (msg.type === 'hb') {
      // Heartbeat uses the same access decision as command handling. Plus is
      // always an observer, even if an old bridge connection still exists.
      const accessUser = await queryOne('SELECT role, plan, plan_expires_at, plan_source FROM users WHERE id = ?', [userId]).catch(() => null)
      const access = buildAiAccessContext(accessUser, { ownBridgeConnected:isBridgeAlive(userId) })
      const observerContext = access.mode === 'observer'
        ? await resolveObserverBridgeContext(userId, accessUser, msg.observer_channel_id, { strict:false })
        : null
      const dataUserId = access.mode === 'observer' ? observerContext.bridgeUserId : access.mode === 'full' ? userId : null
      ws._observerBridgeUserId = access.mode === 'observer' ? Number(dataUserId) || null : null
      ws._observerStrategyId = access.mode === 'observer'
        ? Number(observerContext?.channel?.strategy_id || 0) || null : null
      const dataRoute = dataUserId ? bridgeV3RouteForContext(
        dataUserId, observerContext?.channel?.trading_account_id) : null
      let quoteClockUserId = dataUserId
      if (access.mode === 'observer' && ws._observerQuoteSymbol) {
        const descriptor = observerQuoteDescriptor(
          dataUserId, observerContext, dataRoute, ws._observerQuoteSymbol)
        if (!observerQuoteFeeds.matches(ws, descriptor)) observerQuoteFeeds.unsubscribe(ws)
      } else if (access.mode === 'full' && ws._sharedQuoteKind === 'default_market' && ws._observerQuoteSymbol) {
        const defaultMarket = await resolveDefaultPlatformMarketContext(accessUser, ws._observerQuoteSymbol)
        if (defaultMarket.supported && defaultMarket.alive) {
          quoteClockUserId = defaultMarket.bridgeUserId
          const descriptor = observerQuoteDescriptor(defaultMarket.bridgeUserId, {
            channel:{ trading_account_id:defaultMarket.source.trading_account_id },
          }, defaultMarket.dataRoute, ws._observerQuoteSymbol)
          if (!observerQuoteFeeds.matches(ws, descriptor)) observerQuoteFeeds.unsubscribe(ws)
        } else {
          observerQuoteFeeds.unsubscribe(ws)
          quoteClockUserId = null
        }
      } else {
        observerQuoteFeeds.unsubscribe(ws)
      }
      const sharedQuote = observerQuoteFeeds.latestFor(ws)
      const v3MarketState = quoteClockUserId ? bridgeV3MarketStateForContext(
        Number(quoteClockUserId), observerContext?.channel?.trading_account_id,
        dataRoute?.terminal_instance_id) : null
      const usingFallback = access.mode === 'observer'
      const connected = Boolean(dataUserId && isBridgeAlive(dataUserId))
      const alive = connected
      // In observer mode the visible switches describe the platform observer
      // account. Mutations remain blocked by the observer action allowlist.
      const tradeEnabled = alive ? isTradeEnabled(dataUserId) : undefined
      // The automatic-analysis switch belongs to the user's strategy
      // subscription and is independent from the terminal transport.
      const autoReasoningEnabled = access.mode === 'full'
        ? await readAutomaticAnalysisEnabled(userId)
        : alive ? await readAutomaticAnalysisEnabled(dataUserId) : undefined
      const effectiveClock = dataUserId ? await getEffectivePlatformMarketClockState(
        Number(dataUserId), observerContext?.channel?.trading_account_id,
        dataRoute?.terminal_instance_id) : null
      const heartbeatClock = buildBrowserHeartbeatClock(
        sharedQuote, null, v3MarketState, effectiveClock)
      ws.send(JSON.stringify({
        type: 'hb',
        seq: msg.seq,
        mt5_connected: connected,
        mt5_alive: alive,
        ...heartbeatClock,
        platform: dataRoute?.platform || bridgePlatform(
          dataUserId, observerContext?.channel?.trading_account_id),
        terminal_instance_id:dataRoute?.terminal_instance_id || null,
        using_fallback: usingFallback,
        trade_enabled: tradeEnabled,
        auto_reasoning_enabled: autoReasoningEnabled,
        observer_channel: observerContext?.channel || null,
        access,
      }))
    } else if (msg.type === 'command' && msg.action) {
      handleBrowserCommand(ws, userId, msg)
    }
  })

  ws.on('close', () => {
    observerQuoteFeeds.unsubscribe(ws)
    const set = browsers.get(userId)
    if (set) { set.delete(ws); if (set.size === 0) browsers.delete(userId) }
  })
  ws.on('error', () => {
    observerQuoteFeeds.unsubscribe(ws)
    const set = browsers.get(userId)
    if (set) { set.delete(ws); if (set.size === 0) browsers.delete(userId) }
  })
}

// ============ Helpers ============
// Legacy Bridge 1.x handler removed; V3 is the only bridge transport.

function validHistoryDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
}

export function normalizeBridgePage(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1_000_000) : 1
}

export function normalizeBridgePageSize(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 20
}

export function boundedHistoryExportPageCount(value, maximumPages = 50) {
  const parsed = Number(value ?? 1)
  if (!Number.isSafeInteger(parsed) || parsed < 1
    || !Number.isSafeInteger(maximumPages) || maximumPages < 1) {
    return { ok:false, code:'history_export_pagination_invalid' }
  }
  if (parsed > maximumPages) {
    return { ok:false, code:'history_export_range_too_large', total_pages:parsed }
  }
  return { ok:true, total_pages:parsed }
}

export const HISTORY_EXACT_RANGE_CAPABILITY = 'history_exact_range_v1'
export const HISTORY_CURSOR_CAPABILITY = 'history_cursor_v1'
export const HISTORY_PREPARE_STATUS_CAPABILITY = 'history_prepare_status_v1'
// Product-level safety boundary.  The currently published Bridge archive may
// expose a newer floor, but user-provided dates must never be accepted before
// this absolute boundary.
export const HISTORY_ABSOLUTE_FLOOR_UTC_MSC = Date.parse('2000-01-01T00:00:00.000Z')
// Legacy compatibility export retained for older callers/tests.  It is not a
// server query floor anymore: route-advertised Bridge support/visibility is
// resolved by historyQueryFloor(), with the absolute 2000-01-01 boundary as
// the fail-closed default.  Do not use this constant to constrain new paths.
export const HISTORY_COVERAGE_START_UTC_MSC = 1735689600000
const RECENT_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000
const HISTORY_DAY_MS = 86_400_000

function positiveHistoryUtcMsc(value) {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
}

function historyFrozenField(params, frozen, keys = []) {
  for (const source of [params, frozen]) {
    if (!source || typeof source !== 'object') continue
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        return { present:true, value:source[key] }
      }
    }
  }
  return { present:false, value:null }
}

/** Resolve the oldest range the server can safely ask Bridge to serve. */
export function historyQueryFloor(route = null) {
  const routeFloors = [
    route?.history_supported_start_utc_msc,
    route?.history_coverage_start_utc_msc,
    route?.history_visible_start_utc_msc,
    route?.history_min_utc_msc,
    route?.history_sync_min_utc_msc,
    // Accept date-shaped route metadata as well as the preferred UTC-ms
    // fields.  A route's lower bound is bridge evidence, not a user query.
    route?.history_supported_start,
    route?.history_coverage_start,
    route?.history_visible_start,
    route?.history_min,
    route?.history_sync_min,
  ].map(value => positiveHistoryUtcMsc(value)
    ?? (typeof value === 'string' ? parseStrictUtcDateBoundary(value) : null))
    .filter(value => value !== null)
  // A route without an explicit floor is treated as a modern exact-range
  // route whose trusted lower bound is the product floor.  Legacy routes must
  // advertise their newer support/visible floor; they are rejected by the
  // capability gate instead of silently inheriting the old 2025 constant.
  return Math.max(HISTORY_ABSOLUTE_FLOOR_UTC_MSC, ...routeFloors)
}

export function hasHistoryExactRangeCapability(route) {
  const capabilities = route?.capabilities
  if (capabilities instanceof Set) return capabilities.has(HISTORY_EXACT_RANGE_CAPABILITY)
  return Array.isArray(capabilities) && capabilities.includes(HISTORY_EXACT_RANGE_CAPABILITY)
}

export function hasHistoryCursorCapability(route) {
  const capabilities = route?.capabilities
  if (capabilities instanceof Set) return capabilities.has(HISTORY_CURSOR_CAPABILITY)
  return Array.isArray(capabilities) && capabilities.includes(HISTORY_CURSOR_CAPABILITY)
}

export function hasHistoryPrepareStatusCapability(route) {
  const capabilities = route?.capabilities
  if (capabilities instanceof Set) return capabilities.has(HISTORY_PREPARE_STATUS_CAPABILITY)
  return Array.isArray(capabilities) && capabilities.includes(HISTORY_PREPARE_STATUS_CAPABILITY)
}

function normalizedHistoryCursorToken(value) {
  if (value == null || value === '') return null
  const token = String(value).trim()
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw historyError('history_cursor_invalid')
  return token
}

function historyExactRangeFields(params = {}) {
  const nested = params?.history_range && typeof params.history_range === 'object'
    ? params.history_range : null
  const nestedEffective = nested?.effective_range && typeof nested.effective_range === 'object'
    ? nested.effective_range : null
  return {
    hasStart:Object.prototype.hasOwnProperty.call(params, 'range_start_utc_msc')
      || Object.prototype.hasOwnProperty.call(nested || {}, 'range_start_utc_msc')
      || Object.prototype.hasOwnProperty.call(nestedEffective || {}, 'start_utc_msc'),
    hasEnd:Object.prototype.hasOwnProperty.call(params, 'range_end_utc_msc')
      || Object.prototype.hasOwnProperty.call(nested || {}, 'range_end_utc_msc')
      || Object.prototype.hasOwnProperty.call(nestedEffective || {}, 'end_utc_msc'),
  }
}

function historyCursorContinuationRange(params, resolvedRange, nowUtcMsc) {
  const frozen = params?.history_range && typeof params.history_range === 'object'
    ? params.history_range : params
  const rangeStart = Number(params?.range_start_utc_msc ?? frozen?.range_start_utc_msc
    ?? frozen?.effective_range?.start_utc_msc)
  const rangeEnd = Number(params?.range_end_utc_msc ?? frozen?.range_end_utc_msc
    ?? frozen?.captured_end_utc_msc ?? frozen?.effective_range?.end_utc_msc)
  const { hasStart, hasEnd } = historyExactRangeFields(params)
  // Starts are authoritative only when resolved from the current binding and
  // route.  Client-provided frozen values are comparisons, never inputs.
  const allowedStart = positiveHistoryUtcMsc(resolvedRange?.allowed_start_utc_msc)
  const systemStart = positiveHistoryUtcMsc(resolvedRange?.system_start_utc_msc)
  const effectiveStart = positiveHistoryUtcMsc(resolvedRange?.effective_start_utc_msc)
  const clientAllowedRaw = historyFrozenField(params, frozen, [
    'allowed_start_utc_msc', 'allowed_range_start_utc_msc',
  ])
  const clientSystemRaw = historyFrozenField(params, frozen, [
    'system_start_utc_msc', 'system_range_start_utc_msc',
  ])
  const clientEffectiveRaw = historyFrozenField(params, frozen, [
    'effective_start_utc_msc', 'effective_range_start_utc_msc',
  ])
  const clientAllowedRangeRaw = !clientAllowedRaw.present && frozen?.allowed_range
    && typeof frozen.allowed_range === 'object'
    ? { present:Object.prototype.hasOwnProperty.call(frozen.allowed_range, 'start_utc_msc'),
      value:frozen.allowed_range.start_utc_msc }
    : clientAllowedRaw
  const clientSystemRangeRaw = !clientSystemRaw.present && frozen?.system_range
    && typeof frozen.system_range === 'object'
    ? { present:Object.prototype.hasOwnProperty.call(frozen.system_range, 'start_utc_msc'),
      value:frozen.system_range.start_utc_msc }
    : clientSystemRaw
  const clientEffectiveRangeRaw = !clientEffectiveRaw.present && frozen?.effective_range
    && typeof frozen.effective_range === 'object'
    ? { present:Object.prototype.hasOwnProperty.call(frozen.effective_range, 'start_utc_msc'),
      value:frozen.effective_range.start_utc_msc }
    : clientEffectiveRaw
  const clientAllowedStart = positiveHistoryUtcMsc(clientAllowedRangeRaw.value)
  const clientSystemStart = positiveHistoryUtcMsc(clientSystemRangeRaw.value)
  const clientEffectiveStart = positiveHistoryUtcMsc(clientEffectiveRangeRaw.value)
  const capturedRaw = historyFrozenField(params, frozen, [
    'captured_end_utc_msc', 'captured_range_end_utc_msc', 'captured_end',
  ])
  const capturedEffectiveRaw = capturedRaw
  // The route/binding resolution owns the current capture endpoint.  An older
  // frozen endpoint may be carried by an opaque Bridge snapshot/cursor, which
  // binds it again inside Bridge.  A no-snapshot first page may reuse only an
  // explicit endpoint bounded by this current capture and must create a fresh
  // Bridge snapshot.
  const resolvedCapturedEnd = positiveHistoryUtcMsc(resolvedRange?.captured_end_utc_msc)
  const clientCapturedEnd = capturedEffectiveRaw.present
    ? positiveHistoryUtcMsc(capturedEffectiveRaw.value) : null
  const hasSnapshot = Boolean(params?.history_snapshot_id ?? frozen?.history_snapshot_id)
  const hasCursor = Boolean(params?.cursor ?? frozen?.cursor)
  const opaqueContinuation = hasSnapshot || hasCursor
  if (hasCursor && !hasSnapshot) throw historyError('history_cursor_invalid')
  const explicitFrozenRange = hasStart && hasEnd && capturedEffectiveRaw.present
  const capturedEnd = (opaqueContinuation || explicitFrozenRange)
    ? clientCapturedEnd
    : (hasStart && hasEnd ? rangeEnd : resolvedCapturedEnd)
  const resolvedEffectiveEnd = positiveHistoryUtcMsc(resolvedRange?.range_end_utc_msc)
  const ownershipStart = Number(resolvedRange?.ownership_start_utc_msc)
  const maxRangeEnd = Number.isSafeInteger(nowUtcMsc) ? nowUtcMsc + 60_000 : NaN
  if (!hasStart || !hasEnd
    || !Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd)
    || !Number.isSafeInteger(allowedStart) || allowedStart <= 0
    || !Number.isSafeInteger(systemStart) || systemStart <= 0
    || !Number.isSafeInteger(effectiveStart) || effectiveStart <= 0
    || !Number.isSafeInteger(capturedEnd) || capturedEnd <= 0
    || !Number.isSafeInteger(resolvedEffectiveEnd) || resolvedEffectiveEnd <= 0
    || !Number.isSafeInteger(maxRangeEnd)
    || rangeStart < allowedStart || rangeEnd <= 0 || rangeStart >= rangeEnd
    || rangeEnd > capturedEnd || capturedEnd > maxRangeEnd) {
    throw historyError('history_cursor_invalid')
  }
  if ((clientAllowedRangeRaw.present && clientAllowedStart === null)
    || (clientSystemRangeRaw.present && clientSystemStart === null)
    || (clientEffectiveRangeRaw.present && clientEffectiveStart === null)
    || (capturedEffectiveRaw.present && clientCapturedEnd === null)
    || (opaqueContinuation && !capturedEffectiveRaw.present)) {
    throw historyError('history_cursor_invalid')
  }
  if (opaqueContinuation && (rangeEnd > capturedEnd
    || capturedEnd <= effectiveStart || capturedEnd > maxRangeEnd)) {
    throw historyError('history_cursor_invalid')
  }
  if (!opaqueContinuation && (rangeStart !== effectiveStart
    || rangeEnd > resolvedEffectiveEnd
    || capturedEnd > (resolvedCapturedEnd || 0)
    || (capturedEffectiveRaw.present && clientCapturedEnd !== capturedEnd))) {
    throw historyError('history_cursor_invalid')
  }

  // A first page freezes all range boundaries.  Old clients may omit the
  // explicit metadata, but if a field is present it must agree exactly with
  // the frozen response; this prevents a raw range_start from widening a
  // continuation request.
  for (const [value, expected] of [
    [clientAllowedStart, allowedStart],
    [clientSystemStart, systemStart],
    [clientEffectiveStart, effectiveStart],
    [capturedEffectiveRaw.present ? clientCapturedEnd : null, capturedEnd],
  ]) {
    if (value !== null && value !== undefined && Number(value) !== expected) {
      throw historyError('history_cursor_invalid')
    }
  }

  // `recent` remains a hidden compatibility scope and moves with the current
  // clock. `all` and `platform` are fixed-origin scopes: retries must preserve
  // their exact starts, while custom calendar bounds remain stable and must
  // contain the requested range.
  const scope = String(resolvedRange?.scope || resolvedRange?.requested_scope || '')
    .trim().toLowerCase()
  if (!opaqueContinuation) {
    // An explicit, filter-changing first page gets a fresh Bridge snapshot.
    // Its start is still bound to the current server-resolved effective start;
    // only the old captured upper bound may be reused.
  } else if (scope === 'custom') {
    // Date-shaped custom bounds were already resolved against the trusted
    // terminal clock.  Continuations compare those authoritative numeric
    // boundaries and never reinterpret a client date as UTC midnight.
    if (rangeStart !== effectiveStart) {
      throw historyError('history_cursor_invalid')
    }
  } else if (scope === 'recent') {
    const expectedStart = rangeEnd - RECENT_HISTORY_WINDOW_MS
    if (rangeStart !== expectedStart
      && !(params?.scope_start_override ?? frozen?.scope_start_override)) {
      throw historyError('history_cursor_invalid')
    }
  } else if (scope === 'platform') {
    const overrideValue = params?.scope_start_override ?? frozen?.scope_start_override
    if (overrideValue) {
      if (rangeStart !== effectiveStart || effectiveStart < allowedStart || effectiveStart >= rangeEnd) {
        throw historyError('history_cursor_invalid')
      }
    } else if (rangeStart !== effectiveStart) throw historyError('history_cursor_invalid')
  } else if (scope === 'all') {
    const overrideValue = params?.scope_start_override ?? frozen?.scope_start_override
    if (overrideValue) {
      if (rangeStart !== effectiveStart || effectiveStart < allowedStart || effectiveStart >= rangeEnd) {
        throw historyError('history_cursor_invalid')
      }
    } else if (rangeStart !== effectiveStart) throw historyError('history_cursor_invalid')
  } else if (scope === 'ownership') {
    if (!Number.isSafeInteger(ownershipStart) || ownershipStart <= 0
      || rangeStart !== ownershipStart) throw historyError('history_cursor_invalid')
  } else {
    throw historyError('history_cursor_invalid')
  }

  return {
    ...resolvedRange,
    allowed_start_utc_msc:allowedStart,
    system_start_utc_msc:systemStart,
    effective_start_utc_msc:effectiveStart,
    captured_end_utc_msc:capturedEnd,
    allowed_range:{ start_utc_msc:allowedStart, end_utc_msc:capturedEnd },
    system_range:{ start_utc_msc:systemStart,
      end_utc_msc:scope === 'custom' ? rangeEnd : capturedEnd },
    effective_range:{ start_utc_msc:effectiveStart,
      end_utc_msc:rangeEnd },
    range_start_utc_msc:rangeStart,
    range_end_utc_msc:rangeEnd,
  }
}

// Capture a single terminal-history upper bound for each request.  Date.now()
// is normally a safe integer, but keeping the check here makes the transport
// contract explicit and prevents a mocked/invalid clock value from widening a
// history query to an unintended range.
export function safeHistoryRangeEndUtcMsc(now = Date.now(), dateTo = null) {
  const captured = Number.isSafeInteger(now) && now > 0 ? now : null
  if (captured === null) return null
  if (!validHistoryDate(dateTo)) return captured

  // The native history parser treats date_to as an inclusive calendar date
  // and rejects an explicit endpoint beyond the following UTC midnight.  A
  // strict round-trip check avoids silently normalising invalid dates such as
  // 2026-02-30; those remain invalid inputs for the native contract.
  const parsed = Date.parse(`${dateTo}T00:00:00.000Z`)
  if (!Number.isSafeInteger(parsed)) return captured
  const parsedDate = new Date(parsed)
  const [year, month, day] = String(dateTo).split('-').map(Number)
  if (parsedDate.getUTCFullYear() !== year
    || parsedDate.getUTCMonth() + 1 !== month
    || parsedDate.getUTCDate() !== day) return captured
  const exclusiveEnd = parsed + 86_400_000
  return Number.isSafeInteger(exclusiveEnd) ? Math.min(captured, exclusiveEnd) : captured
}

/**
 * Decide whether an export may claim a complete history set.
 *
 * A bounded platform/custom range, including the fixed all-account range, is
 * complete when the bridge confirms that requested range.  The archive proof
 * remains the fallback for responses without explicit range fields.  The new
 * fields are intentionally optional so older bridge responses continue to use
 * the legacy `complete` flag, while an explicit truncation marker always fails
 * closed.
 */
export function isHistoryExportComplete({
  range = {},
  historySync = null,
  result = null,
} = {}) {
  const sync = historySync && typeof historySync === 'object' ? historySync : {}
  const response = result && typeof result === 'object' ? result : {}
  if (response.evidence_truncated === true || sync.evidence_truncated === true) return false

  const hasExactFields = range?.range_start_utc_msc !== undefined
    || range?.rangeStartUtcMsc !== undefined
    || range?.range_end_utc_msc !== undefined
    || range?.rangeEndUtcMsc !== undefined
  const explicitStart = Number(range?.range_start_utc_msc ?? range?.rangeStartUtcMsc)
  const explicitEnd = Number(range?.range_end_utc_msc ?? range?.rangeEndUtcMsc)
  const hasExactStart = Number.isSafeInteger(explicitStart) && explicitStart > 0
  const hasExactEnd = Number.isSafeInteger(explicitEnd) && explicitEnd > explicitStart
  const explicitDateFrom = range?.date_from ?? range?.dateFrom
  const hasExplicitStart = hasExactStart || String(explicitDateFrom || '').trim().length > 0
  const complete = typeof sync.complete === 'boolean' ? sync.complete : false
  if (hasExactFields) return hasExactStart && hasExactEnd && sync.requested_range_complete === true
  if (hasExplicitStart) {
    return typeof sync.requested_range_complete === 'boolean'
      ? sync.requested_range_complete
      : complete
  }
  return typeof sync.archive_complete === 'boolean'
    ? sync.archive_complete
    : complete
}

function historyReference(value) {
  const normalized = String(value ?? '').trim()
  return normalized && normalized !== '0' ? normalized : null
}

function historyRowReferences(row = {}) {
  return [...new Set([
    row.ticket, row.order, row.order_ticket, row.position, row.position_id,
  ].map(historyReference).filter(Boolean))]
}

function parsedHistoryProtectionResult(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

function positiveHistoryProtectionValue(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

export function enrichHistoryProtectionRows(rows = [], evidenceRows = [], { tradingAccountId = null } = {}) {
  const accountId = Number(tradingAccountId) || null
  const byReference = new Map()
  for (const evidence of evidenceRows || []) {
    if (accountId && Number(evidence?.trading_account_id) !== accountId) continue
    if (String(evidence?.target_status || '') !== 'succeeded') continue
    const result = parsedHistoryProtectionResult(evidence.target_result_json)
    if (!result) continue
    const stopLoss = positiveHistoryProtectionValue(result.stop_loss)
    const takeProfit = positiveHistoryProtectionValue(result.take_profit)
    if (!stopLoss && !takeProfit) continue
    const item = {
      stopLoss,
      takeProfit,
      verifiedAt:evidence.target_completed_at || evidence.protection_updated_at || null,
      jobId:Number(evidence.protection_job_id) || null,
    }
    for (const reference of [
      evidence.entry_order_ticket, evidence.position_id, evidence.target_ticket,
    ].map(historyReference).filter(Boolean)) {
      if (!byReference.has(reference)) byReference.set(reference, item)
    }
  }

  return (rows || []).map(row => {
    const mt5EntryStopLoss = positiveHistoryProtectionValue(row?.stop_loss)
    const mt5EntryTakeProfit = positiveHistoryProtectionValue(row?.take_profit)
    const verified = historyRowReferences(row).map(reference => byReference.get(reference)).find(Boolean)
    return {
      ...row,
      mt5_entry_stop_loss:mt5EntryStopLoss,
      mt5_entry_take_profit:mt5EntryTakeProfit,
      last_verified_stop_loss:verified?.stopLoss || null,
      last_verified_take_profit:verified?.takeProfit || null,
      display_stop_loss:verified?.stopLoss || mt5EntryStopLoss,
      display_take_profit:verified?.takeProfit || mt5EntryTakeProfit,
      stop_loss_source:verified?.stopLoss ? 'verified_platform_protection' : 'mt5_entry_order',
      take_profit_source:verified?.takeProfit ? 'verified_platform_protection' : 'mt5_entry_order',
      protection_verified_at:verified?.verifiedAt || null,
      protection_job_id:verified?.jobId || null,
    }
  })
}

async function loadHistoryProtectionEvidence(userId, tradingAccountId, rows) {
  const accountId = Number(tradingAccountId)
  if (!Number.isInteger(accountId) || accountId <= 0 || !Array.isArray(rows) || !rows.length) return []
  const references = [...new Set(rows.flatMap(historyRowReferences))].slice(0, 1_000)
  if (!references.length) return []
  const placeholders = references.map(() => '?').join(',')
  return queryAll(`SELECT outcomes.trading_account_id, outcomes.entry_order_ticket, outcomes.position_id,
      outcomes.protection_job_id, outcomes.protection_updated_at,
      targets.ticket AS target_ticket, targets.status AS target_status,
      targets.result_json AS target_result_json, targets.completed_at AS target_completed_at
    FROM signal_outcomes outcomes
    JOIN admin_position_protection_targets targets
      ON targets.job_id = outcomes.protection_job_id
      AND targets.outcome_id = outcomes.id
      AND targets.user_id = outcomes.user_id
      AND targets.trading_account_id = outcomes.trading_account_id
      AND targets.status = 'succeeded'
    WHERE outcomes.user_id = ? AND outcomes.trading_account_id = ?
      AND (outcomes.entry_order_ticket IN (${placeholders})
        OR outcomes.position_id IN (${placeholders})
        OR targets.ticket IN (${placeholders}))
    ORDER BY targets.completed_at DESC, targets.id DESC`, [
    Number(userId), accountId, ...references, ...references, ...references,
  ])
}

async function enrichHistoryResultProtection(userId, tradingAccountId, result) {
  if (result?.status !== 'success' || !Array.isArray(result.orders) || !result.orders.length) return result
  try {
    const evidence = await loadHistoryProtectionEvidence(userId, tradingAccountId, result.orders)
    result.orders = enrichHistoryProtectionRows(result.orders, evidence, { tradingAccountId })
  } catch (error) {
    console.warn(`[BridgeWS] History protection enrichment failed user=${userId} account=${tradingAccountId}:`, error.message)
  }
  return result
}

function historyError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function parseStrictUtcDateBoundary(value) {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const parsed = Date.parse(`${text}T00:00:00.000Z`)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  const date = new Date(parsed)
  const [year, month, day] = text.split('-').map(Number)
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day) return null
  return parsed
}

function nextUtcDateBoundary(value) {
  const parsed = parseStrictUtcDateBoundary(value)
  if (parsed === null) return null
  const next = parsed + 86_400_000
  return Number.isSafeInteger(next) ? next : null
}

function historyRouteAccount(route) {
  const terminalInstanceId = String(route?.terminal_instance_id || '').trim()
  const brokerServer = String(route?.account_ref?.broker_server || '').trim()
  const loginAccount = String(route?.account_ref?.login || '').trim()
  if (!brokerServer || !loginAccount) {
    throw historyError('bridge_history_route_required')
  }
  return { terminalInstanceId, brokerServer, loginAccount }
}

function assertHistoryExactRoute(route) {
  const { terminalInstanceId } = historyRouteAccount(route)
  if (!terminalInstanceId) throw historyError('bridge_history_route_required')
  if (!hasHistoryExactRangeCapability(route)) {
    throw historyError('bridge_history_exact_range_unsupported')
  }
  return route
}

function assertHistoryPreferenceRoute(route) {
  const { terminalInstanceId } = historyRouteAccount(route)
  if (!terminalInstanceId) throw historyError('bridge_history_route_required')
  return route
}

function normalizedHistoryPreferenceScope(params = {}) {
  const nested = params?.history_range && typeof params.history_range === 'object'
    ? params.history_range : null
  const raw = params?.scope ?? params?.history_scope ?? nested?.scope ?? nested?.requested_scope
  const scope = String(raw == null || raw === '' ? '' : raw).trim().toLowerCase()
  if (!['all', 'platform'].includes(scope)) {
    throw historyError('history_range_preference_scope_invalid')
  }
  return scope
}

function normalizedHistoryPreferenceDate(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw historyError('history_range_preference_date_invalid')
  const date = value.trim()
  if (!date) return null
  if (parseStrictUtcDateBoundary(date) === null) {
    throw historyError('history_range_preference_date_invalid')
  }
  return date
}

function historyBusinessDateForRangeStart(range = {}) {
  const utcMsc = Number(range.system_start_utc_msc)
  const offsetMinutes = Number(range.timezone_offset_minutes)
  if (!Number.isSafeInteger(utcMsc) || utcMsc <= 0
    || !Number.isSafeInteger(offsetMinutes) || offsetMinutes < -840 || offsetMinutes > 840) {
    return null
  }
  try {
    return new Date(utcMsc + offsetMinutes * 60_000).toISOString().slice(0, 10)
  } catch {
    return null
  }
}

function historyRangeWithSavedPreference(range, scope, startDate) {
  const next = { ...range }
  next.scope_start_override = null
  next.override_applied = false
  next.saved_start_date = startDate
  next.preference_start_date = startDate
  next.preference_source = startDate ? 'server_account' : 'system'
  next.preference_applied = Boolean(startDate)
  next.preference_invalid = false
  next.preference_invalid_reason = null
  if (startDate) return next

  // A reset removes the saved start. Re-project the already validated range
  // to the system boundary without changing its frozen end/clock evidence.
  const systemStart = Number(range.system_start_utc_msc)
  if (!Number.isSafeInteger(systemStart) || systemStart <= 0
    || systemStart >= Number(range.range_end_utc_msc)) return next
  next.range_start_utc_msc = systemStart
  next.effective_start_utc_msc = systemStart
  next.effective_range = { ...(range.effective_range || {}), start_utc_msc:systemStart }
  next.filter_close_from_utc_msc = Math.max(systemStart,
    Number(range.filter_close_from_utc_msc) || systemStart)
  next.scope = scope
  next.requested_scope = scope
  return next
}

/**
 * Persist one all/platform history start for the current exact route.
 * Identity is deliberately supplied by the authenticated caller and route;
 * no user_id or trading_account_id request parameter participates in writes.
 */
export async function setHistoryRangePreference(
  userId,
  route,
  params = {},
  nowUtcMsc = Date.now(),
) {
  const numericUserId = Number(userId)
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
    throw historyError('bridge_history_binding_unavailable')
  }
  const exactRoute = assertHistoryPreferenceRoute(route)
  const scope = normalizedHistoryPreferenceScope(params)
  const nested = params?.history_range && typeof params.history_range === 'object'
    ? params.history_range : null
  const startDate = normalizedHistoryPreferenceDate(
    Object.prototype.hasOwnProperty.call(params || {}, 'start_date')
      ? params.start_date : nested?.start_date,
  )
  if (!Number.isSafeInteger(nowUtcMsc) || nowUtcMsc <= 0) {
    throw historyError('bridge_history_range_invalid')
  }
  const { brokerServer, loginAccount } = historyRouteAccount(exactRoute)

  return withTransaction(async run => {
    // Lock the exact current binding and its identity row before validating
    // or writing.  A reconnect/account switch cannot race this operation and
    // redirect a preference to an account that is no longer current.
    const [lockedRows] = await run(`SELECT
        bindings.current_trading_account_id AS trading_account_id
      FROM mt5_account_bindings bindings
      JOIN trading_accounts ta
        ON ta.id = bindings.current_trading_account_id
        AND ta.user_id = bindings.current_user_id
        AND UPPER(ta.broker_server) = UPPER(bindings.broker_server_key)
        AND ta.login_account = bindings.login_account
        AND ta.is_deleted = 0
      WHERE bindings.current_user_id = ?
        AND UPPER(bindings.broker_server_key) = UPPER(?)
        AND bindings.login_account = ?
      LIMIT 1 FOR UPDATE`, [numericUserId, brokerServer, loginAccount])
    const lockedAccountId = Number(lockedRows?.[0]?.trading_account_id)
    if (!Number.isSafeInteger(lockedAccountId) || lockedAccountId <= 0) {
      throw historyError('bridge_history_binding_unavailable')
    }

    // First resolve the unmodified system range. A date equal to the
    // system-start terminal business date means "use the default"; treating
    // it as an explicit UTC override would incorrectly move a positive-offset
    // all-history floor into the previous UTC day.
    const baselineRange = await resolveHistoryRange(numericUserId, {
      history_scope:scope,
    }, exactRoute, nowUtcMsc)
    const systemStartDate = historyBusinessDateForRangeStart(baselineRange)
    const persistedStartDate = startDate && startDate === systemStartDate ? null : startDate

    // A non-null value must pass the same allowed_start/range_end validation
    // as a temporary scope_start_override. The validation query also proves
    // the route/account ownership; compare its account id with the locked row
    // before using the transaction runner for the write.
    const validationRange = persistedStartDate ? await resolveHistoryRange(numericUserId, {
      history_scope:scope,
      scope_start_override:persistedStartDate,
    }, exactRoute, nowUtcMsc) : baselineRange
    const tradingAccountId = Number(validationRange.trading_account_id)
    if (!Number.isSafeInteger(tradingAccountId) || tradingAccountId <= 0
      || tradingAccountId !== lockedAccountId) {
      throw historyError('bridge_history_binding_unavailable')
    }

    if (persistedStartDate) {
      const now = beijingNow()
      await run(`INSERT INTO history_range_preferences
        (user_id, trading_account_id, scope, start_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE start_date = VALUES(start_date), updated_at = VALUES(updated_at)`,
      [numericUserId, lockedAccountId, scope, persistedStartDate, now, now])
    } else {
      await run(`DELETE FROM history_range_preferences
        WHERE user_id = ? AND trading_account_id = ? AND scope = ?`,
      [numericUserId, lockedAccountId, scope])
    }

    return {
      status:'success',
      preference:{ scope, start_date:persistedStartDate },
      history_range:historyRangeWithSavedPreference(validationRange, scope, persistedStartDate),
    }
  })
}

function assertHistoryPrepareStatusRoute(route) {
  const exactRoute = assertHistoryExactRoute(route)
  if (!hasHistoryPrepareStatusCapability(exactRoute)) {
    throw historyError('history_prepare_status_unsupported')
  }
  return exactRoute
}

function compactHistoryPrepareRange(range) {
  return {
    scope:range.scope,
    requested_scope:range.requested_scope,
    range_start_utc_msc:range.range_start_utc_msc,
    range_end_utc_msc:range.range_end_utc_msc,
    captured_end_utc_msc:range.captured_end_utc_msc,
    allowed_start_utc_msc:range.allowed_start_utc_msc,
    system_start_utc_msc:range.system_start_utc_msc,
    effective_start_utc_msc:range.effective_start_utc_msc,
    allowed_range:range.allowed_range,
    system_range:range.system_range,
    effective_range:range.effective_range,
    scope_start_override:range.scope_start_override,
    override_applied:Boolean(range.override_applied),
    saved_start_date:range.saved_start_date || null,
    preference_source:range.preference_source || 'system',
    preference_applied:Boolean(range.preference_applied),
    preference_invalid:Boolean(range.preference_invalid),
    timezone_offset_minutes:range.timezone_offset_minutes,
    clock_status:range.clock_status,
    clock_source:range.clock_source,
  }
}

function strictHistoryRouteForUser(userId, params = {}) {
  let routes = (bridgeV3Business?.connectedTerminals(Number(userId)) || []).slice()
  const terminalInstanceId = String(params?.terminal_instance_id || '').trim()
  const tradingAccountId = Number(params?.trading_account_id)
  const brokerServer = String(params?.broker_server || params?.account_ref?.broker_server || '').trim()
  const loginAccount = String(params?.login || params?.account_login || params?.account_ref?.login || '').trim()
  if (terminalInstanceId) {
    routes = routes.filter(route => route.terminal_instance_id === terminalInstanceId)
  }
  if (Number.isSafeInteger(tradingAccountId) && tradingAccountId > 0) {
    const bindings = bridgeV3TradingAccounts.get(Number(userId))
    routes = routes.filter(route => Number(bindings?.get(route.terminal_instance_id)) === tradingAccountId)
  }
  if (brokerServer) {
    routes = routes.filter(route => String(route?.account_ref?.broker_server || '').trim().toLowerCase()
      === brokerServer.toLowerCase())
  }
  if (loginAccount) {
    routes = routes.filter(route => String(route?.account_ref?.login || '').trim() === loginAccount)
  }
  if (routes.length === 0) throw historyError('bridge_history_route_required')
  if (routes.length !== 1) throw historyError('bridge_history_route_ambiguous')
  return routes[0]
}

function historyPlatformStart(row) {
  // `first_connected_at` is the stable account identity anchor.  Do not fall
  // back to users.created_at or an ownership-period timestamp; missing
  // binding evidence fails closed.
  const raw = row?.first_connected_utc_msc
    ?? row?.first_connected_at
  const start = positiveHistoryUtcMsc(raw)
    ?? (typeof raw === 'string' && Number.isSafeInteger(Date.parse(raw.replace(' ', 'T') + 'Z'))
      ? Date.parse(raw.replace(' ', 'T') + 'Z') : null)
  if (!Number.isSafeInteger(start) || start <= 0) {
    throw historyError('bridge_history_binding_unavailable')
  }
  return start
}

function historyOwnershipStart(row) {
  const start = Number(row?.ownership_start_utc_msc)
  return Number.isSafeInteger(start) && start > 0 ? start : null
}

function historyOrderCloseUtcMsc(row = {}) {
  const candidates = [
    row.close_time_utc_msc,
    row.closeTimeUtcMsc,
    row.close_time_msc,
    row.closeTimeMsc,
  ]
  for (const value of candidates) {
    const numeric = positiveHistoryUtcMsc(value)
    if (numeric !== null) return numeric
  }
  const text = String(row.close_time || row.closeTime || '').trim()
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function historyTerminalClock(userId, route) {
  const market = bridgeV3MarketStateForContext(userId, null, route?.terminal_instance_id)
  const candidates = [
    market && {
      timezone_offset_minutes:market.timezoneOffsetMinutes,
      clock_status:market.clockStatus,
      clock_source:market.clockSource,
      observed_at_utc_msc:market.observedAtUtcMsc,
      received_at_utc_msc:market.lastTickMs,
    },
    route?.clock,
    route && {
      timezone_offset_minutes:route.timezone_offset_minutes,
      clock_status:route.clock_status,
    },
    applyDefaultObserverClockBootstrap({
      broker_server:route?.account_ref?.broker_server || null,
      timezone_offset_minutes:null,
      clock_status:'unavailable',
    }, defaultObserverClockCache),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (!trustedTerminalClock(candidate)) continue
    return {
      timezone_offset_minutes:Number(candidate.timezone_offset_minutes),
      clock_status:String(candidate.clock_status || candidate.source_clock_status || '').trim(),
      clock_source:candidate.clock_source
        || (positiveHistoryUtcMsc(candidate.observed_at_utc_msc)
          ? 'terminal_observed_utc' : 'verified_terminal_offset'),
      observed_at_utc_msc:positiveHistoryUtcMsc(candidate.observed_at_utc_msc),
      received_at_utc_msc:positiveHistoryUtcMsc(candidate.received_at_utc_msc),
    }
  }
  return null
}

export function getHistoryTerminalClock(userId, route) {
  const clock = historyTerminalClock(Number(userId), route)
  return clock ? { ...clock } : null
}

export function captureHistoryTerminalNowUtcMsc(userId, route, serverNowUtcMsc = Date.now()) {
  if (!Number.isSafeInteger(serverNowUtcMsc) || serverNowUtcMsc <= 0) {
    throw historyError('bridge_history_range_invalid')
  }
  const clock = historyTerminalClock(userId, route)
  if (!clock) throw historyError('bridge_history_terminal_clock_unavailable')

  // A live terminal observation is the preferred UTC anchor.  Advance it only
  // by the elapsed server monotonic wall time since receipt; never reinterpret
  // the terminal's local wall clock or browser time as UTC.
  const observedAt = positiveHistoryUtcMsc(clock.observed_at_utc_msc)
  const receivedAt = positiveHistoryUtcMsc(clock.received_at_utc_msc)
  if (observedAt !== null && receivedAt !== null
    && observedAt <= serverNowUtcMsc + 60_000 && receivedAt <= serverNowUtcMsc + 60_000) {
    const anchored = observedAt + Math.max(0, serverNowUtcMsc - receivedAt)
    if (Number.isSafeInteger(anchored) && anchored > 0
      && Math.abs(anchored - serverNowUtcMsc) <= 5 * 60_000) return anchored
  }

  // During a quiet/closed market the verified persisted terminal offset is
  // sufficient to map business-day dates.  The UTC instant itself comes from
  // the server clock and is independent of the server's local timezone.
  return serverNowUtcMsc
}

function historyDateInputUtcMsc(value, clock, { endOfDay = false, exclusive = false } = {}) {
  if (value === undefined || value === null || value === '') return null
  const numeric = positiveHistoryUtcMsc(value)
    ?? (typeof value === 'string' && /^\d+$/.test(value.trim())
      ? positiveHistoryUtcMsc(value.trim()) : null)
  if (numeric !== null) return numeric
  if (!clock) throw historyError('bridge_history_terminal_clock_unavailable')
  const parsed = parseStrictUtcDateBoundary(value)
  if (parsed === null) throw historyError('bridge_history_date_invalid')
  const localStart = parsed - Number(clock.timezone_offset_minutes) * 60_000
  if (exclusive || endOfDay) {
    const end = localStart + HISTORY_DAY_MS
    return endOfDay ? end - 1 : end
  }
  return localStart
}

export async function resolveHistoryRange(
  userId,
  params = {},
  route,
  nowUtcMsc = Date.now(),
) {
  const numericUserId = Number(userId)
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
    throw historyError('bridge_history_binding_unavailable')
  }
  const { brokerServer, loginAccount } = historyRouteAccount(route)
  if (!Number.isSafeInteger(nowUtcMsc) || nowUtcMsc <= 0) {
    throw historyError('bridge_history_range_invalid')
  }

  const ownership = await queryOne(`SELECT
      bindings.current_trading_account_id AS trading_account_id,
      bindings.first_connected_at,
      CAST(UNIX_TIMESTAMP(bindings.first_connected_at)*1000 AS UNSIGNED)
        AS first_connected_utc_msc,
      CAST(UNIX_TIMESTAMP(ownership.started_at)*1000 AS UNSIGNED)
        AS ownership_start_utc_msc,
      ownership.id AS ownership_history_id,
      history_pref_all.start_date AS saved_all_start_date,
      history_pref_platform.start_date AS saved_platform_start_date
    FROM mt5_account_bindings bindings
    JOIN trading_accounts ta
      ON ta.id = bindings.current_trading_account_id
      AND ta.user_id = bindings.current_user_id
      AND UPPER(ta.broker_server) = UPPER(bindings.broker_server_key)
      AND ta.login_account = bindings.login_account
      AND ta.is_deleted = 0
    LEFT JOIN mt5_account_ownership_history ownership
      ON ownership.trading_account_id = ta.id
      AND ownership.user_id = bindings.current_user_id
      AND UPPER(ownership.broker_server_key) = UPPER(bindings.broker_server_key)
      AND ownership.login_account = bindings.login_account
      AND ownership.ended_at IS NULL
    LEFT JOIN history_range_preferences history_pref_all
      ON history_pref_all.user_id = bindings.current_user_id
      AND history_pref_all.trading_account_id = bindings.current_trading_account_id
      AND history_pref_all.scope = 'all'
    LEFT JOIN history_range_preferences history_pref_platform
      ON history_pref_platform.user_id = bindings.current_user_id
      AND history_pref_platform.trading_account_id = bindings.current_trading_account_id
      AND history_pref_platform.scope = 'platform'
    WHERE bindings.current_user_id = ?
      AND UPPER(bindings.broker_server_key) = UPPER(?)
      AND bindings.login_account = ?
    LIMIT 1`, [numericUserId, brokerServer, loginAccount])
  if (!ownership) throw historyError('bridge_history_binding_unavailable')
  const platformStart = historyPlatformStart(ownership)
  const ownershipStart = historyOwnershipStart(ownership)
  const allowedStart = historyQueryFloor(route)
  const terminalClock = historyTerminalClock(numericUserId, route)
  const nestedRange = params?.history_range && typeof params.history_range === 'object'
    ? params.history_range : null

  const requestedScopeValue = params?.history_scope ?? nestedRange?.scope
    ?? nestedRange?.requested_scope
  const requestedScope = requestedScopeValue == null || requestedScopeValue === ''
    ? 'all' : String(requestedScopeValue).trim().toLowerCase()
  if (!['recent', 'ownership', 'platform', 'all', 'custom'].includes(requestedScope)) {
    throw historyError('bridge_history_scope_invalid')
  }

  let systemStart
  let effectiveStart
  const capturedEnd = nowUtcMsc
  let rangeEnd = nowUtcMsc
  let closeFrom = null
  let closeTo = null
  let overrideApplied = false
  let preferenceApplied = false
  let preferenceInvalid = false
  let preferenceInvalidReason = null
  let preferenceSource = 'system'
  let savedStartDate = null
  let savedPreferenceStart = null
  if (requestedScope === 'custom') {
    const customCloseFrom = params?.close_from ?? nestedRange?.close_from
    const customCloseTo = params?.close_to ?? nestedRange?.close_to
    closeFrom = historyDateInputUtcMsc(customCloseFrom, terminalClock)
    if (closeFrom === null) throw historyError('bridge_history_custom_start_invalid')
    if (closeFrom < allowedStart) {
      throw historyError('bridge_history_before_supported_start')
    }
    closeTo = customCloseTo == null || customCloseTo === '' ? null
      : historyDateInputUtcMsc(customCloseTo, terminalClock, { exclusive:true })
    if (customCloseTo != null && customCloseTo !== '' && closeTo === null) {
      throw historyError('bridge_history_custom_end_invalid')
    }
    systemStart = closeFrom
    if (closeTo !== null) rangeEnd = Math.min(rangeEnd, closeTo)
  } else if (requestedScope === 'recent') {
    systemStart = Math.max(allowedStart, nowUtcMsc - RECENT_HISTORY_WINDOW_MS)
  } else if (requestedScope === 'platform') {
    systemStart = Math.max(allowedStart, platformStart)
  } else if (requestedScope === 'all') {
    systemStart = allowedStart
  } else if (requestedScope === 'ownership') {
    // Hidden legacy ownership requests retain their current-owner range. New
    // platform/all requests are resolved above and never use this timestamp.
    if (!Number.isSafeInteger(ownershipStart)) {
      throw historyError('bridge_history_ownership_unavailable')
    }
    systemStart = ownershipStart
  }
  if (!Number.isSafeInteger(systemStart) || !Number.isSafeInteger(rangeEnd)
    || systemStart <= 0 || rangeEnd <= 0 || systemStart >= rangeEnd) {
    throw historyError('bridge_history_range_invalid')
  }

  // Server preferences are intentionally read from the current binding row
  // above.  The route and user are the ownership proof; a client-provided
  // account/user id is never part of this lookup.  A stale or malformed
  // preference must not make every subsequent history read fail closed: drop
  // it for this request, report the invalid state, and use the system start.
  if (['all', 'platform'].includes(requestedScope)) {
    const rawSavedStart = requestedScope === 'all'
      ? (ownership.saved_all_start_date
        ?? ownership.history_preference_all_start_date
        ?? ownership.saved_start_date
        ?? ownership.preference_start_date
        ?? ownership.start_date)
      : (ownership.saved_platform_start_date
        ?? ownership.history_preference_platform_start_date
        ?? ownership.saved_start_date
        ?? ownership.preference_start_date
        ?? ownership.start_date)
    if (rawSavedStart !== undefined && rawSavedStart !== null && rawSavedStart !== '') {
      const candidate = rawSavedStart instanceof Date && !Number.isNaN(rawSavedStart.getTime())
        ? rawSavedStart.toISOString().slice(0, 10) : String(rawSavedStart).trim()
      const parsedCandidate = parseStrictUtcDateBoundary(candidate)
      if (parsedCandidate === null) {
        preferenceInvalid = true
        preferenceInvalidReason = 'date_invalid'
      } else if (candidate === historyBusinessDateForRangeStart({
        system_start_utc_msc:systemStart,
        timezone_offset_minutes:terminalClock?.timezone_offset_minutes,
      })) {
        // Canonicalize a legacy row that stores the system business date. It
        // is semantically the reset/default state, even if the row predates
        // the write-path reset rule.
        savedStartDate = null
        savedPreferenceStart = null
      } else {
        try {
          const parsedStart = historyDateInputUtcMsc(candidate, terminalClock)
          if (parsedStart < allowedStart || parsedStart >= rangeEnd) {
            preferenceInvalid = true
            preferenceInvalidReason = 'out_of_range'
          } else {
            savedStartDate = candidate
            savedPreferenceStart = parsedStart
          }
        } catch (error) {
          // A saved date is not allowed to turn an otherwise valid default
          // range into a permanent clock error.  Keep the error as an
          // observable invalid-preference reason and fall back below.
          preferenceInvalid = true
          preferenceInvalidReason = error?.code === 'bridge_history_terminal_clock_unavailable'
            ? 'clock_unavailable' : 'date_invalid'
        }
      }
    }
  }

  // Start overrides are query-only.  They can expand a platform/all scope
  // toward the allowed floor, but may never rewrite first_connected_at or be
  // used with custom/legacy ownership scopes.
  const overrideValue = params?.scope_start_override ?? nestedRange?.scope_start_override
  const hasOverride = overrideValue !== undefined
    && overrideValue !== null && overrideValue !== ''
  if (hasOverride && !['all', 'platform'].includes(requestedScope)) {
    throw historyError('bridge_history_scope_override_unsupported')
  }
  if (hasOverride) {
    const override = historyDateInputUtcMsc(overrideValue, terminalClock)
    if (override === null) throw historyError('bridge_history_scope_start_invalid')
    if (override < allowedStart || override >= rangeEnd) {
      throw historyError('bridge_history_scope_start_out_of_range')
    }
    effectiveStart = override
    overrideApplied = true
  } else {
    effectiveStart = savedPreferenceStart ?? systemStart
    if (savedPreferenceStart !== null) {
      preferenceApplied = true
      preferenceSource = 'server_account'
    }
  }

  // `filter_close_*` narrows table/chart rows only.  Keep scope boundaries
  // unchanged and expose the intersection so a client cannot widen stats by
  // supplying a filter outside the frozen scope.
  let filterCloseFrom = null
  let filterCloseTo = null
  const filterCloseFromValue = params?.filter_close_from ?? nestedRange?.filter_close_from
  const filterCloseToValue = params?.filter_close_to ?? nestedRange?.filter_close_to
  if (filterCloseFromValue !== undefined && filterCloseFromValue !== null
    && filterCloseFromValue !== '') {
    filterCloseFrom = historyDateInputUtcMsc(filterCloseFromValue, terminalClock)
    if (filterCloseFrom === null) throw historyError('bridge_history_filter_close_start_invalid')
  }
  if (filterCloseToValue !== undefined && filterCloseToValue !== null
    && filterCloseToValue !== '') {
    filterCloseTo = historyDateInputUtcMsc(filterCloseToValue, terminalClock, { exclusive:true })
    if (filterCloseTo === null) throw historyError('bridge_history_filter_close_end_invalid')
  }
  const intersectedFilterStart = Math.max(effectiveStart, filterCloseFrom ?? effectiveStart)
  const intersectedFilterEnd = Math.min(rangeEnd, filterCloseTo ?? rangeEnd)
  if (intersectedFilterStart >= intersectedFilterEnd) {
    throw historyError('bridge_history_filter_close_out_of_range')
  }

  const effectiveRange = { start_utc_msc:effectiveStart, end_utc_msc:rangeEnd }
  const systemRange = { start_utc_msc:systemStart,
    end_utc_msc:requestedScope === 'custom' ? rangeEnd : capturedEnd }
  const allowedRange = { start_utc_msc:allowedStart, end_utc_msc:capturedEnd }

  return {
    scope: requestedScope,
    requested_scope: requestedScope,
    trading_account_id: Number(ownership.trading_account_id) || null,
    range_start_utc_msc: effectiveStart,
    range_end_utc_msc: rangeEnd,
    captured_end_utc_msc: capturedEnd,
    allowed_start_utc_msc: allowedStart,
    system_start_utc_msc: systemStart,
    effective_start_utc_msc: effectiveStart,
    allowed_range: allowedRange,
    system_range: systemRange,
    effective_range: effectiveRange,
    absolute_floor_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC,
    query_floor_utc_msc:allowedStart,
    scope_start_override:hasOverride ? String(overrideValue) : null,
    override_applied:overrideApplied,
    saved_start_date:savedStartDate,
    preference_start_date:savedStartDate,
    preference_source:preferenceSource,
    preference_applied:preferenceApplied,
    preference_invalid:preferenceInvalid,
    preference_invalid_reason:preferenceInvalidReason,
    first_connected_utc_msc: platformStart,
    platform_start_utc_msc: platformStart,
    ownership_start_utc_msc: ownershipStart,
    ownership_revision: ownership?.ownership_history_id == null
      ? null : String(ownership.ownership_history_id),
    filter_close_from_utc_msc:intersectedFilterStart,
    filter_close_to_utc_msc:intersectedFilterEnd,
    filter_close_from:filterCloseFromValue || null,
    filter_close_to:filterCloseToValue || null,
    timezone_offset_minutes:terminalClock?.timezone_offset_minutes ?? null,
    clock_status:terminalClock?.clock_status || 'unavailable',
    clock_source:terminalClock?.clock_source || null,
  }
}

const BRIDGE_SQLITE_SUMMARY_SOURCE = 'bridge_sqlite_summary_v2'

function bridgeSummaryNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function bridgeSummaryRange(range) {
  if (!range || typeof range !== 'object') return null
  const start = Number(range.range_start_utc_msc) || null
  const end = Number(range.range_end_utc_msc ?? range.captured_end_utc_msc) || null
  const allowedStart = Number(range.allowed_start_utc_msc) || null
  const systemStart = Number(range.system_start_utc_msc) || null
  const effectiveStart = Number(range.effective_start_utc_msc) || null
  const capturedEnd = Number(range.captured_end_utc_msc ?? range.range_end_utc_msc) || null
  return {
    scope:String(range.scope || range.requested_scope || 'platform'),
    start_utc_msc:start,
    end_utc_msc:end,
    range_start_utc_msc:start,
    range_end_utc_msc:end,
    allowed_start_utc_msc:allowedStart,
    system_start_utc_msc:systemStart,
    effective_start_utc_msc:effectiveStart,
    captured_end_utc_msc:capturedEnd,
    allowed_range:{ start_utc_msc:allowedStart, end_utc_msc:capturedEnd },
    system_range:{ start_utc_msc:systemStart, end_utc_msc:capturedEnd },
    effective_range:{ start_utc_msc:effectiveStart, end_utc_msc:capturedEnd },
    override_applied:Boolean(range.override_applied),
    timezone_offset_minutes:Number.isInteger(Number(range.timezone_offset_minutes))
      ? Number(range.timezone_offset_minutes) : null,
    clock_status:String(range.clock_status || 'unavailable'),
  }
}

function bridgeSummaryUnavailable(error, range = null, extra = {}) {
  const code = String(error || 'bridge_sqlite_summary_unavailable')
  return {
    status:'error',
    source:BRIDGE_SQLITE_SUMMARY_SOURCE,
    data_complete:false,
    error:code,
    message:code,
    ...(range ? { range:bridgeSummaryRange(range) } : {}),
    ...extra,
  }
}

export function mapBridgePerformanceSummaryResult(result, resolvedRange) {
  const range = bridgeSummaryRange(resolvedRange)
  if (!result || result.status !== 'success') {
    const code = String(result?.error || result?.code || result?.message || 'bridge_sqlite_summary_read_failed')
    const coverageCode = ['history_cursor_range_incomplete', 'history_range_incomplete',
      'bridge_store_history_range_incomplete'].includes(code)
      ? 'bridge_sqlite_summary_coverage_incomplete' : code
    return bridgeSummaryUnavailable(coverageCode, resolvedRange)
  }
  const sync = result.history_sync && typeof result.history_sync === 'object'
    ? result.history_sync : null
  const statistics = result.statistics && typeof result.statistics === 'object'
    ? result.statistics : null
  if (!sync || sync.requested_range_complete !== true || sync.coverage_complete !== true) {
    return bridgeSummaryUnavailable('bridge_sqlite_summary_coverage_incomplete', resolvedRange, {
      history_sync:sync,
      revision:sync ? {
        history:Number(sync.history_revision) || null,
        summary:Number(sync.summary_revision) || null,
      } : null,
    })
  }
  const historyRevision = Number(sync.history_revision)
  const summaryRevision = Number(sync.summary_revision)
  if (sync.summary_status !== 'ready'
    || !Number.isSafeInteger(historyRevision) || historyRevision <= 0
    || !Number.isSafeInteger(summaryRevision) || summaryRevision !== historyRevision
    || !statistics) {
    return bridgeSummaryUnavailable('bridge_sqlite_summary_not_ready', resolvedRange, {
      history_sync:sync,
      revision:{ history:historyRevision || null, summary:summaryRevision || null },
    })
  }

  const totalProfit = bridgeSummaryNumber(statistics.total_profit)
  const netResult = bridgeSummaryNumber(statistics.net_result)
  const deposit = bridgeSummaryNumber(statistics.deposit)
  const withdrawal = bridgeSummaryNumber(statistics.withdrawal)
  const credit = bridgeSummaryNumber(statistics.credit)
  const totalVolume = bridgeSummaryNumber(statistics.total_volume)
  const tradeCount = bridgeSummaryNumber(statistics.trade_count)
  const netFunding = deposit === null || withdrawal === null || credit === null
    ? null : deposit - withdrawal + credit
  const rangeOffset = Number.isInteger(Number(range?.timezone_offset_minutes))
    ? Number(range.timezone_offset_minutes) : 0
  const periodStart = range?.start_utc_msc
    ? new Date(range.start_utc_msc + rangeOffset * 60_000).toISOString().slice(0, 10) : null
  const periodEnd = range?.end_utc_msc
    ? new Date(range.end_utc_msc - 1 + rangeOffset * 60_000).toISOString().slice(0, 10) : null
  const performance = {
    period_start_date:periodStart,
    period_end_date:periodEnd,
    trade_profit:totalProfit,
    commission:null,
    swap:null,
    fee:null,
    pnl_adjustment:null,
    realized_net:totalProfit,
    deposit,
    withdrawal,
    credit_change:credit,
    other_capital_change:null,
    net_funding:netFunding,
    net_account_change:netResult,
    exit_deal_count:tradeCount,
    closed_position_count:tradeCount,
    winning_exit_count:null,
    losing_exit_count:null,
    closed_volume:totalVolume,
    trade_count:tradeCount,
    total_profit:totalProfit,
    net_result:netResult,
    account_balance:bridgeSummaryNumber(statistics.account_balance),
    account_principal:bridgeSummaryNumber(statistics.account_principal),
    data_complete:true,
    sync_status:'ready',
    source:BRIDGE_SQLITE_SUMMARY_SOURCE,
  }
  return {
    status:'success',
    source:BRIDGE_SQLITE_SUMMARY_SOURCE,
    data_complete:true,
    ...performance,
    performance,
    statistics,
    history_sync:sync,
    revision:{ history:historyRevision, summary:summaryRevision },
    range,
  }
}

/**
 * Read the account's immutable platform history summary from Bridge SQLite.
 *
 * This is intentionally read-only: no performance_daily command, MT refresh,
 * or MySQL totals fallback is permitted on the user-facing risk-center path.
 * An unavailable/partial summary remains an explicit incomplete response so
 * callers cannot mistake zeros for a verified account performance result.
 */
export async function getBridgePerformanceSummary(userId, tradingAccountId) {
  const numericUserId = Number(userId)
  const numericAccountId = Number(tradingAccountId)
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0
    || !Number.isSafeInteger(numericAccountId) || numericAccountId <= 0) {
    return bridgeSummaryUnavailable('bridge_sqlite_summary_account_invalid')
  }

  const route = getBridgeDataRoute(numericUserId, numericAccountId, { strictAccount:true })
  if (!route || !isBridgeAlive(numericUserId)) {
    return bridgeSummaryUnavailable('bridge_sqlite_summary_bridge_offline')
  }
  if (!hasHistoryExactRangeCapability(route)) {
    return bridgeSummaryUnavailable('bridge_sqlite_summary_exact_range_unsupported')
  }

  let resolvedRange
  try {
    // Platform is the only default user-visible scope.  It is anchored to the
    // current stable binding's first_connected_at and never to ownership.
    resolvedRange = await resolveHistoryRange(numericUserId, {
      history_scope:'platform',
    }, route, Date.now())
  } catch (error) {
    return bridgeSummaryUnavailable(error?.code || error?.message || 'bridge_sqlite_summary_range_unavailable')
  }
  const range = bridgeSummaryRange(resolvedRange)

  const cursorMode = hasHistoryCursorCapability(route)
  const action = cursorMode ? 'history_page' : 'history'
  const params = {
    ...bridgeRouteParams(route),
    page:1,
    page_size:1,
    range_start_utc_msc:resolvedRange.range_start_utc_msc,
    range_end_utc_msc:resolvedRange.range_end_utc_msc,
    allowed_start_utc_msc:resolvedRange.allowed_start_utc_msc,
    system_start_utc_msc:resolvedRange.system_start_utc_msc,
    effective_start_utc_msc:resolvedRange.effective_start_utc_msc,
    captured_end_utc_msc:resolvedRange.captured_end_utc_msc,
    force_refresh:false,
  }

  let result
  try {
    result = await sendBridgeCommand(numericUserId, action, params, 5_000, { noFallback:true })
  } catch (error) {
    return bridgeSummaryUnavailable(error?.code || error?.message || 'bridge_sqlite_summary_read_failed', resolvedRange)
  }
  return mapBridgePerformanceSummaryResult(result, resolvedRange)
}

export function sendToAdminBrowsers(data) {
  let json
  try { json = JSON.stringify(data) } catch { return 0 }
  let delivered = 0
  for (const ws of adminBrowsers) {
    if (ws.readyState === 1) {
      try { ws.send(json); delivered++ } catch {}
    } else {
      adminBrowsers.delete(ws)
    }
  }
  return delivered
}

export function disconnectUserBridgeConnections(userId, reason = 'Bridge session revoked') {
  const id = Number(userId)
  if (typeof bridgeV3Business?.disconnectUser === 'function') {
    bridgeV3Business.disconnectUser(id, reason)
  }
}

export function disconnectUserSockets(userId, reason = 'Session revoked') {
  const id = Number(userId)
  const browserSet = browsers.get(id)
  if (browserSet) {
    for (const ws of browserSet) {
      try { ws.close(4002, reason) } catch {}
    }
    browsers.delete(id)
  }
  disconnectUserBridgeConnections(id, reason)
  for (const ws of adminBrowsers) {
    if (Number(ws._userId) !== id) continue
    try { ws.close(4002, reason) } catch {}
    adminBrowsers.delete(ws)
  }
}

export function broadcastAdminEvent(scope, reason, data = {}, options = {}) {
  const scopes = [...new Set((Array.isArray(options.scopes) ? options.scopes : [scope])
    .map(value => String(value || '').trim()).filter(Boolean))]
  const now = Date.now()
  const throttleKey = String(options.throttleKey || '')
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0)
  if (throttleKey && minIntervalMs > 0) {
    const previous = adminEventThrottle.get(throttleKey) || 0
    if (now - previous < minIntervalMs) return false
    adminEventThrottle.set(throttleKey, now)
  }
  return sendToAdminBrowsers({
    type:'admin_event',
    event_id:`${now}-${++adminEventSeq}`,
    scope:String(scope || 'system'),
    scopes,
    reason:String(reason || 'updated'),
    refresh:options.refresh !== false,
    changed_at:new Date(now).toISOString(),
    data:data && typeof data === 'object' ? data : {},
  })
}

export function buildBridgeDataChangedEvent(update = {}) {
  const stream = String(update.stream || '')
  if (!['account', 'positions', 'history'].includes(stream)) return null
  const revision = Number(update.revision)
  const event = {
    type:'bridge_data_changed',
    streams:[stream],
    terminal_instance_id:String(update.terminal?.terminal_instance_id || ''),
    revision:Number.isSafeInteger(revision) && revision > 0 ? revision : null,
  }
  if (stream === 'history') {
    event.history_revision = event.revision
    event.freshness_state = String(update.freshness_state || '') || null
  }
  return event
}

export function buildObserverBrowserPayload(data = {}) {
  if (data.type === 'data') {
    return {
      type: 'platform_market_tick',
      quote:data.quote || null,
      trade_mode:typeof data.trade_mode === 'number' ? data.trade_mode : -1,
      _source: 'observer_channel',
    }
  }
  if (data.type === 'bridge_data_changed') {
    const streams = [...new Set((Array.isArray(data.streams) ? data.streams : [])
      .map(value => String(value || '')).filter(value => ['account', 'positions', 'history'].includes(value)))]
    if (!streams.length) return null
    const payload = { type:'bridge_data_changed', streams, _source: 'observer_channel' }
    if (streams.includes('history')) {
      const revision = Number(data.history_revision ?? data.revision)
      payload.history_revision = Number.isSafeInteger(revision) && revision > 0 ? revision : null
      payload.freshness_state = String(data.freshness_state || '') || null
    }
    return payload
  }
  return null
}

function notifyBridgeV3DataChanged(update = {}) {
  const event = buildBridgeDataChangedEvent(update)
  if (event) sendToBrowsers(Number(update.userId), event)
}

const MANUAL_AUTO_EXECUTE_DISCONNECTED = 'manual_auto_execute_request_disconnected'
const BRIDGE_HISTORY_BROWSER_ACTIONS = new Set([
  'history', 'history_page', 'history_evidence', 'history_chart_data', 'export_history',
  'history_prepare_status_v1',
])

function browserSetForUser(userId) {
  return browsers.get(userId) || browsers.get(Number(userId)) || null
}

export function isBrowserSocketRegistered(userId, ws) {
  return ws?.readyState === 1 && Boolean(browserSetForUser(userId)?.has(ws))
}

export function createBrowserAutoExecuteGuard(userId, ws) {
  const controller = new AbortController()
  let disposed = false
  const disconnected = () => Object.assign(
    new Error(MANUAL_AUTO_EXECUTE_DISCONNECTED),
    { code:MANUAL_AUTO_EXECUTE_DISCONNECTED },
  )
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(disconnected())
  }
  const assertConnected = () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error ? controller.signal.reason : disconnected()
    }
    if (!isBrowserSocketRegistered(userId, ws)) {
      abort()
      throw controller.signal.reason
    }
    return true
  }
  ws.on?.('close', abort)
  ws.on?.('error', abort)
  if (!isBrowserSocketRegistered(userId, ws)) abort()
  return {
    signal:controller.signal,
    assertConnected,
    dispose() {
      if (disposed) return
      disposed = true
      ws.off?.('close', abort)
      ws.off?.('error', abort)
    },
  }
}

function sendToBrowsers(userId, data) {
  const set = browsers.get(userId)
  if (set) {
    const json = JSON.stringify(data)
    for (const ws of set) {
      if (ws.readyState === 1) {
        try { ws.send(json) } catch {}
      } else {
        set.delete(ws)
      }
    }
  }
  // Forward only sanitized notifications to browsers whose resolved observer
  // channel points at this exact source. Account and position values are read
  // through the observer-authorized command route instead of being broadcast.
  const observerPayload = buildObserverBrowserPayload(data)
  if (observerPayload && browsers.size > 0) {
    const observerJson = JSON.stringify(observerPayload)
    const now = Date.now()
    for (const [uid, browserSet] of browsers) {
      const last = _broadcastThrottle.get(uid) || 0
      if (now - last < 250) continue // skip if < 250ms since last broadcast
      let delivered = false
      for (const ws of browserSet) {
        if (Number(ws._observerBridgeUserId || 0) !== Number(userId)) continue
        if (ws.readyState === 1) {
          try { ws.send(observerJson); delivered = true }
          catch (e) { console.error('[BridgeWS] observer broadcast send failed:', uid, e.message) }
        } else {
          browserSet.delete(ws)
        }
      }
      if (delivered) _broadcastThrottle.set(uid, now)
    }
  }
}

// Handle browser commands — route to bridge
export function buildBrowserCommandResult(commandId, data = {}) {
  return { ...data, type:'result', command_id:commandId }
}

export async function runBrowserAutoExecuteWithModelTask(ai, userId, params, commandId, guard, dependencies = {}) {
  const { createModelTaskTracker } = dependencies.createModelTaskTracker
    ? dependencies : await import('./routes/ai/model-task-tracker.js')
  const { modelTaskDeadlines } = dependencies.modelTaskDeadlines
    ? dependencies : await import('./routes/ai/model-task-budget.js')
  const { modelProviderProtocol } = dependencies.modelProviderProtocol
    ? dependencies : await import('./routes/ai/model-providers.js')
  const nowUtcMs = Date.now()
  const deadlines = modelTaskDeadlines('manual_analysis', { nowUtcMs })
  const requestParams = { ...(params || {}), auto_execute:true }
  const frozenParams = {
    session_id:String(requestParams.session_id || 'default').trim().slice(0, 191) || 'default',
    symbol:String(requestParams.symbol || '').trim().slice(0, 64),
    strategy_id:Number(requestParams.strategy_id) || 0,
    auto_execute:true,
  }
  const inputHash = crypto.createHash('sha256').update(JSON.stringify({
    ...frozenParams,
  })).digest('hex')
  const requestKey = String(commandId || '').trim() || inputHash
  const modelConfig = await ai.getAnalyzeApiKey(userId, String(requestParams.session_id || 'default'),
    Number(requestParams.strategy_id))
  const provider = modelConfig?.api_provider || modelConfig?.provider
  const model = modelConfig?.model_name || modelConfig?.model
  const modelProfileId = Number(modelConfig?._model_profile_id || modelConfig?.model_profile_id) || null
  const protocol = modelConfig?.protocol || modelConfig?._protocol || modelProviderProtocol(provider) || 'chat_completions'
  const credentialSource = modelConfig?._credential_source || modelConfig?.credential_source || null
  if (!provider || !model || !modelProfileId || !protocol || !credentialSource) {
    throw Object.assign(new Error('manual_analysis_model_identity_unavailable'),
      { code:'manual_analysis_model_identity_unavailable' })
  }
  const tracker = await createModelTaskTracker({
    taskKind:'manual_analysis', queueClass:'interactive', ownerUserId:Number(userId) || 0,
    strategyId:Number(params?.strategy_id) || null, domainType:'manual_analysis_ws',
    domainId:String(commandId || inputHash).slice(0, 191), idempotencyKey:`manual_ws:${Number(userId)}:${requestKey.slice(0, 150)}`,
    inputHash, promptHash:null, outputContractHash:null, provider, model,
    modelProfileId, protocol, credentialSource,
    frozenContext:{ request_params:frozenParams, auto_execute:true },
    taskDeadlineAtUtcMs:deadlines.taskDeadlineUtcMs,
    resultValidUntilUtcMs:deadlines.taskDeadlineUtcMs, maxAttempts:1,
  }, { workerId:`manual-analysis-ws:${process.pid}` })
  const mergedSignal = typeof AbortSignal?.any === 'function'
    ? AbortSignal.any([guard.signal, tracker.signal]) : guard.signal
  try {
    guard.assertConnected()
    const result = await ai.handleAnalyze(userId, requestParams, {
      taskId:tracker.taskId, abortSignal:mergedSignal,
      expectedModelIdentity:{ provider:String(provider), model:String(model), modelProfileId,
        protocol:String(protocol), credentialSource:String(credentialSource) },
      assertAutoExecute:guard.assertConnected,
      taskDeadlineAtUtcMs:Number(tracker.task?.task_deadline_at_utc_msc) || deadlines.attemptSafetyDeadlineUtcMs,
      resultValidUntilUtcMs:Number(tracker.task?.result_valid_until_utc_msc) || deadlines.attemptSafetyDeadlineUtcMs,
      onInferencePrepared:evidence => tracker.persistBudget(evidence?.modelTaskBudget),
      onProviderRequest:event => tracker.onProviderRequest(event),
      onProviderUsage:event => tracker.onProviderUsage(event),
      onProviderActivity:event => tracker.onProviderActivity(event),
      onProviderQuiet:event => tracker.onProviderQuiet(event),
    })
    if (result?.status === 'success') {
      await tracker.resultReady({ resultHash:crypto.createHash('sha256').update(JSON.stringify(result.signal || result)).digest('hex') })
      await tracker.applying()
      await tracker.succeeded({ resultRef:`ai_signals:${result.signal?.id || tracker.taskId}` })
    } else {
      const failure = Object.assign(new Error(result?.error_code || result?.message || 'manual_analysis_failed'),
        { code:result?.error_code || 'manual_analysis_failed' })
      await tracker.failed(failure, true)
    }
    return result
  } catch (error) {
    await tracker.failed(error, true).catch(() => {})
    throw error
  } finally {
    try { await tracker.stop?.() } catch {}
  }
}

// Notification wake-ups are addressed only to the authenticated user's own
// browser sockets.  Do not call sendToBrowsers here: that helper intentionally
// forwards a small set of market/read-model events to observer channels, while
// a user notification must never cross that boundary.
export function sendNotificationCreatedToUser(userId, data = {}) {
  const numericUserId = Number(userId)
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) return 0
  const set = browsers.get(numericUserId) || browsers.get(userId)
  if (!set) return 0
  const payload = {
    type:'notification_created',
    notificationId:Number(data.notificationId) || null,
    priority:['normal', 'important'].includes(String(data.priority || '')) ? String(data.priority) : 'normal',
    requiresAck:Boolean(data.requiresAck),
    unreadCount:Math.max(0, Number(data.unreadCount) || 0),
  }
  const json = JSON.stringify(payload)
  let delivered = 0
  for (const ws of set) {
    if (ws.readyState === 1) {
      try { ws.send(json); delivered++ } catch {}
    } else set.delete(ws)
  }
  return delivered
}

// Signal detail and evidence deliberately share this visibility lookup.  A
// signal id alone is never sufficient: shared deliveries, observer strategy
// scope, and legacy owner/platform rows all participate in the same check.
async function loadVisibleSignalRecord(signalId, detailUserId, observerStrategyId) {
  const adminTargetRow = await queryOne(
    `SELECT t.id AS target_id, t.dispatch_id AS target_dispatch_id, t.target_role AS target_role,
        t.subscription_id AS target_subscription_id, t.status AS target_status,
        t.trade_ticket AS target_trade_ticket, t.execution_result_json AS target_execution_result_json,
        t.order_intent_id AS target_order_intent_id, t.completed_at AS target_completed_at
      FROM admin_strategy_trade_targets t JOIN ai_signals s ON s.id = t.signal_id
      WHERE t.signal_id = ? AND t.user_id = ?
        ${observerStrategyId ? 'AND s.prompt_type_id = ?' : ''}
      ORDER BY (t.target_role = 'source') DESC, t.id DESC LIMIT 1`,
    [signalId, detailUserId, ...(observerStrategyId ? [observerStrategyId] : [])],
  )
  if (adminTargetRow) {
    const adminTarget = {
      id: adminTargetRow.target_id, dispatch_id: adminTargetRow.target_dispatch_id,
      target_role: adminTargetRow.target_role, subscription_id: adminTargetRow.target_subscription_id,
      status: adminTargetRow.target_status, trade_ticket: adminTargetRow.target_trade_ticket,
      execution_result_json: adminTargetRow.target_execution_result_json,
      order_intent_id: adminTargetRow.target_order_intent_id, completed_at: adminTargetRow.target_completed_at,
    }
    return {
      target: adminTarget,
      delivery: null,
      row: await queryOne('SELECT * FROM ai_signals WHERE id = ?', [signalId]),
      source: 'admin_strategy_dispatch',
    }
  }
  const delivery = await queryOne(
    `SELECT * FROM auto_signal_deliveries WHERE signal_id = ? AND user_id = ?
      ${observerStrategyId ? 'AND prompt_type_id = ?' : ''}`,
    [signalId, detailUserId, ...(observerStrategyId ? [observerStrategyId] : [])],
  )
  if (delivery) {
    return {
      delivery,
      target: null,
      row: await queryOne('SELECT * FROM ai_signals WHERE id = ?', [signalId]),
      source: 'auto_shared',
    }
  }
  return {
    delivery: null,
    target: null,
    row: await queryOne(`SELECT * FROM ai_signals WHERE id = ? AND (user_id = ? OR user_id = 0)
      ${observerStrategyId ? 'AND prompt_type_id = ?' : ''}`,
    [signalId, detailUserId, ...(observerStrategyId ? [observerStrategyId] : [])]),
    source: 'manual',
  }
}

function applyVisibleSignalRecord(row, delivery, source, { target = null, includeLegacyMarketData = true } = {}) {
  const result = { ...row }
  // A frozen snapshot is the authoritative market object for new signals. Do
  // not parse and serialize the legacy market_data_json alongside it; old rows
  // without a snapshot retain the original field for compatibility.
  if (includeLegacyMarketData) {
    try { result.market_data = JSON.parse(result.market_data_json) } catch { result.market_data = {} }
  }
  delete result.market_data_json
  if (target) {
    result.is_executed = target.status === 'succeeded'
    result.executed_at = target.completed_at || null
    result.trade_ticket = target.trade_ticket || null
    result.pending_ticket = null
    result.pending_state = null
    result.execution_result = target.execution_result_json || null
    result.execution_status = target.status
    result.admin_strategy_target_id = target.id
    result.admin_strategy_dispatch_id = target.dispatch_id
    result.admin_strategy_target_role = target.target_role
    result.subscription_id = target.subscription_id
    result.order_intent_id = target.order_intent_id
  } else if (delivery) {
    result.is_executed = !!delivery.is_executed
    result.executed_at = delivery.executed_at
    result.trade_ticket = delivery.trade_ticket
    result.pending_ticket = delivery.pending_ticket
    result.pending_state = delivery.pending_state
    result.pending_valid_until = delivery.pending_valid_until || result.pending_valid_until
    result.execution_result = delivery.execution_result
    result.approved_order_json = delivery.approved_order_json
    result.execution_status = delivery.execution_status
    result.delivery_id = delivery.id
    result.prompt_type_id = delivery.prompt_type_id
  } else {
    result.is_executed = !!result.is_executed
  }
  result.source = target ? 'admin_strategy_dispatch' : (delivery ? 'auto_shared' : (result.source || source))
  const executionValidation = readExecutionValidation(result)
  if (executionValidation.explicit) result.execution_validation = executionValidation.validation
  return result
}

async function handleBrowserCommand(ws, userId, msg) {
  const { command_id, action, params = {} } = msg
  const autoExecuteRequested = params?.auto_execute === true
    || String(params?.auto_execute || '').toLowerCase() === 'true'
  const analyzeParams = action === 'analyze'
    ? { ...(params || {}), auto_execute:autoExecuteRequested } : params
  const autoExecuteGuard = action === 'analyze' && autoExecuteRequested
    ? createBrowserAutoExecuteGuard(userId, ws) : null
  const reply = (data) => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(buildBrowserCommandResult(command_id, data))) } catch (error) {
        console.error(`[BridgeWS] browser command reply failed command=${command_id}:`, error.message)
      }
    }
  }

  // History maintenance is an explicit server-side switch.  Reject before
  // resolving a terminal route so a disabled read cannot dispatch to Bridge,
  // fall back to an older protocol, or close the browser session.
  if (BRIDGE_HISTORY_BROWSER_ACTIONS.has(action) && !isBridgeHistoryReadsEnabled()) {
    return reply(bridgeHistoryTemporarilyUnavailableResult())
  }

  try {
    const ai = await import('./routes/ai/index.js')
    const user = await queryOne(`SELECT plan, role, plan_expires_at, plan_source,
      (SELECT connection_enabled FROM user_bridge_settings WHERE user_id = users.id LIMIT 1) AS connection_enabled
      FROM users WHERE id = ?`, [userId])
    const access = buildAiAccessContext(user, { ownBridgeConnected:isBridgeAlive(userId) })
    if (!observerWsActionAllowed(access, action)) {
      const code = access.mode === 'blocked' ? access.reason : 'observer_read_only'
      return reply({ status:'error', code, message:observerAccessError(access), access })
    }
    const observerContext = access.mode === 'observer'
      ? await resolveObserverBridgeContext(userId, user, params.observer_channel_id)
      : null
    const dataUserId = access.mode === 'observer' ? observerContext.bridgeUserId : userId
    const observerStrategyId = access.mode === 'observer'
      ? Number(observerContext?.channel?.strategy_id || 0) || null
      : null
    const dataRoute = dataUserId ? bridgeV3RouteForContext(
      dataUserId, observerContext?.channel?.trading_account_id) : null
    const routedParams = value => ({ ...(value || {}), ...bridgeRouteParams(dataRoute) })
    ws._observerBridgeUserId = access.mode === 'observer' ? Number(dataUserId) || null : null
    ws._observerStrategyId = observerStrategyId
    if (access.mode === 'observer' && action !== 'health' && !dataUserId) {
      return reply({ status:'error', code:'observer_source_offline', message:'管理员观摩账户当前未连接' })
    }

    // Block trade operations when bridge is offline or trading is disabled
    const tradeActions = ['open', 'close', 'execute']
    if (tradeActions.includes(action)) {
      if (!isBridgeAlive(userId)) {
        return reply({ status: 'error', message: '请先连接您的 MT5 账户' })
      }
      if (!isTradeEnabled(userId)) {
        return reply({ status: 'error', message: '交易发送已关闭，请先开启' })
      }
    }

    let result
    switch (action) {
      case 'health': {
        const usingFallback = access.read_only
        const connected = Boolean(dataUserId && isBridgeAlive(dataUserId))
        const alive = connected
        const tradeEnabled = usingFallback
          ? (alive ? isTradeEnabled(dataUserId) : null)
          : alive && isTradeEnabled(dataUserId)
        const autoReasoningEnabled = usingFallback
          ? (alive ? await readAutomaticAnalysisEnabled(dataUserId) : null)
          : await readAutomaticAnalysisEnabled(userId)
        result = {
          status: 'success',
          gateway: {
            mode: alive ? 'live' : 'mock',
            mt5_package_available: true,
            live_trading_enabled: tradeEnabled,
            auto_reasoning_enabled: autoReasoningEnabled,
            platform:dataRoute?.platform || bridgePlatform(
              dataUserId, observerContext?.channel?.trading_account_id),
            terminal_instance_id:dataRoute?.terminal_instance_id || null,
            using_fallback: usingFallback,
            trade_mode: dataUserId ? await getBridgeTradeMode(dataUserId) : -1,
            connection_desired_state:user.connection_enabled == null || Number(user.connection_enabled) === 1
              ? 'enabled' : 'paused',
            access:{ ...access, observer_source_available:Boolean(dataUserId),
              observer_channel:observerContext?.channel || null },
          },
        }
        break
      }
      case 'account': {
        const hasDataBridge = dataUserId && isBridgeAlive(dataUserId)
        if (hasDataBridge) {
          result = await ai.mt5Bridge(dataUserId, 'account', routedParams(), { noFallback:true })
          if (access.read_only && result && typeof result === 'object') result.observer_source = true
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'symbols':
        result = await ai.mt5Bridge(dataUserId, 'symbols', routedParams(), { noFallback:true })
        break
      case 'platform_quote': {
        const defaultMarket = await resolveDefaultPlatformMarketContext(user, params.symbol)
        if (!defaultMarket.eligible || !defaultMarket.configured || !defaultMarket.supported) {
          if (ws._sharedQuoteKind === 'default_market') observerQuoteFeeds.unsubscribe(ws)
          ws._sharedQuoteKind = null
          ws._observerQuoteSymbol = null
          result = { status:'success', available:false, source:'own_account' }
        } else if (!defaultMarket.alive) {
          observerQuoteFeeds.unsubscribe(ws)
          ws._sharedQuoteKind = 'default_market'
          ws._observerQuoteSymbol = String(params.symbol || '').trim().toUpperCase()
          result = {
            status:'success', available:true, online:false,
            source:'default_observer', error:'observer_source_offline',
          }
        } else {
          ws._sharedQuoteKind = 'default_market'
          ws._observerQuoteSymbol = String(params.symbol || '').trim().toUpperCase()
          const quote = await observerQuoteFeeds.subscribe(ws,
            observerQuoteDescriptor(defaultMarket.bridgeUserId, {
              channel:{ trading_account_id:defaultMarket.source.trading_account_id },
            }, defaultMarket.dataRoute, ws._observerQuoteSymbol))
          result = { ...quote, available:true, source:'default_observer' }
        }
        break
      }
      case 'quote': {
        if (access.mode === 'observer' && dataUserId && isBridgeAlive(dataUserId)) {
          ws._sharedQuoteKind = 'observer'
          ws._observerQuoteSymbol = String(params.symbol || '').trim().toUpperCase()
          result = await observerQuoteFeeds.subscribe(ws,
            observerQuoteDescriptor(dataUserId, observerContext, dataRoute, ws._observerQuoteSymbol))
        } else if (dataUserId && isBridgeAlive(dataUserId)) {
          result = await ai.mt5Bridge(dataUserId, 'quote', routedParams({ symbol: params.symbol }), { noFallback:true })
          if (result?.status === 'success') recordBridgeMarketState(dataUserId, result, Date.now(), {
            terminalInstanceId:dataRoute?.terminal_instance_id,
            tradingAccountId:observerContext?.channel?.trading_account_id,
          })
        } else {
          if (access.mode === 'observer') observerQuoteFeeds.unsubscribe(ws)
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'positions': {
        if (dataUserId && isBridgeAlive(dataUserId)) {
          result = await ai.mt5Bridge(dataUserId, 'positions', routedParams(), { noFallback:true })
          if (access.read_only && result && typeof result === 'object') result.observer_source = true
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'open': {
        // Check trade send enabled
        const openConnected = isBridgeAlive(userId)
        const openTradeEnabled = openConnected && isTradeEnabled(userId)
        if (!openConnected || !openTradeEnabled) {
          result = { status: 'rejected', message: !openConnected ? 'MT5 桥接未连接' : '交易发送已关闭，请先开启', details: {} }
          await ai.insertAudit(null, userId, 'manual_open', params.symbol, params, result, 'rejected')
          break
        }
        result = await ai.executeManualOrderCore(userId, params, 'manual_open')
        break
      }
      case 'close': {
        const closeConnected = isBridgeAlive(userId)
        const closeTradeEnabled = closeConnected && isTradeEnabled(userId)
        const closeParams = {
          ticket:params.ticket,
          confirm:params.confirm === true,
          expected_state:params.expected_state,
        }
        if (!closeParams.confirm) {
          result = { status:'rejected', message:'manual_confirmation_required' }
          await ai.insertAudit(null, userId, 'manual_close', null, closeParams, result, 'rejected')
          break
        }
        if (!closeConnected || !closeTradeEnabled) {
          result = { status: 'rejected', message: !closeConnected ? 'MT5 桥接未连接' : '交易发送已关闭，请先开启', details: {} }
          await ai.insertAudit(null, userId, 'manual_close', null, closeParams, result, 'rejected')
          break
        }
        result = await ai.mt5Bridge(userId, 'close', closeParams)
        await ai.insertAudit(null, userId, 'manual_close', null, closeParams, result, result?.status || 'unknown')
        break
      }
      case 'toggle_trade': {
        result = await ai.mt5Bridge(userId, 'toggle_trade', { enable: !!params.enable })
        // Persist to DB
        const newEnabled = !!params.enable
        try {
          await queryRun(
            'INSERT INTO user_bridge_settings (user_id, trade_send_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE trade_send_enabled = ?, updated_at = NOW()',
            [userId, newEnabled ? 1 : 0, newEnabled ? 1 : 0]
          )
        } catch (e) { console.error('[BridgeWS] Failed to persist trade_send_enabled:', e.message) }
        break
      }
      case 'set_quote_symbol': {
        const symbol = params.symbol || 'XAUUSD'
        result = await ai.mt5Bridge(userId, 'set_quote_symbol', { symbol })
        // Persist to user config so bridge reconnects with this symbol
        if (result.status === 'success') {
          const key = `quote_symbol_${userId}`
          const existing = await queryOne('SELECT id FROM system_config WHERE `key` = ?', [key])
          if (existing) await queryRun('UPDATE system_config SET `value` = ? WHERE `key` = ?', [symbol, key])
          else await queryRun('INSERT INTO system_config (category, `key`, `value`) VALUES (?, ?, ?)', ['quote_symbol', key, symbol])
        }
        break
      }
      case 'history_range_preference_set': {
        // Observer writes never reach this switch: the access gate above
        // permits only OBSERVER_WS_READ_ACTIONS for read-only sessions.  For
        // an owner, dataRoute is selected from the authenticated user's
        // current preferred terminal; request identity fields are ignored by
        // setHistoryRangePreference and cannot retarget another account.
        const exactRoute = assertHistoryPreferenceRoute(dataRoute)
        result = await setHistoryRangePreference(userId, exactRoute, params, Date.now())
        break
      }
      case 'history': {
        const exactRoute = assertHistoryExactRoute(dataRoute)
        const bridgeOk = dataUserId && isBridgeAlive(dataUserId)
        if (bridgeOk) {
          const cursorMode = hasHistoryCursorCapability(exactRoute)
          const bridgeParams = {
            page_size: normalizeBridgePageSize(params.page_size),
            direction: params.direction || '',
            profit_filter: params.profit_filter || '',
            force_refresh: params.force_refresh === true,
          }
          if (cursorMode) {
            const snapshotId = normalizedHistoryCursorToken(params.history_snapshot_id)
            const cursor = normalizedHistoryCursorToken(params.cursor)
            if (cursor && !snapshotId) throw historyError('history_cursor_invalid')
            if (snapshotId) bridgeParams.history_snapshot_id = snapshotId
            if (cursor) bridgeParams.cursor = cursor
          } else {
            bridgeParams.page = normalizeBridgePage(params.page)
          }
          // Keep the first history read on the same trusted UTC anchor used by
          // history_prepare_status_v1. A terminal observation can legitimately
          // be a few milliseconds ahead of the server wall clock; recapturing
          // with bare Date.now() would then reject the just-frozen endpoint as
          // history_cursor_invalid before Bridge receives the request.
          const serverNowUtcMsc = Date.now()
          const nowUtcMsc = historyTerminalClock(dataUserId, exactRoute)
            ? captureHistoryTerminalNowUtcMsc(dataUserId, exactRoute, serverNowUtcMsc)
            : serverNowUtcMsc
          const resolvedRange = await resolveHistoryRange(dataUserId, params, exactRoute, nowUtcMsc)
          const { hasStart, hasEnd } = historyExactRangeFields(params)
          const range = (hasStart || hasEnd || bridgeParams.history_snapshot_id)
            ? historyCursorContinuationRange(params, resolvedRange, nowUtcMsc)
            : resolvedRange
          bridgeParams.range_start_utc_msc = range.range_start_utc_msc
          bridgeParams.range_end_utc_msc = range.range_end_utc_msc
          bridgeParams.allowed_start_utc_msc = range.allowed_start_utc_msc
          bridgeParams.system_start_utc_msc = range.system_start_utc_msc
          bridgeParams.effective_start_utc_msc = range.effective_start_utc_msc
          bridgeParams.captured_end_utc_msc = range.captured_end_utc_msc
          const terminalClock = historyTerminalClock(dataUserId, exactRoute)
          const filterCloseFrom = params.filter_close_from
            ?? params.history_range?.filter_close_from
          const filterCloseTo = params.filter_close_to
            ?? params.history_range?.filter_close_to
          if (filterCloseFrom !== undefined && filterCloseFrom !== '') {
            bridgeParams.filter_close_from = historyDateInputUtcMsc(filterCloseFrom, terminalClock)
          }
          if (filterCloseTo !== undefined && filterCloseTo !== '') {
            bridgeParams.filter_close_to = historyDateInputUtcMsc(filterCloseTo, terminalClock, { endOfDay:true })
          }
          if (params.entry_from !== undefined && params.entry_from !== '') {
            bridgeParams.entry_from = historyDateInputUtcMsc(params.entry_from, terminalClock)
          }
          if (params.entry_to !== undefined && params.entry_to !== '') {
            bridgeParams.entry_to = historyDateInputUtcMsc(params.entry_to, terminalClock, { endOfDay:true })
          }

          result = await ai.mt5Bridge(dataUserId, cursorMode ? 'history_page' : 'history',
            routedParams(bridgeParams), { timeoutMs: 30000, noFallback: true })
          if (result && typeof result === 'object') {
            const activeTradingAccountId = Number(observerContext?.channel?.trading_account_id)
              || Number(bridgeV3TradingAccounts.get(Number(dataUserId))?.get(dataRoute?.terminal_instance_id))
              || null
            await enrichHistoryResultProtection(dataUserId, activeTradingAccountId, result)
            result.history_range = range
            result.scope_range = range.effective_range
            result.filter_close_range = {
              start_utc_msc:range.filter_close_from_utc_msc,
              end_utc_msc:range.filter_close_to_utc_msc,
            }
            result.observer_source = access.read_only
          }
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'history_prepare_status_v1': {
        const exactRoute = assertHistoryPrepareStatusRoute(dataRoute)
        const bridgeOk = dataUserId && isBridgeAlive(dataUserId)
        if (bridgeOk) {
          if (params.history_snapshot_id || params.cursor
            || params.history_range?.history_snapshot_id || params.history_range?.cursor) {
            throw historyError('history_cursor_invalid')
          }
          const nowUtcMsc = captureHistoryTerminalNowUtcMsc(dataUserId, exactRoute, Date.now())
          const resolvedRange = await resolveHistoryRange(dataUserId, params, exactRoute, nowUtcMsc)
          const { hasStart, hasEnd } = historyExactRangeFields(params)
          const range = (hasStart || hasEnd)
            ? historyCursorContinuationRange(params, resolvedRange, nowUtcMsc)
            : resolvedRange
          const bridgeParams = {
            range_start_utc_msc:range.range_start_utc_msc,
            range_end_utc_msc:range.range_end_utc_msc,
            allowed_start_utc_msc:range.allowed_start_utc_msc,
            system_start_utc_msc:range.system_start_utc_msc,
            effective_start_utc_msc:range.effective_start_utc_msc,
            captured_end_utc_msc:range.captured_end_utc_msc,
          }
          const bridgeResult = await ai.mt5Bridge(dataUserId, 'history_prepare_status_v1',
            routedParams(bridgeParams), { timeoutMs:5000, noFallback:true })
          const responseRange = compactHistoryPrepareRange(range)
          // This endpoint is deliberately status-only.  Keep the response
          // bounded even if a future Bridge accidentally includes a history
          // page in its payload.
          result = {
            status:bridgeResult?.status || 'error',
            ...(bridgeResult?.code ? { code:bridgeResult.code } : {}),
            ...(bridgeResult?.error ? { error:bridgeResult.error } : {}),
            ...(bridgeResult?.message ? { message:bridgeResult.message } : {}),
            ...(bridgeResult?.source ? { source:bridgeResult.source } : {}),
            history_sync:bridgeResult?.history_sync && typeof bridgeResult.history_sync === 'object'
              ? bridgeResult.history_sync : null,
            history_range:responseRange,
            scope_range:responseRange.effective_range,
            observer_source:access.read_only,
          }
        } else {
          result = { status:'error', code:'bridge_terminal_not_connected',
            error:'bridge_terminal_not_connected', message:'bridge_terminal_not_connected' }
        }
        break
      }
      case 'history_chart_data': {
        const exactRoute = assertHistoryExactRoute(dataRoute)
        const bridgeOk = dataUserId && isBridgeAlive(dataUserId)
        if (bridgeOk) {
          // 直接调用桥接的 chart_data 命令，返回聚合后的图表数据
          const chartParams = { force_refresh: params.force_refresh === true }
          const nowUtcMsc = Date.now()
          const chartScopeParams = { ...params }
          delete chartScopeParams.filter_close_from
          delete chartScopeParams.filter_close_to
          if (chartScopeParams.history_range && typeof chartScopeParams.history_range === 'object') {
            chartScopeParams.history_range = { ...chartScopeParams.history_range }
            delete chartScopeParams.history_range.filter_close_from
            delete chartScopeParams.history_range.filter_close_to
          }
          const resolvedRange = await resolveHistoryRange(dataUserId, chartScopeParams, exactRoute, nowUtcMsc)
          const { hasStart, hasEnd } = historyExactRangeFields(params)
          const range = hasStart || hasEnd
            ? historyCursorContinuationRange(params, resolvedRange, nowUtcMsc)
            : resolvedRange
          // Reuse the resolved effective/frozen scope exactly.  The chart is
          // an alternate view of the selected history range, not a separate
          // recent-days window.
          const chartStart = range.range_start_utc_msc
          const chartEnd = range.range_end_utc_msc
          chartParams.range_start_utc_msc = chartStart
          chartParams.range_end_utc_msc = chartEnd
          chartParams.allowed_start_utc_msc = range.allowed_start_utc_msc
          chartParams.system_start_utc_msc = range.system_start_utc_msc
          chartParams.effective_start_utc_msc = range.effective_start_utc_msc
          chartParams.captured_end_utc_msc = range.captured_end_utc_msc
          if (params.direction) chartParams.direction = params.direction
          if (params.profit_filter) chartParams.profit_filter = params.profit_filter
          result = await ai.mt5Bridge(dataUserId, 'chart_data', routedParams(chartParams), { timeoutMs: 30000, noFallback: true })
          if (result && typeof result === 'object') {
            result.history_range = range
            result.chart_range = {
              start_utc_msc:chartStart,
              end_utc_msc:chartEnd,
            }
            result.observer_source = access.read_only
          }
        } else {
          result = { status: 'error', message: 'MT5桥接未连接' }
        }
        break
      }
      case 'rates':
        result = await ai.platformRates(userId, {
          symbol:params.symbol,
          timeframe:params.timeframe || 'M30',
          count:params.count || 100,
          browser_market_view:canUseDefaultPlatformMarketSource(user),
          prefer_user_source:!canUseDefaultPlatformMarketSource(user),
        })
        break
      case 'diagnostics':
        result = await ai.mt5Bridge(dataUserId, 'diagnostics', routedParams(), { noFallback:true })
        break
      case 'analyze':
        result = autoExecuteGuard
          ? await runBrowserAutoExecuteWithModelTask(ai, userId, analyzeParams, command_id, autoExecuteGuard)
          : await ai.handleAnalyze(userId, analyzeParams, {})
        if (result?.signal) {
          result.signal = ai.attachSignalPresentation(ai.restrictSignalExperienceUsage(result.signal, {
            requesterUserId: userId, requesterRole: user?.role || 'user',
          }))
        }
        break
      case 'compare':
        result = await ai.handleAnalyzeCompare(userId, params)
        break
      case 'signals_latest_id': {
        const sessionFilter = params.session_id ? 'AND session_id = ?' : ''
        const sessionParam = params.session_id ? [params.session_id] : []
        const observerSignalFilter = observerStrategyId ? 'AND prompt_type_id = ?' : ''
        const observerSignalParam = observerStrategyId ? [observerStrategyId] : []

        // 观摩模式：用 admin 的信号
        const queryUserId = dataUserId || userId

        // Old user signals
        const oldRow = await queryOne(
          `SELECT id, signal_type, is_executed, created_at, created_at_utc_msc, ttl_seconds, timeframe, decision_json, 'manual' as signal_source FROM ai_signals WHERE user_id = ? ${sessionFilter} ${observerSignalFilter} ORDER BY created_at DESC, id DESC LIMIT 1`,
          [queryUserId, ...sessionParam, ...observerSignalParam]
        )

        // Shared delivery signals
        const delivSessionFilter = params.session_id ? 'AND s.session_id = ?' : ''
        const delivRow = await queryOne(
          `SELECT s.id, s.signal_type, d.is_executed, s.created_at, s.created_at_utc_msc, s.ttl_seconds, s.timeframe, s.decision_json, 'auto_shared' as signal_source, d.execution_status
           FROM auto_signal_deliveries d
           JOIN ai_signals s ON s.id = d.signal_id
           WHERE d.user_id = ? ${delivSessionFilter} ${observerStrategyId ? 'AND d.prompt_type_id = ?' : ''} ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
          [queryUserId, ...sessionParam, ...observerSignalParam]
        )
        const adminTargetRow = await queryOne(
          `SELECT s.id, s.signal_type, (t.status = 'succeeded') AS is_executed, t.completed_at AS executed_at,
              s.created_at, s.created_at_utc_msc, s.ttl_seconds, s.timeframe, s.decision_json,
              'admin_strategy_dispatch' AS signal_source, t.status AS execution_status
           FROM admin_strategy_trade_targets t JOIN ai_signals s ON s.id = t.signal_id
           WHERE t.user_id = ? ${observerStrategyId ? 'AND s.prompt_type_id = ?' : ''}
           ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
          [queryUserId, ...observerSignalParam]
        )

        // Pick the newest of both
        let row = null
        if (oldRow && delivRow) {
          row = (oldRow.created_at >= delivRow.created_at) ? oldRow : delivRow
        } else {
          row = oldRow || delivRow
        }
        if (adminTargetRow && (!row || adminTargetRow.created_at > row.created_at
          || (adminTargetRow.created_at === row.created_at && Number(adminTargetRow.id) > Number(row.id)))) row = adminTargetRow

        if (row) {
          ai.attachSignalTiming(row)
          const executionValidation = readExecutionValidation(row)
          if (executionValidation.explicit) row.execution_validation = executionValidation.validation
          delete row.decision_json
          delete row.signal_source
          if (row.execution_status !== undefined) delete row.execution_status
        }
        result = { status: 'success', signal: row || null }
        break
      }
      case 'signal_detail': {
        const signalId = Number(params.signal_id)
        if (!signalId) return reply({ status: 'error', message: 'signal_id required' })

        // In observation mode, delivery is stored under admin's userId
        const detailUserId = dataUserId || userId
        const visible = await loadVisibleSignalRecord(signalId, detailUserId, observerStrategyId)
        if (!visible.row) {
          result = { status: 'error', message: 'signal not found' }
          break
        }
        const snapshot = await getInferenceVisualizationSnapshot(signalId)
        const item = applyVisibleSignalRecord(visible.row, visible.delivery, visible.source, {
          target: visible.target,
          includeLegacyMarketData: !snapshot,
        })
        item.pending_actions = await loadSignalPendingActions(
          detailUserId, signalId, visible.delivery?.execution_result || item.execution_result,
        )
        item.inference_snapshot = snapshot
        // Presentation helpers still accept the legacy market_data shape. Give
        // them only the scalar reference price while deriving the response;
        // remove it again so the wire payload contains no duplicate snapshot.
        if (snapshot) item.market_data = snapshot.market_snapshot?.latest_price == null
          ? {} : { latest_price: snapshot.market_snapshot.latest_price }
        ai.attachSignalTiming(item)
        Object.assign(item, ai.attachSignalPresentation(ai.restrictSignalExperienceUsage(item, {
          requesterUserId: userId, requesterRole: user?.role || 'user',
        })))
        item.management_actions = await ai.loadSignalManagementActions(detailUserId, signalId, {
          management:item.position_management,
          admin:user?.role === 'admin',
        })
        if (snapshot) delete item.market_data
        result = { status: 'success', signal: item }
        break
      }
      case 'signal_evidence': {
        const signalId = Number(params.signal_id)
        if (!signalId) return reply({ status: 'error', message: 'signal_id required' })
        const detailUserId = dataUserId || userId
        const visible = await loadVisibleSignalRecord(signalId, detailUserId, observerStrategyId)
        if (!visible.row) {
          result = { status: 'error', message: 'signal not found' }
          break
        }
        let evidence
        try {
          evidence = await getInferenceSnapshotEvidence(signalId, params.timeframe)
        } catch (error) {
          if (error?.code === 'invalid_timeframe') {
            result = { status: 'error', code: 'invalid_timeframe', message: 'timeframe invalid' }
            break
          }
          throw error
        }
        if (!evidence) {
          result = { status: 'error', code: 'snapshot_not_found', message: 'inference snapshot not found' }
          break
        }
        const expectedSnapshotId = Number(params.snapshot_id)
        if (Number.isSafeInteger(expectedSnapshotId) && expectedSnapshotId > 0
          && Number(evidence.id) !== expectedSnapshotId) {
          result = { status: 'error', code: 'snapshot_mismatch', message: 'inference snapshot changed' }
          break
        }
        result = { status: 'success', evidence }
        break
      }
      case 'signals': {
        const offset = Number(params.offset) || 0
        const limit = Math.min(Number(params.limit) || 10, 100)
        const beforeId = Number(params.before_id)
        // 观摩模式：始终用 admin 的信号
        const queryUserId = dataUserId || userId

        // Build shared WHERE conditions for both queries
        const sharedConditions = []
        const sharedParams = []
        if (params.direction) {
          const types = { buy: 'buy,strong_buy', sell: 'sell,strong_sell', hold: 'hold' }
          const dirTypes = types[params.direction] || params.direction
          sharedConditions.push(`signal_type IN (${dirTypes.split(',').map(() => '?').join(',')})`)
          sharedParams.push(...dirTypes.split(','))
        }
        if (params.timeframe) {
          sharedConditions.push('timeframe = ?')
          sharedParams.push(params.timeframe)
        }
        if (params.direction === 'close') {
          sharedConditions.push('session_id = ?')
          sharedParams.push('smart_close')
        }
        const sharedWhere = sharedConditions.length > 0 ? ' AND ' + sharedConditions.join(' AND ') : ''

        // Old signals subquery
        const oldSessionFilter = (params.direction !== 'close' && params.session_id) ? ' AND session_id = ?' : ''
        const oldSessionParam = (params.direction !== 'close' && params.session_id) ? [params.session_id] : []
        const observerOldFilter = observerStrategyId ? ' AND s.prompt_type_id = ?' : ''
        const observerDeliveryFilter = observerStrategyId ? ' AND d.prompt_type_id = ?' : ''
        const observerStrategyParam = observerStrategyId ? [observerStrategyId] : []
        // Lightweight subquery for COUNT (no TEXT columns)
        const countColsOld = 's.id'
        const countColsDeliv = 's.id'
        const countColsAdmin = 's.id'
        const countOldSub = `(SELECT ${countColsOld} FROM ai_signals s WHERE s.user_id = ? AND (s.source = 'manual' OR s.source IS NULL)${oldSessionFilter}${observerOldFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.join(' AND ') : ''})`
        const countDelivSub = `(SELECT ${countColsDeliv} FROM auto_signal_deliveries d JOIN ai_signals s ON s.id = d.signal_id WHERE d.user_id = ?${observerDeliveryFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.map(c => 's.' + c).join(' AND ') : ''})`
        const adminRepresentativeFilter = " AND t.id = COALESCE((SELECT MAX(t2.id) FROM admin_strategy_trade_targets t2 WHERE t2.signal_id = t.signal_id AND t2.user_id = t.user_id AND t2.target_role = 'source'), (SELECT MAX(t3.id) FROM admin_strategy_trade_targets t3 WHERE t3.signal_id = t.signal_id AND t3.user_id = t.user_id))"
        const countAdminSub = `(SELECT ${countColsAdmin} FROM admin_strategy_trade_targets t JOIN ai_signals s ON s.id = t.signal_id WHERE t.user_id = ?${adminRepresentativeFilter}${observerOldFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.map(c => 's.' + c).join(' AND ') : ''})`
        // Full subquery for data (exclude market_data_json TEXT for performance)
        const selectCols = 'id, user_id, trading_account_id, config_id, prompt_type_id, session_id, source, symbol, timeframe, signal_type, confidence, recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price, recommended_take_profit_tier, ai_model, ttl_seconds, is_executed, executed_at, trade_ticket, execution_result, approved_order_json, created_at, created_at_utc_msc, terminal_timezone_offset_minutes, terminal_clock_status, terminal_clock_source, delivery_id, execution_status, admin_target_id, admin_dispatch_id, admin_target_role, admin_subscription_id, entry_method, limit_price, stop_limit_price, pending_valid_until, pending_ticket, pending_state, order_state, schema_version, decision_json'
        const selectColsOld = 's.id, s.user_id, NULL AS trading_account_id, s.config_id, s.prompt_type_id, s.session_id, s.source, s.symbol, s.timeframe, s.signal_type, s.confidence, s.recommended_volume, s.analysis, s.reasoning, s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price, s.recommended_take_profit_tier, s.ai_model, s.ttl_seconds, s.is_executed, s.executed_at, s.trade_ticket, s.execution_result, NULL as approved_order_json, s.created_at, s.created_at_utc_msc, s.terminal_timezone_offset_minutes, s.terminal_clock_status, s.terminal_clock_source, NULL as delivery_id, NULL as execution_status, NULL as admin_target_id, NULL as admin_dispatch_id, NULL as admin_target_role, NULL as admin_subscription_id, s.entry_method, s.limit_price, s.stop_limit_price, s.pending_valid_until, s.pending_ticket, s.pending_state, s.order_state, s.schema_version, s.decision_json'
        const activeTradingAccountId = Number(observerContext?.channel?.trading_account_id)
        const activeTradingAccountSql = Number.isInteger(activeTradingAccountId) && activeTradingAccountId > 0
          ? String(activeTradingAccountId) : 'NULL'
        const selectColsDeliv = `s.id, d.user_id, COALESCE(oi.trading_account_id, ${activeTradingAccountSql}) AS trading_account_id, s.config_id, d.prompt_type_id, s.session_id, s.source, s.symbol, s.timeframe, s.signal_type, s.confidence, s.recommended_volume, s.analysis, s.reasoning, s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price, s.recommended_take_profit_tier, s.ai_model, s.ttl_seconds, d.is_executed, d.executed_at, d.trade_ticket, d.execution_result, d.approved_order_json, s.created_at, s.created_at_utc_msc, s.terminal_timezone_offset_minutes, s.terminal_clock_status, s.terminal_clock_source, d.id as delivery_id, d.execution_status, NULL as admin_target_id, NULL as admin_dispatch_id, NULL as admin_target_role, NULL as admin_subscription_id, s.entry_method, s.limit_price, s.stop_limit_price, COALESCE(d.pending_valid_until, s.pending_valid_until) AS pending_valid_until, d.pending_ticket, d.pending_state, s.order_state, s.schema_version, s.decision_json`
        const selectColsAdmin = `s.id, t.user_id, t.trading_account_id, s.config_id, s.prompt_type_id, s.session_id, 'admin_strategy_dispatch' AS source, s.symbol, s.timeframe, s.signal_type, s.confidence, s.recommended_volume, s.analysis, s.reasoning, s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price, s.recommended_take_profit_tier, s.ai_model, s.ttl_seconds, (t.status = 'succeeded') AS is_executed, t.completed_at AS executed_at, t.trade_ticket, t.execution_result_json AS execution_result, oi.approved_order_json, s.created_at, s.created_at_utc_msc, s.terminal_timezone_offset_minutes, s.terminal_clock_status, s.terminal_clock_source, NULL AS delivery_id, t.status AS execution_status, t.id AS admin_target_id, t.dispatch_id AS admin_dispatch_id, t.target_role AS admin_target_role, t.subscription_id AS admin_subscription_id, s.entry_method, s.limit_price, s.stop_limit_price, s.pending_valid_until, NULL AS pending_ticket, NULL AS pending_state, s.order_state, s.schema_version, s.decision_json`
        const dataOldSub = `(SELECT ${selectColsOld} FROM ai_signals s WHERE s.user_id = ? AND (s.source = 'manual' OR s.source IS NULL)${oldSessionFilter}${observerOldFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.join(' AND ') : ''})`
        const dataDelivSub = `(SELECT ${selectColsDeliv} FROM auto_signal_deliveries d JOIN ai_signals s ON s.id = d.signal_id LEFT JOIN order_intents oi ON oi.id = d.order_intent_id WHERE d.user_id = ?${observerDeliveryFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.map(c => 's.' + c).join(' AND ') : ''})`
        const dataAdminSub = `(SELECT ${selectColsAdmin} FROM admin_strategy_trade_targets t JOIN ai_signals s ON s.id = t.signal_id LEFT JOIN order_intents oi ON oi.id = t.order_intent_id WHERE t.user_id = ?${adminRepresentativeFilter}${observerOldFilter}${sharedWhere.length > 0 ? ' AND ' + sharedConditions.map(c => 's.' + c).join(' AND ') : ''})`
        const oldParams = [queryUserId, ...oldSessionParam, ...observerStrategyParam, ...sharedParams]

        // Shared signals subquery (delivery overrides user-level execution state)
        const delivParams = [queryUserId, ...observerStrategyParam, ...sharedParams]
        const adminParams = [queryUserId, ...observerStrategyParam, ...sharedParams]

        // COUNT uses lightweight subquery (no TEXT); data uses full subquery (no market_data_json)
        const countSql = `SELECT COUNT(*) as total FROM (${countOldSub} UNION ALL ${countDelivSub} UNION ALL ${countAdminSub}) t`
        const cursorWhere = Number.isInteger(beforeId) && beforeId > 0 ? ' WHERE t.id < ?' : ''
        const dataSql = `SELECT ${selectCols} FROM (${dataOldSub} UNION ALL ${dataDelivSub} UNION ALL ${dataAdminSub}) t${cursorWhere} ORDER BY t.created_at_utc_msc DESC, t.id DESC LIMIT ? OFFSET ?`
        const dataParams = [...oldParams, ...delivParams, ...adminParams]
        if (cursorWhere) dataParams.push(beforeId)
        dataParams.push(limit + 1, cursorWhere ? 0 : offset)
        const [countRow, allRows] = await Promise.all([
          queryOne(countSql, [...oldParams, ...delivParams, ...adminParams]),
          queryAll(dataSql, dataParams)
        ])
        const totalCount = countRow?.total || 0
        const hasMore = allRows.length > limit
        const sliced = allRows.slice(0, limit)

        const signals = sliced.map(row => {
          const item = { ...row }
          // Both subqueries already output unified columns: delivery_* fields are named as their final names.
          // For shared signals, delivery_id is non-null; mark source as auto_shared.
          if (item.delivery_id) {
            item.source = 'auto_shared'
          }
          if (item.admin_target_id) item.source = 'admin_strategy_dispatch'
          try { item.market_data = JSON.parse(item.market_data_json || '{}') } catch { item.market_data = {} }
          delete item.delivery_id
          item.is_executed = !!item.is_executed
          ai.attachSignalTiming(item)
          return ai.attachSignalPresentation(ai.restrictSignalExperienceUsage(item, {
            requesterUserId: userId, requesterRole: user?.role || 'user',
          }))
        })
        result = { status: 'success', signals, has_more: hasMore, total_count: totalCount }

        break
      }
      case 'execute': {
        // Check trade send enabled
        const executeConnected = isBridgeAlive(userId)
        const executeTradeEnabled = executeConnected && isTradeEnabled(userId)
        if (!executeConnected || !executeTradeEnabled) {
          result = { status: 'rejected', message: !executeConnected ? 'MT5 桥接未连接' : '交易发送已关闭，请先开启', details: {} }
          await ai.insertAudit(null, userId, 'ai_execute', null, params, result, 'rejected')
          break
        }
        // Check shared delivery first
        const delivery = await queryOne(
          'SELECT * FROM auto_signal_deliveries WHERE signal_id = ? AND user_id = ?',
          [params.signal_id, userId]
        )
        let signal, signalSource
        if (delivery) {
          signal = await queryOne('SELECT * FROM ai_signals WHERE id = ?', [params.signal_id])
          signalSource = 'auto_shared'
        } else {
          signal = await queryOne('SELECT * FROM ai_signals WHERE id = ? AND user_id = ?', [params.signal_id, userId])
          signalSource = 'manual'
        }
        if (!signal) return reply({ status: 'error', message: 'Signal not found' })
        const executionValidation = readExecutionValidation(signal)
        if (executionValidation.validation.eligible !== true) {
          result = executionValidationRejection(executionValidation)
          if (delivery) {
            await queryRun(
              'UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE id = ? AND execution_status IN (\'not_attempted\', \'rejected\', \'skipped\')',
              ['rejected', JSON.stringify(result), delivery.id])
          } else {
            await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(result), signal.id])
          }
          await ai.insertAudit(null, userId, 'ai_execute', signal.symbol, params, result, 'rejected')
          break
        }
        const deliveryAlreadyHandled = delivery && (
          Number(delivery.is_executed) === 1 ||
          delivery.pending_ticket || delivery.trade_ticket ||
          ['success', 'executing', 'uncertain'].includes(delivery.execution_status)
        )
        const manualAlreadyHandled = !delivery && (
          Number(signal.is_executed) === 1 || signal.pending_ticket || signal.trade_ticket
        )
        if (deliveryAlreadyHandled || manualAlreadyHandled) {
          result = { status: 'rejected', message: 'signal_already_executed_or_pending' }
          break
        }

        const config = await ai.getExecuteRiskConfig(userId, signal)
        if (!config) {
          result = { status: 'rejected', message: 'no_risk_config', details: {} }
          await ai.insertAudit(null, userId, 'ai_execute', signal.symbol, params, result, result.status)
          break
        }
        const timedSignal = ai.attachSignalTiming({ ...signal })
        if (timedSignal.is_stale) {
          result = { status: 'rejected', message: 'signal_expired', details: { age_seconds: timedSignal.age_seconds, ttl_seconds: timedSignal.ttl_seconds } }
          await ai.insertAudit(null, userId, 'ai_execute', signal.symbol, params, result, result.status)
          break
        }
        let marketData
        try { marketData = JSON.parse(signal.market_data_json || '{}') } catch (e) {
          console.warn(`[Execute] Failed to parse market_data_json for signal ${params.signal_id}:`, e.message)
          marketData = {}
        }
        const orderPayload = ai.signalOrderPayload(signal, config, marketData, params.confirm)
        result = await ai.executeOrderCore(userId, config, orderPayload, 'ai_execute', {
          sourceType: delivery ? 'auto_delivery' : 'manual_ai',
          signalId: signal.id,
          deliveryId: delivery?.id || null,
        })
        if (result.status === 'success') {
          const isPending = signal.entry_method && signal.entry_method !== 'market' && signal.entry_method !== 'observe'
          const orderTicket = result.order || result.ticket || null
          if (signalSource === 'auto_shared' && delivery) {
            if (isPending) {
              // Fix 6: pending orders write pending_ticket/pending_state, not trade_ticket
              await queryRun(
                `UPDATE auto_signal_deliveries SET execution_status = 'success',
                 pending_ticket = ?, pending_state = 'pending', pending_valid_until = ?,
                 execution_result = ? WHERE id = ?`,
                [String(orderTicket), signal.pending_valid_until || null, JSON.stringify(result), delivery.id])
            } else {
              await queryRun(
                'UPDATE auto_signal_deliveries SET execution_status = ?, is_executed = 1, executed_at = NOW(), trade_ticket = ?, execution_result = ? WHERE id = ?',
                ['success', orderTicket, JSON.stringify(result), delivery.id])
            }
          } else {
            if (isPending) {
              // Fix 6: use pending_state instead of order_state, keep is_executed=0 for pending
              await queryRun('UPDATE ai_signals SET pending_ticket = ?, pending_state = ?, pending_valid_until = ?, execution_result = ? WHERE id = ?',
                [String(orderTicket), 'pending', signal.pending_valid_until || null, JSON.stringify(result), signal.id])
            } else {
              await queryRun('UPDATE ai_signals SET is_executed = 1, executed_at = ?, trade_ticket = ?, execution_result = ? WHERE id = ?', [beijingNow(), orderTicket, JSON.stringify(result), signal.id])
            }
          }
        } else {
          // Update delivery status on failure
          if (signalSource === 'auto_shared' && delivery) {
            const status = result.status === 'rejected' ? 'rejected' : result.status === 'uncertain' ? 'uncertain' : 'failed'
            await queryRun(
              'UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE id = ?',
              [status, JSON.stringify(result), delivery.id])
          } else {
            await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(result || {}), signal.id])
          }
        }
        break
      }
      case 'auto_status': {
        // The switch is user-owned control state. Observation mode may reuse
        // platform market data, but must never expose the administrator's
        // scheduler state as the current user's switch state.
        const runtimeStatus = await ai.getUserAutoRuntimeStatus(userId)
        result = { status: 'success', scheduler: runtimeStatus }
        break
      }
      case 'toggle_auto': {
        const activeSubscriptions = await queryAll(`SELECT id FROM strategy_subscriptions
          WHERE user_id = ? AND is_deleted = 0 AND execution_enabled = 1
          ORDER BY updated_at DESC, id DESC`, [userId])
        const newEnabled = activeSubscriptions.length === 0

        // Check bridge connection when enabling
        if (newEnabled) {
          if (!isBridgeAlive(userId)) {
            result = { status: 'error', message: '请先连接 MT5 桥接后再开启自动推理' }
            break
          }
        }

        const user = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        const subscriptions = newEnabled
          ? [await queryOne(`SELECT id FROM strategy_subscriptions
              WHERE user_id = ? AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT 1`, [userId])].filter(Boolean)
          : activeSubscriptions
        if (!subscriptions.length) {
          result = { status: 'error', message: '请先在“推理策略”中创建订阅，再开启自动推理' }
          break
        }
        for (const subscription of subscriptions) {
          await ai.updateSubscription(subscription.id, userId, user?.role || 'user', { execution_enabled: newEnabled })
        }
        // Sync Redis + reconcile
        const updatedCfg = await ai.getAutoConfig(null, userId)
        if (newEnabled) {
          await ai.syncUserRedisSubscription(userId, updatedCfg?.prompt_type_id, updatedCfg?.selected_symbols || [], true)
        } else {
          await ai.syncUserRedisSubscription(userId, null, [], false)
        }
        await ai.reconcileAutoSchedulers()
        result = { status: 'success', enabled: newEnabled, message: newEnabled ? '自动推理已开启' : '自动推理已关闭' }
        break
      }
      case 'audit_logs': {
        // 审计日志只显示自己的数据
        const ownRows = await queryAll('SELECT * FROM trade_audit_logs WHERE user_id = ? ORDER BY created_at_utc_msc DESC, id DESC LIMIT 500', [userId])
        const localizedRows = await Promise.all(ownRows.map(async row => {
          const item = { ...row }
          try { item.request = JSON.parse(item.request_json) } catch { item.request = {} }
          try { item.result = JSON.parse(item.result_json) } catch { item.result = {} }
          const snapshotClock = {
            timezone_offset_minutes:item.terminal_timezone_offset_minutes,
            clock_status:item.terminal_clock_status,
          }
          if (trustedTerminalClock(snapshotClock)) {
            item.created_at_mt5 = utcMscToTerminalTime(item.created_at_utc_msc,
              snapshotClock.timezone_offset_minutes)
          } else item.created_at_mt5 = null
          delete item.request_json
          delete item.result_json
          return localizeAuditRow(item)
        }))
        const logs = collapseRecoveryAuditRows(localizedRows).slice(0, 100)
        result = { status: 'success', logs }
        break
      }
      case 'signal_tickets': {
        const ticketMap = {}
        const sigUserId = dataUserId || userId
        const observerTicketFilter = observerStrategyId ? ' AND prompt_type_id = ?' : ''
        const observerTicketParam = observerStrategyId ? [observerStrategyId] : []
        // Old signals
        const oldRows = await queryAll(`SELECT id, trade_ticket, execution_result FROM ai_signals
          WHERE user_id = ? AND is_executed = 1 AND (source = 'manual' OR source IS NULL)
          ${observerTicketFilter} ORDER BY id DESC LIMIT 200`, [sigUserId, ...observerTicketParam])
        for (const row of oldRows) {
          try {
            let ticket = row.trade_ticket
            if (!ticket) {
              const exec = JSON.parse(row.execution_result || '{}')
              ticket = exec.order || exec.ticket || exec.position
            }
            if (ticket) ticketMap[String(ticket)] = row.id
          } catch (e) { console.warn('[BridgeWS] Failed to parse execution_result:', e.message) }
        }
        // New shared signals via deliveries
        const delivRows = await queryAll(
          `SELECT d.signal_id, d.trade_ticket, d.execution_result
           FROM auto_signal_deliveries d
           WHERE d.user_id = ? AND d.is_executed = 1
             ${observerStrategyId ? 'AND d.prompt_type_id = ?' : ''}
           ORDER BY d.id DESC LIMIT 200`,
          [sigUserId, ...observerTicketParam])
        for (const row of delivRows) {
          try {
            let ticket = row.trade_ticket
            if (!ticket) {
              const exec = JSON.parse(row.execution_result || '{}')
              ticket = exec.order || exec.ticket || exec.position
            }
            if (ticket) ticketMap[String(ticket)] = row.signal_id
          } catch (e) { console.warn('[BridgeWS] Failed to parse delivery execution_result:', e.message) }
        }
        const adminRows = await queryAll(
          `SELECT signal_id, trade_ticket, execution_result_json
           FROM admin_strategy_trade_targets
           WHERE user_id = ? AND status = 'succeeded' AND trade_ticket IS NOT NULL
             ${observerStrategyId ? 'AND signal_id IN (SELECT id FROM ai_signals WHERE prompt_type_id = ?)' : ''}
           ORDER BY id DESC LIMIT 200`,
          [sigUserId, ...observerTicketParam])
        for (const row of adminRows) {
          let ticket = row.trade_ticket
          if (!ticket) {
            try {
              const exec = JSON.parse(row.execution_result_json || '{}')
              ticket = exec.order || exec.ticket || exec.position
            } catch {}
          }
          if (ticket) ticketMap[String(ticket)] = row.signal_id
        }
        result = { status: 'success', tickets: ticketMap }
        break
      }
      case 'save_close_config': {
        result = { status:'error', code:'smart_close_feature_retired', message:'旧智能平仓已停用，请使用仓位管理功能' }
        break
      }
      case 'get_close_config': {
        result = { status:'success', retired:true, config:{ enabled:false } }
        break
      }
      case 'close_status': {
        result = { status:'success', retired:true,
          scheduler:{ enabled:false, paused:true, pause_reason:'feature_retired' } }
        break
      }
      case 'close_signal_tickets': {
        const map = await ai.getCloseSignalTickets(dataUserId || userId)
        result = { status: 'success', tickets: map }
        break
      }
      case 'pending_list': {
        const hasDataBridge = dataUserId && isBridgeAlive(dataUserId)
        if (!hasDataBridge) {
          result = { status: 'error', message: '请先连接 MT5 桥接' }
          break
        }
        try {
          const symbol = params.symbol ? params.symbol : null
          const listResult = await ai.mt5Bridge(dataUserId, 'pending_list', routedParams({ symbol }), { noFallback:true })
          if (access.read_only && listResult && typeof listResult === 'object') listResult.observer_source = true
          result = listResult
        } catch (e) {
          console.error('[BridgeWS] pending_list error:', e.message)
          result = { status: 'error', message: '获取挂单列表失败' }
        }
        break
      }
      case 'cancel_pending': {
        const ticket = params.ticket
        if (!ticket) return reply({ status: 'error', message: 'ticket required' })
        const cancelParams = { ticket, expected_state: params.expected_state }
        if (params.confirm !== true) {
          result = { status:'rejected', message:'manual_confirmation_required' }
          await ai.insertAudit(null, userId, 'manual_cancel_pending', null,
            cancelParams, result, 'rejected')
          break
        }
        try {
          const cancelResult = await ai.mt5Bridge(userId, 'cancel_pending', cancelParams)
          if (cancelResult?.status === 'success') {
            result = { ...cancelResult, message: '挂单已取消' }
          } else {
            result = { ...(cancelResult || {}), status:cancelResult?.status || 'error',
              message:cancelResult?.message || '取消挂单失败' }
          }
          await ai.insertAudit(null, userId, 'manual_cancel_pending', null,
            cancelParams, result, result?.status || 'unknown')
        } catch (e) {
          console.error('[BridgeWS] cancel_pending error:', e.message)
          result = { status: 'error', message: '取消挂单失败' }
          await ai.insertAudit(null, userId, 'manual_cancel_pending', null,
            cancelParams, result, 'error').catch(() => {})
        }
        break
      }
      case 'signal_by_ticket': {
        const ticket = params.ticket
        if (!ticket) return reply({ status: 'error', message: 'ticket required' })
        try {
          const sigCols = 'id, signal_type, entry_method, limit_price, stop_limit_price, pending_valid_until, order_state, pending_ticket, symbol, timeframe, created_at, confidence, recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price, market_data_json, is_executed, executed_at'
          const ticketStr = String(ticket)
          // 1. Direct match in ai_signals (fast path)
          let signal = await queryOne(
            `SELECT ${sigCols} FROM ai_signals WHERE user_id = ? AND (pending_ticket = ? OR trade_ticket = ?) ORDER BY id DESC LIMIT 1`,
            [dataUserId || userId, ticketStr, ticketStr]
          )
          // 2. Fallback: search auto_signal_deliveries (multi-user pending orders)
          if (!signal) {
            const deliv = await queryOne(
              'SELECT signal_id FROM auto_signal_deliveries WHERE user_id = ? AND pending_ticket = ? ORDER BY id DESC LIMIT 1',
              [dataUserId || userId, ticketStr]
            )
            if (deliv?.signal_id) {
              signal = await queryOne(
                `SELECT ${sigCols} FROM ai_signals WHERE id = ?`,
                [deliv.signal_id]
              )
            }
          }
          if (!signal) {
            const adminTarget = await queryOne(
              `SELECT t.signal_id FROM admin_strategy_trade_targets t
               WHERE t.user_id = ? AND (t.trade_ticket = ? OR JSON_UNQUOTE(JSON_EXTRACT(t.execution_result_json, '$.ticket')) = ?)
               ORDER BY t.id DESC LIMIT 1`,
              [dataUserId || userId, ticketStr, ticketStr]
            )
            if (adminTarget?.signal_id) signal = await queryOne(`SELECT ${sigCols} FROM ai_signals WHERE id = ?`, [adminTarget.signal_id])
          }
          if (signal) {
            try { signal.market_data = JSON.parse(signal.market_data_json || '{}') } catch { signal.market_data = {} }
            delete signal.market_data_json
            result = { status: 'success', signal }
          } else {
            result = { status: 'not_found', message: '未找到关联信号' }
          }
        } catch (e) {
          console.error('[BridgeWS] signal_by_ticket error:', e.message)
          result = { status: 'error', message: '查询失败' }
        }
        break
      }
      case 'export_history': {
        // Admin-only: export all history + reasoning as structured data
        const adminUser = user
        if (adminUser?.role !== 'admin') {
          result = { status: 'error', message: '仅管理员可操作' }
          break
        }

        const flattenSignal = s => ({
          id: s.id, type: s.signal_type, confidence: s.confidence,
          volume: s.recommended_volume, analysis: s.analysis, reasoning: s.reasoning,
          stop_loss: s.stop_loss_price, tp1: s.take_profit_1_price,
          tp2: s.take_profit_2_price, tp3: s.take_profit_3_price,
          session: s.session_id || 'default',
          executed: !!s.is_executed, exec_result: s.execution_result,
          created_at: s.created_at, symbol: s.symbol,
        })

        const adminId = await getAdminUserId()
        let expUserId = adminId || userId
        let exportRoute = null
        let bridgeOk = isBridgeAlive(expUserId)
        if (!bridgeOk && isBridgeAlive(userId)) {
          expUserId = userId; bridgeOk = true
        }
        exportRoute = assertHistoryExactRoute(strictHistoryRouteForUser(expUserId, params))
        if (!bridgeOk) {
          result = { status: 'error', message: '桥接未连接，无法导出历史数据' }
          break
        }
        const exportNowUtcMsc = Date.now()
        // Fetch all orders from the selected terminal using one fixed
        // half-open range for every page.
        const exportRange = await resolveHistoryRange(expUserId, params, exportRoute, exportNowUtcMsc)
        const exportClock = historyTerminalClock(expUserId, exportRoute)
        const exportFilterFrom = params.filter_close_from ?? params.history_range?.filter_close_from
        const exportFilterTo = params.filter_close_to ?? params.history_range?.filter_close_to
        const exportBridgeParams = {
          page_size: 200,
          ...bridgeRouteParams(exportRoute),
          range_start_utc_msc: exportRange.range_start_utc_msc,
          range_end_utc_msc: exportRange.range_end_utc_msc,
          allowed_start_utc_msc: exportRange.allowed_start_utc_msc,
          system_start_utc_msc: exportRange.system_start_utc_msc,
          effective_start_utc_msc: exportRange.effective_start_utc_msc,
          captured_end_utc_msc: exportRange.captured_end_utc_msc,
          ...(exportFilterFrom !== undefined && exportFilterFrom !== ''
            ? { filter_close_from:historyDateInputUtcMsc(exportFilterFrom, exportClock) } : {}),
          ...(exportFilterTo !== undefined && exportFilterTo !== ''
            ? { filter_close_to:historyDateInputUtcMsc(exportFilterTo, exportClock, { endOfDay:true }) } : {}),
        }
        let orders = []
        let exportFailed = false
        let exportErrorCode = null
        let expectedTotalPages = null
        const exportCursorMode = hasHistoryCursorCapability(exportRoute)
        let exportSnapshotId = null
        let exportCursor = null
        for (let page = 1; page <= 50; page += 1) {
          const pageParams = exportCursorMode
            ? { ...exportBridgeParams,
                ...(exportSnapshotId ? { history_snapshot_id:exportSnapshotId } : {}),
                ...(exportCursor ? { cursor:exportCursor } : {}) }
            : { ...exportBridgeParams, page }
          const expRes = await ai.mt5Bridge(expUserId, exportCursorMode ? 'history_page' : 'history', pageParams, {
            timeoutMs:30000, noFallback:true,
          })
          if (expRes?.status !== 'success' || !Array.isArray(expRes.orders)
            || !isHistoryExportComplete({
              range:exportRange,
              result:expRes,
              historySync:expRes.history_sync,
            })) {
            exportFailed = true
            break
          }
          const pagePlan = boundedHistoryExportPageCount(expRes.pagination?.total_pages)
          if (!pagePlan.ok || (expectedTotalPages !== null
            && expectedTotalPages !== pagePlan.total_pages)) {
            exportFailed = true
            exportErrorCode = pagePlan.ok
              ? 'history_export_pagination_changed' : pagePlan.code
            break
          }
          expectedTotalPages = pagePlan.total_pages
          if (exportCursorMode) {
            const responseSnapshotId = normalizedHistoryCursorToken(expRes.history_snapshot_id)
            const responseCursor = normalizedHistoryCursorToken(expRes.next_cursor)
            if (!responseSnapshotId
              || (exportSnapshotId && responseSnapshotId !== exportSnapshotId)
              || (page < expectedTotalPages && (!expRes.has_more || !responseCursor))
              || (page >= expectedTotalPages && expRes.has_more)) {
              exportFailed = true
              exportErrorCode = 'history_export_cursor_invalid'
              break
            }
            exportSnapshotId = responseSnapshotId
            exportCursor = responseCursor
          }
          orders.push(...expRes.orders)
          if (page >= expectedTotalPages) break
        }
        if (exportFailed) {
          result = {
            status:'error',
            code:exportErrorCode || 'history_export_read_failed',
            message:exportErrorCode === 'history_export_range_too_large'
              ? '历史范围过大，请缩小范围后再导出'
              : '获取历史订单失败',
          }
          break
        }
        // Apply same filters as history page
        const _oc = o => historyOrderCloseUtcMsc(o)
        const _ot = o => (o.type || '')
        const _op = o => Number(o.profit || 0)
        if (params.entry_from) orders = orders.filter(o => (o.entry_time || '').slice(0, 10) >= params.entry_from)
        if (params.entry_to) orders = orders.filter(o => (o.entry_time || '').slice(0, 10) <= params.entry_to)
        if (params.direction) orders = orders.filter(o => _ot(o).toUpperCase() === params.direction)
        if (params.profit_filter === 'profit') orders = orders.filter(o => _op(o) > 0)
        if (params.profit_filter === 'loss') orders = orders.filter(o => _op(o) < 0)
        orders.sort((a, b) => Number(_oc(b) || 0) - Number(_oc(a) || 0))

        const signalRows = await queryAll(
          `SELECT id, trade_ticket, pending_ticket, signal_type, confidence, recommended_volume, analysis, reasoning,
                  stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price,
                  session_id, is_executed, execution_result, created_at, symbol
           FROM ai_signals
           WHERE user_id = ?
           ORDER BY created_at DESC LIMIT 5000`,
          [expUserId]
        )
        const deliveryRows = await queryAll(
          `SELECT d.trade_ticket, d.pending_ticket, d.signal_id, d.execution_result,
                  d.is_executed AS delivery_is_executed,
                  s.signal_type, s.confidence, s.recommended_volume, s.analysis, s.reasoning,
                  s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price,
                  s.session_id, s.created_at, s.symbol
           FROM auto_signal_deliveries d
           JOIN ai_signals s ON s.id = d.signal_id
           WHERE d.user_id = ?
           ORDER BY s.created_at DESC LIMIT 5000`,
          [expUserId]
        )
        const signalIndex = buildSignalRefIndex(signalRows, flattenSignal)
        const deliveryIndex = buildSignalRefIndex(deliveryRows, r => ({
          id: r.signal_id, type: r.signal_type, confidence: r.confidence,
          volume: r.recommended_volume, analysis: r.analysis, reasoning: r.reasoning,
          stop_loss: r.stop_loss_price, tp1: r.take_profit_1_price,
          tp2: r.take_profit_2_price, tp3: r.take_profit_3_price,
          session: r.session_id || 'default', executed: !!r.delivery_is_executed,
          exec_result: r.execution_result, created_at: r.created_at, symbol: r.symbol,
        }))
        for (const [ref, signals] of deliveryIndex) {
          const existing = signalIndex.get(ref) || []
          for (const signal of signals) {
            if (!existing.some(item => String(item.id) === String(signal.id))) existing.push(signal)
          }
          signalIndex.set(ref, existing)
        }

        // Build export rows: one order + reasoning = one row
        const exportRows = orders.map(o => {
          const tk = String(o.ticket || o.order || '')
          const signals = []
          for (const ref of collectTradeRefs(o)) {
            for (const signal of signalIndex.get(ref) || []) {
              if (!signals.some(item => String(item.id) === String(signal.id))) signals.push(signal)
            }
          }
          const mainSignal = signals.find(s => s.session === 'default') || signals[0] || {}
          return {
            // Order fields
            ticket: tk,
            symbol: o.symbol || '',
            direction: (o.type || '').toUpperCase(),
            volume: o.volume || 0,
            entry_price: o.entry_price ?? o.open_price ?? '',
            entry_time: o.entry_time || o.time || '',
            exit_price: o.close_price ?? '',
            close_time: o.close_time || '',
            stop_loss: o.stop_loss ?? o.sl ?? '',
            take_profit: o.take_profit ?? o.tp ?? '',
            profit: o.profit ?? 0,
            profit_points: o.profit_points ?? 0,
            comment: o.comment || '',
            // Reasoning fields
            signal_id: mainSignal.id || '',
            signal_type: mainSignal.type || '',
            signal_confidence: mainSignal.confidence ?? '',
            signal_volume: mainSignal.volume ?? '',
            signal_analysis: mainSignal.analysis || '',
            signal_reasoning: mainSignal.reasoning || '',
            signal_stop_loss: mainSignal.stop_loss ?? '',
            signal_tp1: mainSignal.tp1 ?? '',
            signal_tp2: mainSignal.tp2 ?? '',
            signal_tp3: mainSignal.tp3 ?? '',
            signal_executed: mainSignal.executed ? '是' : '否',
            signal_created: mainSignal.created_at || '',
          }
        })

        result = {
          status: 'success',
          rows: exportRows,
          total: exportRows.length,
          export_time: new Date().toISOString()
        }
        break
      }
      case 'toggle_close': {
        result = { status:'error', code:'smart_close_feature_retired', message:'旧智能平仓已停用，请使用仓位管理功能' }
        break
      }
      case 'run_close_now': {
        result = { status:'error', code:'smart_close_feature_retired', message:'旧智能平仓已停用，请使用仓位管理功能' }
        break
      }
      case 'admin_dashboard': {
        const u = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (u?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }

        const [userStats, signalStats, signalTypeDist, signalTrend, autoReasonStats, tokenStats, tokenTrend, bridgeList, schedulerData, healthStats] = await Promise.all([
          // 1. User stats
          queryOne(`SELECT
            (SELECT COUNT(*) FROM users) AS total_users,
            (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURDATE()) AS today_new,
            (SELECT COUNT(*) FROM users WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS online_now,
            (SELECT COUNT(*) FROM users WHERE last_seen_at >= CURDATE()) AS today_active,
            (SELECT COUNT(*) FROM users WHERE plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())) AS pro_users,
            (SELECT COUNT(*) FROM users WHERE plan = 'plus' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())) AS plus_users,
            (SELECT COUNT(*) FROM users WHERE plan IS NULL OR plan = 'free'
              OR (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW())) AS free_users`),

          // 2. Signal summary
          queryOne(`SELECT
            (SELECT COUNT(*) FROM ai_signals) AS total,
            (SELECT COUNT(*) FROM ai_signals WHERE DATE(created_at) = CURDATE()) AS today,
            (SELECT COUNT(*) FROM ai_signals signals
              WHERE DATE(signals.created_at) = CURDATE()
                AND (signals.is_executed = 1 OR EXISTS (
                  SELECT 1 FROM auto_signal_deliveries deliveries
                  WHERE deliveries.signal_id = signals.id AND deliveries.is_executed = 1
                ))) AS today_executed,
            (SELECT COUNT(*) FROM ai_signals WHERE DATE(created_at) = CURDATE() AND signal_type = 'error') AS today_errors,
            (SELECT COUNT(*) FROM ai_signals WHERE YEARWEEK(created_at, 1) = YEARWEEK(NOW(), 1)) AS week,
            (SELECT COUNT(*) FROM ai_signals WHERE is_executed = 1) AS executed,
            (SELECT ROUND(AVG(confidence)*100, 1) FROM ai_signals
              WHERE signal_type LIKE 'buy%' OR signal_type LIKE 'sell%') AS avg_confidence`),

          // 3. Signal type distribution
          queryAll('SELECT signal_type, COUNT(*) AS cnt FROM ai_signals GROUP BY signal_type ORDER BY cnt DESC'),

          // 4. Daily signal trend (30 days)
          queryAll(`SELECT DATE(created_at) AS day, COUNT(*) AS cnt
            FROM ai_signals WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY DATE(created_at) ORDER BY day`),

          // 5. Auto-reasoning & trade stats
          queryOne(`SELECT
            (SELECT COUNT(*) FROM user_bridge_settings settings JOIN users ON users.id = settings.user_id
              WHERE settings.auto_reasoning_enabled = 1
                AND (users.role = 'admin' OR (users.plan = 'pro' AND (users.plan_expires_at IS NULL OR users.plan_expires_at >= NOW())))) AS auto_reasoning_users,
            (SELECT COUNT(*) FROM user_bridge_settings settings JOIN users ON users.id = settings.user_id
              WHERE settings.trade_send_enabled = 1
                AND (users.role = 'admin' OR (users.plan = 'pro' AND (users.plan_expires_at IS NULL OR users.plan_expires_at >= NOW())))) AS trade_enabled_users,
            (SELECT COUNT(*) FROM auto_scheduler scheduler
              JOIN users ON users.id = scheduler.user_id
              JOIN auto_prompt_types strategy ON strategy.id = scheduler.prompt_type_id
              WHERE scheduler.enabled = 1 AND strategy.is_active = 1 AND strategy.deleted_at IS NULL
                AND (users.role = 'admin' OR (users.plan = 'pro' AND (users.plan_expires_at IS NULL OR users.plan_expires_at >= NOW())))) AS auto_scheduler_users`),

          // 6. Token usage stats from the authoritative model-call ledger.
          queryOne(`SELECT
            (SELECT COALESCE(SUM(token_count), 0) FROM ai_model_usage_logs
              WHERE created_at >= CURDATE() AND request_status IN ('success', 'error')) AS today_tokens,
            (SELECT COALESCE(SUM(token_count), 0) FROM ai_model_usage_logs
              WHERE request_status IN ('success', 'error')) AS total_tokens,
            (SELECT created_at FROM ai_model_usage_logs
              WHERE request_status IN ('success', 'error') ORDER BY id DESC LIMIT 1) AS last_api_call`),

          // 7. Daily token trend (30 days)
          queryAll(`SELECT DATE(created_at) AS day,
            SUM(token_count) AS tokens
            FROM ai_model_usage_logs
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
              AND request_status IN ('success', 'error')
            GROUP BY DATE(created_at) ORDER BY day`),

          // 8. Connected bridges (WSS + trade mode info)
          (async () => {
            const list = []
            for (const connected of bridgeV3Business?.connectedUsers?.() || []) {
              const uid = Number(connected.userId)
              const info = await queryOne('SELECT nickname, email, plan FROM users WHERE id = ?', [uid])
              const settings = await queryOne('SELECT trade_send_enabled, auto_reasoning_enabled FROM user_bridge_settings WHERE user_id = ?', [uid])
              list.push({
                userId: uid,
                nickname: info?.nickname || '',
                email: info?.email || '',
                plan: info?.plan || 'free',
                tradeEnabled: !!settings?.trade_send_enabled,
                autoReasoning: !!settings?.auto_reasoning_enabled,
                lastSeen: connected.lastSeen || null,
              })
            }
            return list
          })(),

          // 9. Scheduler state from Redis + DB subscription stats
          (async () => {
            const redis = getRedis()
            const schedulers = []
            const dbRows = await queryAll(`
              SELECT s.prompt_type_id, apt.title AS prompt_type_name, apt.symbols_json, apt.interval_minutes,
                     COUNT(DISTINCT s.user_id) AS subscriber_count
              FROM auto_scheduler s
              JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
              WHERE s.enabled = 1 AND apt.is_active = 1 AND apt.deleted_at IS NULL
              GROUP BY s.prompt_type_id, apt.title, apt.symbols_json, apt.interval_minutes
              ORDER BY subscriber_count DESC
            `)
            if (redis && isRedisAvailable()) {
              try {
                const keys = await redis.smembers('auto:scheduler:keys')
                for (const k of keys) {
                  const state = await redis.hgetall(`auto:scheduler:${k}:state`)
                  if (!state || !state.running) continue
                  const [ptId, symbol] = k.split(':')
                  const dbInfo = dbRows.find(r => String(r.prompt_type_id) === ptId)
                  // Real-time subscriber count from Redis Set
                  const realTimeCount = await redis.scard(`auto:scheduler:${k}:subs`)
                  schedulers.push({
                    key: k,
                    prompt_type_id: Number(ptId),
                    prompt_type_name: dbInfo?.prompt_type_name || '',
                    symbol,
                    running: state.running === '1',
                    in_flight: state.in_flight === '1',
                    subscriber_count: realTimeCount || 0,
                    interval_minutes: Number(state.interval_minutes || 5),
                    last_run_at: state.last_run_at || '',
                    last_error: state.last_error || '',
                    wait_reason: state.wait_reason || '',
                    next_run_in_seconds: Number(state.next_run_in_seconds || 0),
                    market_reason: state.market_reason || '',
                  })
                }
              } catch (e) { console.error('[admin_dashboard] Redis scheduler read error:', e.message) }
            }
            // Fill in Redis subs counts for DB-only schedulers (no runtime state)
            if (redis && isRedisAvailable()) {
              try {
                const autoSchedulerState = getRegisteredAutoSchedulerState()
                for (const db of dbRows) {
                  const hasRuntime = schedulers.some(s => String(s.prompt_type_id) === String(db.prompt_type_id))
                  if (hasRuntime) continue
                  let totalSubs = 0
                  const symbols = (() => { try { return JSON.parse(db.symbols_json || '[]') } catch { return [] } })()
                  for (const sym of symbols) {
                    const k = `${db.prompt_type_id}:${sym}`
                    const count = await redis.scard(`auto:scheduler:${k}:subs`)
                    totalSubs += count || 0
                    // Fallback: if Redis has no subs, check in-memory scheduler state
                    if (totalSubs === 0 && autoSchedulerState[k]?.subscribers?.size > 0) {
                      totalSubs = autoSchedulerState[k].subscribers.size
                    }
                  }
                  db.subscriber_count = totalSubs
                  // Also add as runtime scheduler if in-memory state exists but Redis missed it
                  if (totalSubs > 0) {
                    const firstSym = symbols[0] || ''
                    const k = `${db.prompt_type_id}:${firstSym}`
                    const memState = autoSchedulerState[k]
                    if (memState) {
                      schedulers.push({
                        key: k,
                        prompt_type_id: db.prompt_type_id,
                        prompt_type_name: db.prompt_type_name || '',
                        symbol: firstSym,
                        running: memState.running || false,
                        in_flight: memState.inFlight || false,
                        subscriber_count: memState.subscribers?.size || 0,
                        interval_minutes: memState.intervalMinutes || db.interval_minutes || 5,
                        last_run_at: memState.lastRunAt || '',
                        last_error: memState.lastError || '',
                        wait_reason: memState.waitReason || '',
                        next_run_in_seconds: memState.nextRunInSeconds || 0,
                        market_reason: memState.marketState?.reason || '',
                      })
                    }
                  }
                }
              } catch (e) { console.error('[admin_dashboard] Redis subs count error:', e.message) }
            }
            return { schedulers, dbStats: dbRows }
          })(),

          // 10. Actionable operating health for the administrator workbench.
          queryOne(`SELECT
            (SELECT COUNT(*) FROM ai_model_usage_logs WHERE created_at >= CURDATE()
              AND request_status IN ('success', 'error')) AS model_requests_today,
            (SELECT COUNT(*) FROM ai_model_usage_logs WHERE created_at >= CURDATE()
              AND request_status = 'error') AS model_failures_today,
            (SELECT ROUND(AVG(duration_ms)) FROM ai_model_usage_logs WHERE created_at >= CURDATE() AND request_status = 'success') AS avg_model_latency_ms,
            (SELECT COALESCE(SUM(COALESCE(request_bytes, 0) + COALESCE(response_bytes, 0)), 0)
              FROM ai_model_usage_logs WHERE created_at >= CURDATE()
                AND request_status IN ('success', 'error')) AS model_bytes_today,
            (SELECT COUNT(*) FROM period_review_cases review_case
              WHERE review_case.status IN ('draft', 'edited')
                AND review_case.id = (
                  SELECT candidate.id FROM period_review_cases candidate
                  WHERE candidate.user_id = review_case.user_id
                    AND candidate.period_type = review_case.period_type
                    AND candidate.period_key = review_case.period_key
                    AND COALESCE(candidate.trading_account_id, 0) = COALESCE(review_case.trading_account_id, 0)
                    AND candidate.strategy_id = review_case.strategy_id
                  ORDER BY (candidate.status = 'approved') DESC, candidate.id DESC LIMIT 1
                )) AS reviews_pending,
            (SELECT COUNT(*) FROM period_review_cases review_case
              WHERE review_case.status = 'failed'
                AND review_case.id = (
                  SELECT candidate.id FROM period_review_cases candidate
                  WHERE candidate.user_id = review_case.user_id
                    AND candidate.period_type = review_case.period_type
                    AND candidate.period_key = review_case.period_key
                    AND COALESCE(candidate.trading_account_id, 0) = COALESCE(review_case.trading_account_id, 0)
                    AND candidate.strategy_id = review_case.strategy_id
                  ORDER BY (candidate.status = 'approved') DESC, candidate.id DESC LIMIT 1
                )) AS reviews_failed,
            (SELECT COUNT(*) FROM risk_decisions WHERE created_at >= CURDATE() AND decision_status = 'reject') AS risk_rejections_today`)
        ])

        result = {
          status: 'success',
          data: {
            userStats: userStats || {},
            signalStats: signalStats || {},
            signalTypeDist: signalTypeDist || [],
            signalTrend: signalTrend || [],
            autoReasonStats: autoReasonStats || {},
            tokenStats: tokenStats || {},
            tokenTrend: tokenTrend || [],
            bridges: bridgeList || [],
            schedulerData: schedulerData || { schedulers: [], dbStats: [] },
            healthStats: healthStats || {}
          }
        }
        break
      }
      case 'admin_user_status': {
        // Admin: lookup a specific user's system status by email or user_id
        const u2 = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (u2?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }

        const email = params.email?.trim()
        const targetId = Number(params.user_id)
        if (!email && !targetId) { result = { status: 'error', message: '需要 email 或 user_id 参数' }; break }

        const targetUser = email
          ? await queryOne('SELECT id, nickname, email, phone, plan, role, last_seen_at, created_at FROM users WHERE email = ?', [email])
          : await queryOne('SELECT id, nickname, email, phone, plan, role, last_seen_at, created_at FROM users WHERE id = ?', [targetId])
        if (!targetUser) { result = { status: 'error', message: '用户不存在' }; break }

        const tid = targetUser.id
        const [targetSettings, targetScheduler, targetSignals, bridgeStatus] = await Promise.all([
          queryOne('SELECT trade_send_enabled, auto_reasoning_enabled FROM user_bridge_settings WHERE user_id = ?', [tid]),
          queryOne('SELECT enabled, last_run_at, selected_symbols_json FROM auto_scheduler WHERE user_id = ?', [tid]),
          (async () => {
            const oldStats = await queryOne(`SELECT
              (SELECT COUNT(*) FROM ai_signals WHERE user_id = ?) AS old_total,
              (SELECT COUNT(*) FROM ai_signals WHERE user_id = ? AND DATE(created_at) = CURDATE()) AS old_today,
              (SELECT COUNT(*) FROM ai_signals WHERE user_id = ? AND is_executed = 1) AS old_executed`, [tid, tid, tid])
            const delivStats = await queryOne(`SELECT
              COUNT(*) AS deliv_total,
              SUM(CASE WHEN DATE(d.created_at) = CURDATE() THEN 1 ELSE 0 END) AS deliv_today,
              SUM(CASE WHEN d.is_executed = 1 THEN 1 ELSE 0 END) AS deliv_executed
              FROM auto_signal_deliveries d WHERE d.user_id = ?`, [tid])
            const lastSignal = await queryOne(
              `SELECT id, signal_type, created_at FROM ai_signals WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [tid])
            const lastDelivery = await queryOne(
              `SELECT s.id, s.signal_type, s.created_at FROM auto_signal_deliveries d JOIN ai_signals s ON s.id = d.signal_id WHERE d.user_id = ? ORDER BY s.id DESC LIMIT 1`, [tid])
            let lastSignalType = null, lastSignalAt = null
            if (lastSignal && lastDelivery) {
              if (lastSignal.id >= lastDelivery.id) {
                lastSignalType = lastSignal.signal_type; lastSignalAt = lastSignal.created_at
              } else {
                lastSignalType = lastDelivery.signal_type; lastSignalAt = lastDelivery.created_at
              }
            } else if (lastSignal) {
              lastSignalType = lastSignal.signal_type; lastSignalAt = lastSignal.created_at
            } else if (lastDelivery) {
              lastSignalType = lastDelivery.signal_type; lastSignalAt = lastDelivery.created_at
            }
            return {
              total_signals: Number(oldStats?.old_total || 0) + Number(delivStats?.deliv_total || 0),
              today_signals: Number(oldStats?.old_today || 0) + Number(delivStats?.deliv_today || 0),
              executed_signals: Number(oldStats?.old_executed || 0) + Number(delivStats?.deliv_executed || 0),
              last_signal_type: lastSignalType,
              last_signal_at: lastSignalAt,
            }
          })(),
          (async () => {
            const connected = Boolean(bridgeV3Business?.hasConnectedTerminal(tid))
            const runtime = (bridgeV3Business?.connectedUsers?.() || [])
              .find(item => Number(item.userId) === Number(tid))
            return { connected, alive:Boolean(runtime?.alive), lastSeen:runtime?.lastSeen || null }
          })()
        ])

        let selectedSymbols = []
        try { selectedSymbols = JSON.parse(targetScheduler?.selected_symbols_json || '[]') } catch {}
        result = {
          status: 'success',
          data: {
            user: targetUser,
            settings: targetSettings || { trade_send_enabled: 0, auto_reasoning_enabled: 0 },
            scheduler: targetScheduler
              ? { ...targetScheduler, symbols: selectedSymbols.join('、') || null }
              : { enabled: 0, symbols: null, last_run_at: null },
            signals: targetSignals || {},
            bridge: bridgeStatus
          }
        }
        break
      }
      case 'admin_user_search': {
        // Admin: search users by email or nickname for dropdown
        const u4 = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (u4?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }

        const searchTerm = (params.q || '').trim()
        const limit = Math.min(Number(params.limit) || 5, 20)
        let users
        if (searchTerm) {
          users = await queryAll(
            `SELECT id, email, nickname, plan, role, plan_expires_at,
              (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS membership_expired
             FROM users WHERE email LIKE ? OR nickname LIKE ? ORDER BY last_seen_at DESC LIMIT ?`,
            [`%${searchTerm}%`, `%${searchTerm}%`, limit]
          )
        } else {
          users = await queryAll(
            `SELECT id, email, nickname, plan, role, plan_expires_at,
              (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS membership_expired
             FROM users ORDER BY last_seen_at DESC LIMIT ?`,
            [limit]
          )
        }
        result = { status: 'success', users }
        break
      }
      case 'admin_user_list': {
        // Admin: paginated user list with status
        const u5 = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
        if (u5?.role !== 'admin') { result = { status: 'error', message: '仅管理员可操作' }; break }

        const page = Math.max(1, Number(params.page) || 1)
        const pageSize = Math.min(Number(params.pageSize) || 10, 50)
        const offset = (page - 1) * pageSize

        const countRow = await queryOne('SELECT COUNT(*) AS total FROM users')
        const rows = await queryAll(
          `SELECT id, email, phone, nickname, plan, role, plan_expires_at,
             (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS membership_expired,
             last_seen_at, bridge_heartbeat, created_at FROM users
           ORDER BY bridge_heartbeat DESC, last_seen_at DESC
           LIMIT ? OFFSET ?`,
          [pageSize, offset]
        )

        // Enrich page results with bridge/settings status (only current page)
        const enriched = await Promise.all(rows.map(async r => {
          const connected = Boolean(bridgeV3Business?.hasConnectedTerminal(Number(r.id)))
          const settings = await queryOne('SELECT trade_send_enabled, auto_reasoning_enabled FROM user_bridge_settings WHERE user_id = ?', [r.id])
          const scheduler = await queryOne(`SELECT id FROM strategy_subscriptions
            WHERE user_id = ? AND is_deleted = 0 AND execution_enabled = 1 LIMIT 1`, [r.id])
          return {
            ...r,
            bridgeConnected: connected,
            autoReasoning: !!(settings?.auto_reasoning_enabled),
            tradeEnabled: !!(settings?.trade_send_enabled),
            schedulerEnabled: Boolean(scheduler)
          }
        }))

        result = {
          status: 'success',
          users: enriched,
          total: countRow?.total || 0,
          page,
          pageSize
        }
        break
      }
      default:
        result = { status: 'error', message: `Unknown action: ${action}` }
    }
    reply(result || { status: 'error', message: 'No result' })
  } catch (err) {
    console.error('[BridgeWS] handleBrowserCommand error:', err.message)
    const stableCode = String(err?.code || err?.message || '')
    if (stableCode.startsWith('bridge_history_') || stableCode.startsWith('history_cursor_')
      || stableCode.startsWith('history_prepare_status_')
      || stableCode.startsWith('history_range_preference_')) {
      reply({ status:'error', code:stableCode, error:stableCode, message:stableCode })
      return
    }
    reply({ status: 'error', message: '操作失败，请重试' })
  } finally {
    autoExecuteGuard?.dispose()
  }
}

// Send command to bridge and wait for result
export function bindExecutionClockRouteParams(params = {}, clock = {}) {
  return {
    ...params,
    terminal_instance_id:clock.terminal_instance_id,
    broker_server:clock.broker_server,
    login:clock.login,
  }
}

export async function sendBridgeCommand(userId, action, params, timeoutMs = 5000, options = {}) {
  const numericUserId = Number(userId)
  if (action === 'open' || action === 'pending') {
    const tradingAccountId = options.tradingAccountId ?? params?.trading_account_id ?? null
    let clock
    if (options.requireExecutionClockContext) {
      const route = getBridgeDataRoute(numericUserId, tradingAccountId, {
        strictAccount:Number(tradingAccountId) > 0,
      })
      const supplied = options.executionClockContext
      if (!supplied) {
        return { status:'rejected', code:'execution_clock_context_missing',
          message:'交易平台时间证据不可用，订单未发送到 MT5' }
      }
      const verified = validateExecutionClockContext(supplied, {
        userId:numericUserId,
        tradingAccountId,
        terminalInstanceId:params?.terminal_instance_id || route?.terminal_instance_id || null,
        brokerServer:route?.account_ref?.broker_server || null,
        login:route?.account_ref?.login || null,
      })
      if (!verified.valid) {
        return { status:'rejected', code:verified.reason,
          message:'交易平台时间证据不可用，订单未发送到 MT5' }
      }
      // Keep the route-derived terminal identity attached to the context sent
      // to the Bridge. It cannot be replaced by an observer or shared clock.
      clock = verified.context
      params = bindExecutionClockRouteParams(params, clock)
      options = { ...options, executionClockContext:clock,
        terminal_instance_id:clock.terminal_instance_id }
    } else {
      clock = await getEffectivePlatformMarketClockState(
        numericUserId,
        tradingAccountId,
        params?.terminal_instance_id ?? null)
    }
    const riskLock = weeklyRiskLockResult(
      new Date(), clock.timezone_offset_minutes, clock.clock_status)
    if (riskLock) return riskLock
  }

  if (!bridgeV3Business?.hasConnectedTerminal?.(numericUserId)) {
    return { status:'error', error:'Bridge not connected' }
  }
  if (!bridgeV3Business?.supports(action)) {
    return { status:'error', error:'bridge_v3_action_unsupported' }
  }
  return bridgeV3Business.execute(numericUserId, action, params, { ...options, timeoutMs })
}

// Check if a user has an active bridge
export function isBridgeAlive(userId) {
  const numericUserId = Number(userId)
  return Boolean(bridgeV3Business?.hasConnectedTerminal(numericUserId))
}

// Check if live trading is enabled for a user
export function isTradeEnabled(userId) {
  const numericUserId = Number(userId)
  return bridgeV3Business?.isTradeEnabled(numericUserId) === true
}

export function acquireBridgeMaintenanceLease(request) {
  if (!bridgeV3Business?.acquireMaintenanceLease) {
    throw Object.assign(new Error('bridge_maintenance_unavailable'), {
      code:'bridge_maintenance_unavailable',
    })
  }
  return bridgeV3Business.acquireMaintenanceLease(request)
}

export function listBridgeUpdateMaintenanceTerminals(authorizedUserIds, terminalInstanceIds) {
  if (!bridgeV3Business?.connectedTerminals) return []
  const allowed = new Set((authorizedUserIds || []).map(Number))
  const requested = new Set((terminalInstanceIds || []).map(String))
  const terminals = []
  for (const userId of allowed) {
    for (const terminal of bridgeV3Business.connectedTerminals(userId)) {
      if (!requested.has(terminal.terminal_instance_id)) continue
      terminals.push({ ...terminal, user_id:userId })
    }
  }
  return terminals
}

export function probeBridgeUpdateMaintenanceMarket(terminal, symbol) {
  if (!bridgeV3Business?.execute) {
    throw Object.assign(new Error('bridge_maintenance_unavailable'), {
      code:'bridge_maintenance_unavailable',
    })
  }
  return bridgeV3Business.execute(Number(terminal.user_id), 'market_state', {
    symbol,
    terminal_instance_id:terminal.terminal_instance_id,
    account_ref:terminal.account_ref,
  }, { timeoutMs:5_000 })
}

export function renewBridgeMaintenanceLease(actorUserId, leaseId, options = {}) {
  if (!bridgeV3Business?.renewMaintenanceLease) {
    throw Object.assign(new Error('bridge_maintenance_unavailable'), {
      code:'bridge_maintenance_unavailable',
    })
  }
  return bridgeV3Business.renewMaintenanceLease(actorUserId, leaseId, options)
}

export function releaseBridgeMaintenanceLease(actorUserId, leaseId) {
  if (!bridgeV3Business?.releaseMaintenanceLease) {
    throw Object.assign(new Error('bridge_maintenance_unavailable'), {
      code:'bridge_maintenance_unavailable',
    })
  }
  return bridgeV3Business.releaseMaintenanceLease(actorUserId, leaseId)
}

// Apply administrator-managed observer-source switches to an already connected
// bridge. Database persistence is handled by the observer-source service so the
// desired state also survives bridge restarts.
export async function applyBridgeRuntimeState(userId, { tradeEnabled, autoReasoningEnabled } = {}) {
  const numericUserId = Number(userId)
  const connected = isBridgeAlive(numericUserId)
  let tradeApplied = !connected
  let tradeError = null

  if (connected && typeof tradeEnabled === 'boolean') {
    // Disable locally before the command is acknowledged so no server-side
    // order can slip through while the bridge processes the switch.
    const result = await sendBridgeCommand(numericUserId, 'toggle_trade', { enable:tradeEnabled }, 5000, { noFallback:true })
    tradeApplied = result?.status === 'success'
    if (!tradeApplied) tradeError = result?.message || result?.error || 'bridge_runtime_sync_failed'
  }

  if (typeof autoReasoningEnabled === 'boolean') {
    sendToBrowsers(numericUserId, {
      type:'auto_state', enabled:autoReasoningEnabled,
      runtime_subscribed:autoReasoningEnabled && connected,
      reason:'observer_source_admin_update',
    })
  }
  if (typeof tradeEnabled === 'boolean') {
    sendToBrowsers(numericUserId, {
      type:'hb', mt5_connected:connected, mt5_alive:connected,
      platform:bridgePlatform(numericUserId),
      trade_enabled:connected ? isTradeEnabled(numericUserId) : tradeEnabled,
      auto_reasoning_enabled:typeof autoReasoningEnabled === 'boolean'
        ? autoReasoningEnabled : undefined,
      trade_mode:await getBridgeTradeMode(numericUserId),
    })
  }
  return { connected, trade_applied:tradeApplied, trade_error:tradeError }
}

// Market status: bridge connected + tick time unchanged for 5 min → closed
// Returns 0=closed, 1=LONGONLY, 2=SHORTONLY, 3=CLOSEONLY, 4=FULL, -1=unknown
// Market tick thresholds
const MARKET_SAME_TICK_CLOSED_MS = 60_000
const MARKET_TICK_STALE_MS = 120_000

// Unified market state function
export function getOwnBridgeMarketState(userId, symbol = null) {
  const numericUserId = Number(userId)
  const bridge = bridgeV3Business?.hasConnectedTerminal(numericUserId)
    ? bridgeV3MarketStateForContext(numericUserId) || {}
    : null
  if (!bridge) {
    return {
      alive: false, isOpen: false, tradeMode: -1,
      reason: 'bridge_offline', lastTickMs: null, tickAgeMs: null, mt5TimeStr: null,
    }
  }

  const now = Date.now()
  const lastTickMs = bridge.lastTickMs || null
  const tickAgeMs = lastTickMs ? now - lastTickMs : null
  const tradeMode = typeof bridge.lastTradeMode === 'number' ? bridge.lastTradeMode : -1

  const explicit = symbol ? bridge.marketStates?.get(stripBrokerSuffix(symbol)) : bridge.marketState
  const explicitFresh = explicit && now - explicit.receivedAt <= 30_000
  if (explicitFresh) {
    return {
      alive: true, isOpen: explicit.state === 'open', tradeMode: explicit.tradeMode,
      reason: explicit.reason, detailReason: explicit.detailReason, marketState: explicit.state,
      symbol: explicit.symbol, symbolTradeMode: explicit.symbolTradeMode,
      terminalConnected: explicit.terminalConnected, tickProgressing: explicit.tickProgressing,
      tickUnchangedSeconds: explicit.tickUnchangedSeconds, tickAgeSeconds: explicit.tickAgeSeconds,
      lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null,
      source: 'bridge_market_state_v1',
    }
  }
  if (symbol && bridge.marketStates?.size > 0) {
    return {
      alive: true, isOpen: false, tradeMode: -1, reason: 'market_unknown',
      detailReason: explicit ? 'symbol_state_stale' : 'symbol_state_unavailable',
      marketState: 'unknown', symbol: stripBrokerSuffix(symbol), lastTickMs, tickAgeMs,
      mt5TimeStr: bridge.mt5TimeStr || null, source: 'bridge_market_state_v1',
    }
  }

  if (!lastTickMs) {
    return { alive: true, isOpen: false, tradeMode, reason: 'market_unknown_no_tick', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
  }
  if (tickAgeMs > MARKET_TICK_STALE_MS) {
    return { alive: true, isOpen: false, tradeMode, reason: 'market_stale_tick', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
  }
  if (tradeMode !== 4) {
    return { alive: true, isOpen: false, tradeMode, reason: tradeMode === 0 ? 'market_closed' : 'market_unknown', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
  }
  return { alive: true, isOpen: true, tradeMode: 4, reason: 'market_open', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
}

// Market status: bridge connected + tick time unchanged for 5 min → closed
// Returns 0=closed, 1=LONGONLY, 2=SHORTONLY, 3=CLOSEONLY, 4=FULL, -1=unknown
export async function getBridgeTradeMode(userId) {
  const numericUserId = Number(userId)
  const bridge = bridgeV3Business?.hasConnectedTerminal(numericUserId)
    ? bridgeV3MarketStateForContext(numericUserId)
    : null
  if (!bridge) return -1
  // Use real-time trade mode detected from MT5 tick_time advancement
  if (typeof bridge.lastTradeMode === 'number') return bridge.lastTradeMode
  // No trade mode data yet → unknown
  return -1
}

// Get all connected bridges (for admin)
export function getAllBridges() {
  return (bridgeV3Business?.connectedUsers?.() || []).map(item => ({
    ...item,
    userId:Number(item.userId),
    connected:Boolean(item.connected),
    alive:Boolean(item.alive),
    lastSeen:Number(item.lastSeen || 0) || null,
  }))
}

// Count live terminal connections rather than users. One user may connect an
// MT4 terminal and an MT5 terminal at the same time, and both must be visible
// in the administrator runtime summary.
export function getConnectedBridgeStats() {
  const stats = { total:0, mt4:0, mt5:0 }
  const add = platform => {
    const normalized = String(platform || '').toLowerCase() === 'mt4' ? 'mt4' : 'mt5'
    stats[normalized]++
    stats.total++
  }

  for (const item of bridgeV3Business?.connectedUsers?.() || []) {
    for (const route of bridgeV3Business.connectedTerminals(Number(item.userId))) add(route.platform)
  }
  return stats
}

export function getBridgeDiagnostics() {
  const now = Date.now()
  const diagnostics = []
  for (const user of bridgeV3Business?.connectedUsers?.() || []) {
    const userId = Number(user.userId)
    for (const route of bridgeV3Business?.connectedTerminals(userId) || []) {
      const state = bridgeV3MarketStateForContext(userId, null, route.terminal_instance_id) || {}
      const lastSeen = Number(route.last_seen_at_utc_msc || user.lastSeen || 0)
      const lastTick = Number(state.lastTickMs || state.receivedAt || 0)
      diagnostics.push({
        userId,
        terminalInstanceId:route.terminal_instance_id,
        platform:route.platform || null,
        readyState:1,
        connected:true,
        alive:Boolean(user.alive),
        connectedSeconds:0,
        lastSeenAgeSeconds:lastSeen ? Math.max(0, Math.round((now - lastSeen) / 1000)) : -1,
        lastPongAgeSeconds:-1,
        lastMessageType:'v3',
        generation:Number(route.connection_generation || user.generation || 0),
        tradeEnabled:bridgeV3Business?.isTradeEnabled(userId) === true,
        autoReasoningEnabled:null,
        lastTradeMode:typeof state.lastTradeMode === 'number' ? state.lastTradeMode : -1,
        mt5TimeStr:state.mt5TimeStr || null,
        lastTickAgeSeconds:lastTick ? Math.max(0, Math.round((now - lastTick) / 1000)) : -1,
        clientVersion:route.bridge_version || null,
        mt5CollectTimeoutCount:0,
        lastDataSentAgeSec:-1,
        lastQuoteTime:state.mt5TimeStr || null,
      })
    }
  }
  return diagnostics
}

export function getBridgeRuntimeDiagnostics(userId) {
  const id = Number(userId)
  const routes = bridgeV3Business?.connectedTerminals(id) || []
  if (routes.length) {
    const streamTimes = routes.flatMap(route => Object.values(route.stream_observed_at_utc_msc || {}))
      .map(Number).filter(value => Number.isFinite(value) && value > 0)
    const lastSeen = Math.max(...routes.map(route => Number(route.last_seen_at_utc_msc || 0)))
    const rtts = routes.map(route => Number(route.transport_rtt_msc))
      .filter(value => Number.isFinite(value) && value >= 0)
    return {
      connected:true,
      terminal_count:routes.length,
      platform:routes[0]?.platform || null,
      bridge_version:routes.find(route => route.bridge_version)?.bridge_version || null,
      transport_latency_msc:rtts.length ? Math.round(Math.min(...rtts)) : null,
      last_seen_at_utc_msc:lastSeen || null,
      last_data_at_utc_msc:streamTimes.length ? Math.max(...streamTimes) : null,
      terminals:routes.map(route => ({
        terminal_instance_id:route.terminal_instance_id,
        platform:route.platform,
        login:route.account_ref?.login || null,
        broker_server:route.account_ref?.broker_server || null,
        initial_sync_ready:route.initial_sync_ready === true,
      })),
    }
  }
  return {
    connected:false,
    terminal_count:0,
    platform:null,
    bridge_version:null,
    transport_latency_msc:null,
    last_seen_at_utc_msc:null,
    last_data_at_utc_msc:null,
    terminals:[],
  }
}

export function getBridgeGeneration(userId) {
  return bridgeV3Business?.getGeneration(Number(userId)) ?? null
}

export function getLatestBridgeMt5Clock() {
  let latest = null
  for (const [userId, states] of bridgeV3MarketStates.entries()) {
    if (!bridgeV3Business?.hasConnectedTerminal(Number(userId))) continue
    for (const [terminalInstanceId, marketState] of states.entries()) {
      const time = marketState?.mt5TimeStr || null
      const receivedAt = Number(marketState?.lastTickMs || marketState?.marketState?.receivedAt || 0)
      if (!time || (latest && receivedAt <= Number(latest.received_at || 0))) continue
      const route = (bridgeV3Business?.connectedTerminals(Number(userId)) || [])
        .find(item => item.terminal_instance_id === terminalInstanceId)
      latest = {
        time:String(time),
        user_id:Number(userId),
        terminal_instance_id:terminalInstanceId,
        platform:route?.platform || 'mt5',
        received_at:receivedAt || null,
        observed_at_utc_msc:marketState.observedAtUtcMsc ?? null,
        timezone_offset_minutes:marketState.timezoneOffsetMinutes ?? null,
        clock_status:marketState.clockStatus || 'unknown',
      }
    }
  }
  return latest
}

export { sendToBrowsers }
