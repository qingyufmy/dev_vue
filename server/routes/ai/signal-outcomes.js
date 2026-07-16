import crypto from 'crypto'
import { queryAll, queryOne, queryRun, withTransaction, beijingNow } from '../../db.js'
import { mt5Bridge } from './market-data.js'

const SYSTEM_MAGIC = 234000
const OPEN_STATUSES = ['open', 'closing']
let monitorTimer = null

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0
const ref = value => value == null || String(value).trim() === '' ? null : String(value)
const parse = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback } catch { return fallback } }
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

function dealTicket(deal) { return ref(deal?.deal_ticket ?? deal?.ticket) }
function dealNet(deal) { return num(deal?.profit) + num(deal?.commission) + num(deal?.swap) + num(deal?.fee) }
function isEntry(deal) { return Number(deal?.entry) === 0 }
function isExit(deal) { return [1, 3].includes(Number(deal?.entry)) }

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
  if (current && approved.sl != null && num(current.sl) !== num(approved.sl)) interventions.push('stop_loss_modified')
  if (current && approved.tp != null && num(current.tp) !== num(approved.tp)) interventions.push('take_profit_modified')
  const entryOrder = historyOrders.find(order => orderRefs.has(ref(order.ticket)) || ref(order.position_id) === resolvedPositionId)
  if (entryOrder && num(entryOrder.magic) !== SYSTEM_MAGIC) interventions.push('entry_order_magic_mismatch')

  const grossProfit = deals.reduce((sum, deal) => sum + num(deal.profit), 0)
  const commission = deals.reduce((sum, deal) => sum + num(deal.commission), 0)
  const swap = deals.reduce((sum, deal) => sum + num(deal.swap), 0)
  const fee = deals.reduce((sum, deal) => sum + num(deal.fee), 0)
  const latestExit = exits.map(deal => deal.time).filter(Boolean).sort().at(-1) || null
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

export async function createSignalOutcomeTx(run, intent, bridgeResult, bridgeAction = null) {
  if (!intent?.trading_account_id) return null
  const request = parse(intent.approved_order_json, parse(intent.request_json))
  const [accounts] = await run('SELECT margin_mode FROM trading_accounts WHERE id = ? LIMIT 1', [intent.trading_account_id])
  const marginMode = accounts[0]?.margin_mode || 'netting'
  const now = beijingNow()
  const positionId = ref(bridgeResult?.position_id ?? bridgeResult?.position)
  const orderTicket = ref(bridgeResult?.order ?? bridgeResult?.ticket)
  const deal = ref(bridgeResult?.deal ?? bridgeResult?.deal_ticket)
  const pending = (bridgeAction || intent.action) === 'pending' ? orderTicket : null
  const sourceSignalId = String(intent.source_id || '').split(':', 1)[0]
  const signalId = Number(sourceSignalId) > 0 ? Number(sourceSignalId) : null
  await run(`INSERT INTO signal_outcomes
    (signal_id, order_intent_id, user_id, trading_account_id, margin_mode, symbol,
     entry_order_ticket, entry_deal_ticket, pending_ticket, position_id, expected_volume,
     status, attribution_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'pending', ?, ?)
    ON DUPLICATE KEY UPDATE entry_order_ticket = COALESCE(VALUES(entry_order_ticket), entry_order_ticket),
      entry_deal_ticket = COALESCE(VALUES(entry_deal_ticket), entry_deal_ticket),
      pending_ticket = COALESCE(VALUES(pending_ticket), pending_ticket),
      position_id = COALESCE(VALUES(position_id), position_id), updated_at = VALUES(updated_at)`, [
    signalId, intent.id, intent.user_id, intent.trading_account_id, marginMode,
    String(request.symbol || ''), orderTicket, deal, pending, positionId, num(request.volume || request.lot), now, now,
  ])
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
  [deliveryId || null, ref(positionId), ref(orderTicket), ref(dealTicket), beijingNow(), orderIntentId])
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
      deal.time || null, JSON.stringify(deal), beijingNow(),
    ])
  }
}

export async function reconcileSignalOutcomes({ bridge = mt5Bridge } = {}) {
  const outcomes = await queryAll(`SELECT so.*, oi.bridge_command_ref, oi.approved_order_json
    FROM signal_outcomes so JOIN order_intents oi ON oi.id = so.order_intent_id
    WHERE so.status IN ('open','closing') ORDER BY so.user_id, so.id`)
  const byUser = new Map()
  for (const outcome of outcomes) {
    if (!byUser.has(outcome.user_id)) byUser.set(outcome.user_id, [])
    byUser.get(outcome.user_id).push(outcome)
  }
  let closed = 0
  for (const [userId, userOutcomes] of byUser) {
    let history, positions
    const earliestCreated = userOutcomes.map(item => String(item.created_at || '').slice(0, 10)).filter(Boolean).sort()[0]
    try {
      ;[history, positions] = await Promise.all([
        bridge(userId, 'history', { page: 1, page_size: 5000, include_deals: true, ...(earliestCreated ? { date_from: earliestCreated } : {}) }, { noFallback: true }),
        bridge(userId, 'positions', {}, { noFallback: true }),
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
      await withTransaction(async run => {
        const [lockedRows] = await run('SELECT * FROM signal_outcomes WHERE id = ? FOR UPDATE', [item.outcome.id])
        const locked = lockedRows[0]
        if (!locked || !OPEN_STATUSES.includes(locked.status)) return
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
          fee_stable_at = ?, fully_closed_at = ?, review_eligible_at = ?, last_scan_at = ?, updated_at = ? WHERE id = ?`, [
          result.positionId, result.entryVolume, result.closedVolume, result.grossProfit, result.commission,
          result.swap, result.fee, result.netProfit, result.externalIntervention ? 1 : 0,
          JSON.stringify(result.interventions), transition.status, result.complete ? result.feeHash : null,
          transition.feeStableAt, result.complete ? result.latestExit : null,
          transition.reviewEligibleAt, now, now, locked.id,
        ])
        if (transition.status === 'closed') closed += 1
      })
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
