import crypto from 'crypto'
import { queryAll, queryOne, queryRun, withTransaction, beijingNow } from '../../db.js'
import { broadcastAdminEvent, sendToBrowsers } from '../../bridge-ws.js'
import { mt5Bridge } from './market-data.js'
import { positionProtectionStatus } from './position-management.js'

const SYSTEM_MAGIC = 234000
const OPEN_STATUSES = ['open', 'closing']
const PROTECTION_INCIDENTS = ['missing_stop_loss', 'invalid_stop_loss_direction']
const HISTORY_EVIDENCE_REF_LIMIT = 100
const HOUR_MSC = 60 * 60 * 1000
let monitorTimer = null

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0
const ref = value => value == null || String(value).trim() === '' ? null : String(value)
// MT4/MT5 use numeric zero when no deal exists yet. It is a sentinel, not a
// durable deal ticket, and must never make a pending order look filled.
const dealRef = value => {
  const normalized = ref(value)
  return normalized === '0' ? null : normalized
}
const parse = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback } catch { return fallback } }
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const MYSQL_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

function utcMsToBeijingDatetime(utcMs) {
  const value = Number(utcMs)
  if (!Number.isFinite(value) || value <= 0) return null
  const shifted = new Date(value + 8 * 3600_000)
  if (!Number.isFinite(shifted.getTime())) return null
  return shifted.toISOString().replace('T', ' ').slice(0, 19)
}

// Reconciliation requests use a single UTC calendar-day boundary for every
// page and evidence batch.  Computing it once prevents a long-running scan
// from changing its requested range at midnight between pages.
export function utcDateToday(now = Date.now()) {
  const date = new Date(now)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null
}

// Bridge history coverage is recorded against fixed endpoints.  Using the
// instantaneous wall clock would move the exact evidence range forward on
// every monitor pass and make an otherwise complete archive look incomplete.
// The current UTC hour is intentionally excluded so reconciliation only reads
// sealed history and naturally picks up very recent closes on the next hour.
export function outcomeReconciliationRangeEndUtcMsc(now = Date.now()) {
  const value = Number(now)
  if (!Number.isSafeInteger(value) || value <= 0) return null
  const rangeEndUtcMsc = Math.floor(value / HOUR_MSC) * HOUR_MSC
  return Number.isSafeInteger(rangeEndUtcMsc) && rangeEndUtcMsc > 0 ? rangeEndUtcMsc : null
}

function utcDateStartUtcMsc(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const parsed = Date.parse(`${text}T00:00:00.000Z`)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || utcDateToday(parsed) !== text) return null
  return parsed
}

function ownershipStartUtcMsc(outcome) {
  const numeric = Number(outcome?.ownership_started_at_utc_msc ?? outcome?.ownership_start_utc_msc)
  if (Number.isSafeInteger(numeric) && numeric > 0) return numeric
  const text = outcome?.ownership_started_at ?? outcome?.ownership_start
  if (typeof text !== 'string') return null
  const parsed = Date.parse(`${text.trim().replace(' ', 'T')}Z`)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function dealTimeForDatabase(deal) {
  const trustedUtcMs = Number(deal?.time_utc_msc)
  if (Number.isFinite(trustedUtcMs) && trustedUtcMs > 0) return utcMsToBeijingDatetime(trustedUtcMs)
  const raw = String(deal?.time ?? '').trim()
  if (!raw) return null
  if (MYSQL_DATETIME_RE.test(raw)) return raw
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? utcMsToBeijingDatetime(parsed) : null
}

function dealTicket(deal) { return dealRef(deal?.deal_ticket ?? deal?.ticket) }
function dealNet(deal) { return num(deal?.profit) + num(deal?.commission) + num(deal?.swap) + num(deal?.fee) }
function isEntry(deal) { return Number(deal?.entry) === 0 }
function isExit(deal) { return [1, 3].includes(Number(deal?.entry)) }

function positionForOutcome(outcome, result, activePositions = []) {
  const refs = new Set([result?.positionId, outcome?.position_id, outcome?.entry_order_ticket]
    .map(ref).filter(Boolean))
  return activePositions.find(position => [position.ticket, position.position_id, position.identifier]
    .map(ref).some(value => value && refs.has(value))) || null
}

export function analyzeOutcomeAttribution(outcome, allDeals = [], activePositions = [], historyOrders = [], competingPositionCount = 1) {
  const positionId = ref(outcome.position_id)
  const orderRefs = new Set([outcome.entry_order_ticket, outcome.pending_ticket].map(ref).filter(Boolean))
  const bridgeRef = String(outcome.bridge_command_ref || '')
  let deals = allDeals.filter(deal => {
    if (positionId && ref(deal.position_id) === positionId) return true
    if (orderRefs.has(ref(deal.order))) return true
    return bridgeRef && String(deal.comment || '').includes(bridgeRef)
  })
  const resolvedPositionId = positionId || ref(deals.find(isEntry)?.position_id) || ref(deals[0]?.position_id)
  if (resolvedPositionId) deals = allDeals.filter(deal => ref(deal.position_id) === resolvedPositionId)
  deals = deals.filter(deal => dealTicket(deal))
  if (!deals.length) return { attributionStatus: 'pending', positionId: resolvedPositionId, matchedDeals: [], complete: false }

  if (String(outcome.margin_mode).toLowerCase() === 'netting' && (competingPositionCount > 1 || deals.some(deal => Number(deal.entry) === 2))) {
    return { attributionStatus: 'attribution_ambiguous', positionId: resolvedPositionId, matchedDeals: [], complete: false }
  }

  const entries = deals.filter(isEntry)
  const exits = deals.filter(isExit)
  const entryVolume = entries.reduce((sum, deal) => sum + num(deal.volume), 0)
  const closedVolume = exits.reduce((sum, deal) => sum + num(deal.volume), 0)
  const active = activePositions.some(position => [position.ticket, position.position_id, position.identifier].map(ref).includes(resolvedPositionId))
  const complete = entryVolume > 0 && closedVolume + 1e-8 >= entryVolume && !active
  const interventions = []
  if (num(outcome.expected_volume) > 0 && entryVolume > num(outcome.expected_volume) + 1e-8) interventions.push('external_volume_increase')
  if (deals.some(deal => num(deal.magic) !== SYSTEM_MAGIC)) interventions.push('non_system_magic_deal')
  const approved = parse(outcome.approved_order_json)
  const current = activePositions.find(position => [position.ticket, position.position_id, position.identifier].map(ref).includes(resolvedPositionId))
  const approvedStopLoss = outcome.authorized_stop_loss != null ? outcome.authorized_stop_loss : approved.sl
  const approvedTakeProfit = outcome.authorized_take_profit != null ? outcome.authorized_take_profit : approved.tp
  if (current && approvedStopLoss != null && num(current.sl) !== num(approvedStopLoss)) interventions.push('stop_loss_modified')
  if (current && approvedTakeProfit != null && num(current.tp) !== num(approvedTakeProfit)) interventions.push('take_profit_modified')
  const entryOrder = historyOrders.find(order => orderRefs.has(ref(order.ticket)) || ref(order.position_id) === resolvedPositionId)
  if (entryOrder && num(entryOrder.magic) !== SYSTEM_MAGIC) interventions.push('entry_order_magic_mismatch')

  const grossProfit = deals.reduce((sum, deal) => sum + num(deal.profit), 0)
  const commission = deals.reduce((sum, deal) => sum + num(deal.commission), 0)
  const swap = deals.reduce((sum, deal) => sum + num(deal.swap), 0)
  const fee = deals.reduce((sum, deal) => sum + num(deal.fee), 0)
  const latestExit = exits.map(dealTimeForDatabase).filter(Boolean).sort().at(-1) || null
  const feeHash = hash(deals.map(deal => [dealTicket(deal), num(deal.profit), num(deal.commission), num(deal.swap), num(deal.fee)]).sort())
  return {
    attributionStatus: 'attributed', positionId: resolvedPositionId, matchedDeals: deals, complete,
    entryVolume, closedVolume, grossProfit, commission, swap, fee,
    netProfit: grossProfit + commission + swap + fee, latestExit, feeHash,
    externalIntervention: interventions.length > 0, interventions: [...new Set(interventions)],
  }
}

export function resolveOutcomeClosureTransition(outcome, result, now = beijingNow()) {
  if (!result.complete) return { status: 'open', feeStableAt: null, reviewEligibleAt: null }
  const stable = outcome.closing_candidate_hash === result.feeHash && Boolean(outcome.fee_stable_at)
  return {
    status: stable ? 'closed' : 'closing',
    feeStableAt: outcome.fee_stable_at || now,
    reviewEligibleAt: stable ? now : null,
  }
}

export function isSystemManagedOutcomeSource(sourceType) {
  return String(sourceType || '').trim().toLowerCase() !== 'manual'
}

export async function createSignalOutcomeTx(run, intent, bridgeResult, bridgeAction = null) {
  if (!intent?.trading_account_id || !isSystemManagedOutcomeSource(intent.source_type)) return null
  const request = parse(intent.approved_order_json, parse(intent.request_json))
  const [accounts] = await run('SELECT margin_mode, broker_server, login_account FROM trading_accounts WHERE id = ? LIMIT 1', [intent.trading_account_id])
  const account = Array.isArray(accounts) ? accounts[0] : null
  const marginMode = account?.margin_mode || 'netting'
  const now = beijingNow()
  const outcomeAction = String(bridgeAction || intent.action || '').toLowerCase()
  const isPendingOrder = outcomeAction === 'pending'
  // Pending acceptance never proves that a position exists. The position id
  // is attached later by recordPendingOutcomeFill / terminal reconciliation.
  const positionId = isPendingOrder ? null : ref(bridgeResult?.position_id ?? bridgeResult?.position)
  const orderTicket = ref(bridgeResult?.order ?? bridgeResult?.ticket)
  const deal = dealRef(bridgeResult?.deal ?? bridgeResult?.deal_ticket)
  const pending = isPendingOrder ? orderTicket : null
  const sourceSignalId = String(intent.source_id || '').split(':', 1)[0]
  const signalId = Number(sourceSignalId) > 0 ? Number(sourceSignalId) : null
  const [signals] = signalId ? await run(`SELECT prompt_type_id, signal_type, thesis_id, management_group_id,
    stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price
    FROM ai_signals WHERE id = ? LIMIT 1`, [signalId]) : [[]]
  const sourceSignal = Array.isArray(signals) ? signals[0] : null
  const [strategies] = sourceSignal?.prompt_type_id ? await run('SELECT version FROM auto_prompt_types WHERE id = ? LIMIT 1', [sourceSignal.prompt_type_id]) : [[]]
  const strategy = Array.isArray(strategies) ? strategies[0] : null
  const [ownershipRows] = await run(`SELECT id, broker_server_key, login_account FROM mt5_account_ownership_history
    WHERE trading_account_id = ? AND user_id = ? AND ended_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1`,
  [intent.trading_account_id, intent.user_id])
  const ownership = Array.isArray(ownershipRows) ? ownershipRows[0] : null
  const originalTakeProfits = [1, 2, 3].map(tier => num(sourceSignal?.[`take_profit_${tier}_price`] ?? request[`take_profit_${tier}_price`]))
    .filter(value => value > 0)
  const entryDirection = String(sourceSignal?.signal_type || request.order_type || request.type || '').toLowerCase().startsWith('buy') ? 'buy' : 'sell'
  await run(`INSERT INTO signal_outcomes
    (signal_id, order_intent_id, user_id, trading_account_id, margin_mode, symbol,
     entry_order_ticket, entry_deal_ticket, pending_ticket, position_id, expected_volume,
     strategy_id, strategy_version, thesis_id, management_group_id, ownership_history_id,
     broker_server_key, login_account, original_symbol, entry_direction, system_magic,
     original_stop_loss, original_take_profits_json, protection_status,
     status, attribution_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown',
      'open', 'pending', ?, ?)
    ON DUPLICATE KEY UPDATE entry_order_ticket = COALESCE(VALUES(entry_order_ticket), entry_order_ticket),
      entry_deal_ticket = COALESCE(VALUES(entry_deal_ticket), entry_deal_ticket),
      pending_ticket = COALESCE(VALUES(pending_ticket), pending_ticket),
      position_id = COALESCE(VALUES(position_id), position_id),
      thesis_id = COALESCE(VALUES(thesis_id), thesis_id),
      management_group_id = COALESCE(VALUES(management_group_id), management_group_id),
      ownership_history_id = COALESCE(VALUES(ownership_history_id), ownership_history_id),
      updated_at = VALUES(updated_at)`, [
    signalId, intent.id, intent.user_id, intent.trading_account_id, marginMode,
    String(request.symbol || ''), orderTicket, deal, pending, positionId, num(request.volume || request.lot),
    sourceSignal?.prompt_type_id || null, strategy?.version || null, sourceSignal?.thesis_id || null,
    sourceSignal?.management_group_id || null, ownership?.id || null,
    ownership?.broker_server_key || String(account?.broker_server || '').trim().toUpperCase() || null,
    ownership?.login_account || account?.login_account || null, String(request.symbol || ''), entryDirection,
    SYSTEM_MAGIC, num(sourceSignal?.stop_loss_price ?? request.sl) || null,
    JSON.stringify(originalTakeProfits), now, now,
  ])
  if (sourceSignal?.thesis_id) await run("UPDATE ai_trade_theses SET status = 'active', updated_at = ? WHERE thesis_id = ?", [now, sourceSignal.thesis_id])
}

export async function attachOutcomeDelivery(orderIntentId, deliveryId) {
  if (!orderIntentId || !deliveryId) return
  await queryRun('UPDATE signal_outcomes SET delivery_id = ?, updated_at = ? WHERE order_intent_id = ?', [deliveryId, beijingNow(), orderIntentId])
}

export async function recordPendingOutcomeFill({ orderIntentId, deliveryId, positionId, orderTicket, dealTicket = null }) {
  if (!orderIntentId) return
  await queryRun(`UPDATE signal_outcomes SET delivery_id = COALESCE(?, delivery_id),
    position_id = COALESCE(?, position_id), entry_order_ticket = COALESCE(?, entry_order_ticket),
    entry_deal_ticket = COALESCE(?, entry_deal_ticket), updated_at = ? WHERE order_intent_id = ?`,
  [deliveryId || null, ref(positionId), ref(orderTicket), dealRef(dealTicket), beijingNow(), orderIntentId])
}

export async function reconcileTerminalPendingOutcomes() {
  const now = beijingNow()
  // Repair outcomes created by the legacy Bridge v3 adapter, which used the
  // pending order ticket as a fallback position id. Restrict the repair to an
  // explicitly active pending state with no entry deal, so a genuinely filled
  // order is never downgraded to pending by this compatibility cleanup.
  await queryRun(`UPDATE signal_outcomes outcomes
    LEFT JOIN auto_signal_deliveries deliveries ON deliveries.id = outcomes.delivery_id
    LEFT JOIN ai_signals signals ON signals.id = outcomes.signal_id
    SET outcomes.position_id = NULL, outcomes.entry_deal_ticket = NULL,
      outcomes.attribution_status = 'pending',
      outcomes.status = 'open', outcomes.updated_at = ?
    WHERE outcomes.pending_ticket IS NOT NULL
      AND outcomes.position_id = outcomes.pending_ticket
      AND COALESCE(NULLIF(TRIM(outcomes.entry_deal_ticket), ''), '0') = '0'
      AND outcomes.attribution_status = 'pending'
      AND COALESCE(deliveries.pending_state, signals.pending_state) = 'pending'`, [now])
  await queryRun(`UPDATE ai_position_management_tasks tasks
    JOIN signal_outcomes outcomes ON outcomes.id = tasks.outcome_id
    LEFT JOIN auto_signal_deliveries deliveries ON deliveries.id = outcomes.delivery_id
    LEFT JOIN ai_signals signals ON signals.id = outcomes.signal_id
    SET tasks.status = 'EXPIRED', tasks.confirmation_count = 0,
      tasks.completed_at = COALESCE(tasks.completed_at, ?), tasks.updated_at = ?
    WHERE tasks.task_type = 'position_exit'
      AND tasks.status IN ('CANDIDATE','EVIDENCE_CONFIRMED')
      AND outcomes.position_id IS NULL AND outcomes.pending_ticket IS NOT NULL
      AND COALESCE(deliveries.pending_state, signals.pending_state) = 'pending'`, [now, now])
  const result = await queryRun(`UPDATE signal_outcomes outcomes
    LEFT JOIN auto_signal_deliveries deliveries ON deliveries.id = outcomes.delivery_id
    LEFT JOIN ai_signals signals ON signals.id = outcomes.signal_id
    SET outcomes.status = COALESCE(deliveries.pending_state, signals.pending_state),
      outcomes.attribution_status = 'not_filled', outcomes.last_scan_at = ?, outcomes.updated_at = ?
    WHERE outcomes.status IN ('open','closing') AND outcomes.position_id IS NULL
      AND outcomes.pending_ticket IS NOT NULL
      AND COALESCE(deliveries.pending_state, signals.pending_state) IN ('cancelled','expired','superseded')`, [now, now])
  await queryRun(`UPDATE ai_trade_theses theses SET theses.status = 'closed', theses.updated_at = ?
    WHERE theses.status IN ('proposed','active')
      AND NOT EXISTS (SELECT 1 FROM signal_outcomes outcomes
        WHERE outcomes.thesis_id = theses.thesis_id AND outcomes.status IN ('open','closing'))`, [now])
  return Number(result?.changes || 0)
}

async function saveMatchedDeals(run, outcome, deals) {
  for (const deal of deals) {
    await run(`INSERT IGNORE INTO signal_outcome_deals
      (outcome_id, user_id, trading_account_id, deal_ticket, position_id, order_ticket, entry_type,
       magic, reason, comment, volume, price, profit, commission, swap, fee, deal_time, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      outcome.id, outcome.user_id, outcome.trading_account_id, dealTicket(deal), ref(deal.position_id), ref(deal.order),
      deal.entry ?? null, deal.magic ?? null, deal.reason ?? null, String(deal.comment || '').slice(0, 255),
      num(deal.volume), deal.price ?? null, num(deal.profit), num(deal.commission), num(deal.swap), num(deal.fee),
      dealTimeForDatabase(deal), JSON.stringify(deal), beijingNow(),
    ])
  }
}

async function clearRecoveredProtectionIncidentTx(run, outcome) {
  const [rows] = await run(`SELECT COUNT(*) AS unresolved_count
    FROM signal_outcomes outcomes
    JOIN order_intents intents ON intents.id = outcomes.order_intent_id
    WHERE outcomes.trading_account_id = ? AND outcomes.status IN ('open','closing','attribution_ambiguous')
      AND outcomes.protection_status IN ('missing_stop_loss','invalid_stop_loss_direction')
      AND intents.source_type <> 'manual'`, [outcome.trading_account_id])
  if (Number(rows?.[0]?.unresolved_count || 0) > 0) return false
  const [stateRows] = await run(`SELECT halt_status, halt_reason FROM risk_account_state
    WHERE trading_account_id = ? FOR UPDATE`, [outcome.trading_account_id])
  const state = stateRows?.[0]
  if (state?.halt_status !== 'protection_incident' || !PROTECTION_INCIDENTS.includes(String(state?.halt_reason || ''))) {
    return false
  }
  await run(`UPDATE risk_account_state SET halt_status = 'active', halt_reason = NULL, updated_at = ?
    WHERE trading_account_id = ? AND halt_status = 'protection_incident'
      AND halt_reason IN ('missing_stop_loss','invalid_stop_loss_direction')`,
  [beijingNow(), outcome.trading_account_id])
  return true
}

function outcomeHistoryEvidenceBatches(outcomes = []) {
  const references = []
  const seen = new Set()
  const append = (kind, value) => {
    const normalized = String(value ?? '').trim()
    if (!/^(?!0+$)\d{1,32}$/.test(normalized)) return
    const key = `${kind}:${normalized}`
    if (seen.has(key)) return
    seen.add(key)
    references.push({ kind, value:normalized })
  }
  for (const outcome of outcomes) {
    append('position', outcome.position_id)
    append('order', outcome.entry_order_ticket)
    append('order', outcome.pending_ticket)
  }
  const batches = []
  for (let offset = 0; offset < references.length; offset += HISTORY_EVIDENCE_REF_LIMIT) {
    const batch = references.slice(offset, offset + HISTORY_EVIDENCE_REF_LIMIT)
    batches.push({
      evidence_position_ids:batch.filter(item => item.kind === 'position').map(item => item.value),
      evidence_order_tickets:batch.filter(item => item.kind === 'order').map(item => item.value),
    })
  }
  return batches
}

export async function loadOutcomeHistory(bridge, userId, rangeStartUtcMsc, rangeEndUtcMsc,
  evidenceBatches = [], routeParams = {}) {
  const validRange = Number.isSafeInteger(rangeStartUtcMsc) && rangeStartUtcMsc > 0
    && Number.isSafeInteger(rangeEndUtcMsc) && rangeEndUtcMsc > rangeStartUtcMsc
  const brokerServer = String(routeParams?.broker_server || '').trim()
  const login = String(routeParams?.login || '').trim()
  if (!validRange || !brokerServer || brokerServer.length > 100 || !/^\d{1,32}$/.test(login)
    || !Array.isArray(evidenceBatches) || evidenceBatches.length === 0) return null
  const deals = []
  const historyOrders = []
  const seenDeals = new Set()
  const seenOrders = new Set()
  const normalizeBatch = batch => {
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return null
    const unknown = Object.keys(batch).some(key => !['evidence_position_ids', 'evidence_order_tickets'].includes(key))
    if (unknown) return null
    const normalize = value => {
      if (!Array.isArray(value)) return null
      const refs = value.map(item => String(item ?? '').trim())
      if (refs.some(item => !/^(?!0+$)\d{1,32}$/.test(item))) return null
      return [...new Set(refs)]
    }
    const positions = normalize(batch.evidence_position_ids ?? [])
    const orders = normalize(batch.evidence_order_tickets ?? [])
    if (!positions || !orders || positions.length + orders.length === 0
      || positions.length + orders.length > HISTORY_EVIDENCE_REF_LIMIT) return null
    return { evidence_position_ids:positions, evidence_order_tickets:orders }
  }
  const batches = evidenceBatches.map(normalizeBatch)
  if (batches.some(batch => !batch)) return null
  const mergeHistory = history => {
    if (history?.status !== 'success' || !Array.isArray(history.deals)
      || !Array.isArray(history.history_orders)) return false
    const historySync = history.history_sync
    if (historySync?.requested_range_complete !== true
      || historySync.requested_range_start_utc_msc !== rangeStartUtcMsc
      || historySync.requested_range_end_utc_msc !== rangeEndUtcMsc
      || historySync.evidence_truncated !== false
      || history.evidence_truncated !== false) return false
    if (history.deals.some(item => !item || typeof item !== 'object' || Array.isArray(item))
      || history.history_orders.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return false
    for (const deal of history.deals) {
      const key = String(deal?.deal_ticket || deal?.ticket || '')
      if (key && !seenDeals.has(key)) {
        seenDeals.add(key)
        deals.push(deal)
      }
    }
    for (const order of Array.isArray(history.history_orders) ? history.history_orders : []) {
      const key = String(order?.ticket || order?.order || '')
      if (key && !seenOrders.has(key)) {
        seenOrders.add(key)
        historyOrders.push(order)
      }
    }
    return true
  }
  for (const batch of batches) {
    let history
    try {
      history = await bridge(userId, 'history_evidence', {
        range_start_utc_msc:rangeStartUtcMsc,
        range_end_utc_msc:rangeEndUtcMsc,
        broker_server:brokerServer,
        login,
        ...batch,
      }, { noFallback:true })
    } catch {
      return null
    }
    if (!mergeHistory(history)) return null
  }
  return { status:'success', deals, history_orders:historyOrders }
}

export async function reconcileSignalOutcomes({ bridge = mt5Bridge } = {}) {
  await reconcileTerminalPendingOutcomes()
  // Keep one sealed UTC end boundary stable for all users/pages in this pass.
  const reconciliationRangeEndUtcMsc = outcomeReconciliationRangeEndUtcMsc()
  if (!reconciliationRangeEndUtcMsc) return 0
  const outcomes = await queryAll(`SELECT so.*, oi.bridge_command_ref, oi.approved_order_json,
      ownership.broker_server_key, ownership.login_account,
      CAST(UNIX_TIMESTAMP(ownership.started_at) * 1000 AS UNSIGNED) AS ownership_started_at_utc_msc
    FROM signal_outcomes so JOIN order_intents oi ON oi.id = so.order_intent_id
    JOIN mt5_account_ownership_history ownership
      ON ownership.id = so.ownership_history_id
      AND ownership.trading_account_id = so.trading_account_id
      AND ownership.user_id = so.user_id
      AND ownership.ended_at IS NULL
    WHERE so.status IN ('open','closing') ORDER BY so.user_id, so.id`)
  const byAccountOwnership = new Map()
  for (const outcome of outcomes) {
    const key = `${outcome.user_id}:${outcome.trading_account_id}:${outcome.ownership_history_id}`
    if (!byAccountOwnership.has(key)) byAccountOwnership.set(key, [])
    byAccountOwnership.get(key).push(outcome)
  }
  let closed = 0
  for (const userOutcomes of byAccountOwnership.values()) {
    const userId = userOutcomes[0]?.user_id
    const brokerServer = String(userOutcomes[0]?.broker_server_key || '').trim()
    const login = String(userOutcomes[0]?.login_account || '').trim()
    if (!userId || !brokerServer || !/^\d{1,32}$/.test(login)
      || userOutcomes.some(item => String(item.broker_server_key || '').trim().toUpperCase() !== brokerServer.toUpperCase()
        || String(item.login_account || '').trim() !== login)) continue
    let history, positions
    const earliestCreated = userOutcomes.map(item => String(item.created_at || '').slice(0, 10)).filter(Boolean).sort()[0]
    const earliestDateStartUtcMsc = utcDateStartUtcMsc(earliestCreated)
    const ownershipStarts = userOutcomes.map(ownershipStartUtcMsc)
    const knownOwnershipStarts = ownershipStarts.filter(value => Number.isSafeInteger(value) && value > 0)
    if (!earliestDateStartUtcMsc || knownOwnershipStarts.length !== ownershipStarts.length) continue
    const ownershipClampedRangeStartUtcMsc = Math.max(earliestDateStartUtcMsc, Math.max(...knownOwnershipStarts))
    try {
      ;[history, positions] = await Promise.all([
        loadOutcomeHistory(bridge, userId, ownershipClampedRangeStartUtcMsc,
          reconciliationRangeEndUtcMsc, outcomeHistoryEvidenceBatches(userOutcomes),
          { broker_server:brokerServer, login }),
        bridge(userId, 'positions', { broker_server:brokerServer, login }, { noFallback: true }),
      ])
    } catch { continue }
    if (history?.status !== 'success' || !Array.isArray(history.deals) || positions?.status === 'error' || !Array.isArray(positions?.positions)) continue
    const firstPass = userOutcomes.map(outcome => ({ outcome, result: analyzeOutcomeAttribution(outcome, history.deals, positions.positions, history.history_orders || [], 1) }))
    const counts = new Map()
    for (const item of firstPass) if (item.result.positionId) {
      const key = `${item.outcome.trading_account_id}:${item.result.positionId}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    for (const item of firstPass) {
      const key = `${item.outcome.trading_account_id}:${item.result.positionId}`
      const result = analyzeOutcomeAttribution(item.outcome, history.deals, positions.positions, history.history_orders || [], counts.get(key) || 1)
      const currentPosition = positionForOutcome(item.outcome, result, positions.positions)
      const protection = currentPosition
        ? positionProtectionStatus(currentPosition, item.outcome.entry_direction)
        : { status:'unknown', actualStopLoss:null, actualTakeProfit:null, systemOwned:false }
      let protectionIncidentCreated = false
      let protectionIncidentCleared = false
      await withTransaction(async run => {
        const [lockedRows] = await run('SELECT * FROM signal_outcomes WHERE id = ? FOR UPDATE', [item.outcome.id])
        const locked = lockedRows[0]
        if (!locked || !OPEN_STATUSES.includes(locked.status)) return
        const protectionModified = currentPosition && num(locked.original_stop_loss) > 0
          ? Math.abs(num(locked.original_stop_loss) - num(protection.actualStopLoss)) > 1e-8 : false
        if (currentPosition) {
          await run(`UPDATE signal_outcomes SET actual_stop_loss = ?, actual_take_profit = ?,
            protection_status = ?, protection_modified = ?, last_position_snapshot_json = ?, updated_at = ?
            WHERE id = ?`, [
            protection.actualStopLoss, protection.actualTakeProfit, protection.status, protectionModified ? 1 : 0,
            JSON.stringify(currentPosition), beijingNow(), locked.id,
          ])
        }
        if (currentPosition && protection.systemOwned && PROTECTION_INCIDENTS.includes(protection.status)) {
          await run(`INSERT INTO risk_account_state
            (trading_account_id, user_id, halt_status, halt_reason, created_at, updated_at)
            VALUES (?, ?, 'protection_incident', ?, ?, ?)
            ON DUPLICATE KEY UPDATE halt_status = CASE WHEN halt_status IN ('active','protection_incident')
              THEN 'protection_incident' ELSE halt_status END,
              halt_reason = CASE WHEN halt_status IN ('active','protection_incident') THEN VALUES(halt_reason) ELSE halt_reason END,
              updated_at = VALUES(updated_at)`, [
            locked.trading_account_id, locked.user_id, protection.status, beijingNow(), beijingNow(),
          ])
          protectionIncidentCreated = String(locked.protection_status || '') !== protection.status
        }
        if (currentPosition && protection.systemOwned && protection.status === 'protected') {
          protectionIncidentCleared = await clearRecoveredProtectionIncidentTx(run, locked)
        }
        if (result.attributionStatus === 'attribution_ambiguous') {
          await run(`UPDATE signal_outcomes SET position_id = ?, status = 'attribution_ambiguous',
            attribution_status = 'attribution_ambiguous', review_eligible_at = NULL, last_scan_at = ?, updated_at = ? WHERE id = ?`,
          [result.positionId, beijingNow(), beijingNow(), locked.id])
          return
        }
        if (result.attributionStatus !== 'attributed') {
          await run('UPDATE signal_outcomes SET last_scan_at = ?, updated_at = ? WHERE id = ?', [beijingNow(), beijingNow(), locked.id])
          return
        }
        await saveMatchedDeals(run, locked, result.matchedDeals)
        const now = beijingNow()
        const transition = resolveOutcomeClosureTransition(locked, result, now)
        await run(`UPDATE signal_outcomes SET position_id = ?, entry_volume = ?, closed_volume = ?,
          gross_profit = ?, commission = ?, swap = ?, fee = ?, net_profit = ?, attribution_status = 'attributed',
          external_intervention = ?, intervention_json = ?, status = ?, closing_candidate_hash = ?,
          fee_stable_at = ?, fully_closed_at = ?, review_eligible_at = ?, last_scan_at = ?, updated_at = ?,
          actual_stop_loss = ?, actual_take_profit = ?, protection_status = ? WHERE id = ?`, [
          result.positionId, result.entryVolume, result.closedVolume, result.grossProfit, result.commission,
          result.swap, result.fee, result.netProfit, result.externalIntervention ? 1 : 0,
          JSON.stringify(result.interventions), transition.status, result.complete ? result.feeHash : null,
          transition.feeStableAt, result.complete ? result.latestExit : null,
          transition.reviewEligibleAt, now, now, protection.actualStopLoss, protection.actualTakeProfit,
          currentPosition ? protection.status : (result.complete ? 'position_closed' : locked.protection_status), locked.id,
        ])
        if (!currentPosition && result.complete) {
          protectionIncidentCleared = await clearRecoveredProtectionIncidentTx(run, locked)
        }
        if (transition.status === 'closed') closed += 1
      })
      if (protectionIncidentCreated) {
        const payload = {
          type:'position_protection_incident', outcome_id:Number(item.outcome.id),
          trading_account_id:Number(item.outcome.trading_account_id), status:protection.status,
          message:protection.status === 'missing_stop_loss'
            ? '检测到系统持仓缺少真实止损，已停止该账户新增风险'
            : '检测到系统持仓止损方向异常，已停止该账户新增风险',
        }
        sendToBrowsers(Number(item.outcome.user_id), payload)
        broadcastAdminEvent('risk-audit', 'position_protection_incident', {
          user_id:Number(item.outcome.user_id), ...payload,
        }, { scopes:['overview', 'ai-operations', 'risk-audit'], refresh:true })
      }
      if (protectionIncidentCleared) {
        const payload = {
          type:'position_protection_recovered', outcome_id:Number(item.outcome.id),
          trading_account_id:Number(item.outcome.trading_account_id),
          message:'系统仓位保护已恢复，账户已自动解除新开仓暂停',
        }
        sendToBrowsers(Number(item.outcome.user_id), payload)
        broadcastAdminEvent('risk-audit', 'position_protection_recovered', {
          user_id:Number(item.outcome.user_id), ...payload,
        }, { scopes:['overview', 'ai-operations', 'risk-audit'], refresh:true })
      }
    }
  }
  return closed
}

export function startOutcomeMonitor(intervalMs = 60_000) {
  if (monitorTimer) return
  monitorTimer = setInterval(() => reconcileSignalOutcomes().catch(error => console.error('[OutcomeMonitor]', error.message)), intervalMs)
}

export function stopOutcomeMonitor() {
  if (monitorTimer) clearInterval(monitorTimer)
  monitorTimer = null
}
