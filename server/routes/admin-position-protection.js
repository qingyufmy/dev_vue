import crypto from 'crypto'
import { Router } from 'express'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { beijingNow, logAudit, queryAll, queryOne, queryRun, withTransaction } from '../db.js'
import {
  broadcastAdminEvent,
  getBridgeGeneration,
  isBridgeAlive,
  sendBridgeCommand,
  sendToAdminBrowsers,
} from '../bridge-ws.js'
import { mt5Bridge } from './ai/market-data.js'

export const SYSTEM_POSITION_MAGIC = 234000
const OPEN_OUTCOME_STATUSES = ['open', 'closing']
const JOB_ACTIVE_STATUSES = ['queued', 'running']
const WORKER_INTERVAL_MS = 2000
const COMMAND_TIMEOUT_MS = 20000

const router = Router()
let workerTimer = null
let workerRunning = false

const textValue = value => String(value ?? '').trim()
const numeric = value => Number.isFinite(Number(value)) ? Number(value) : null
const positionRef = outcome => textValue(outcome?.position_id || outcome?.entry_order_ticket)
const targetKey = target => `${Number(target.user_id)}:${Number(target.trading_account_id)}:${textValue(target.ticket)}`

function protectionError(code, message = '') {
  const error = new Error(code)
  error.code = code
  error.publicMessage = message
  return error
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function normalizeProtectionInput(input = {}) {
  const stopLoss = input.stop_loss == null || input.stop_loss === '' ? null : Number(input.stop_loss)
  const takeProfit = input.take_profit == null || input.take_profit === '' ? null : Number(input.take_profit)
  if (stopLoss !== null && (!Number.isFinite(stopLoss) || stopLoss <= 0)) throw protectionError('invalid_stop_loss')
  if (takeProfit !== null && (!Number.isFinite(takeProfit) || takeProfit <= 0)) throw protectionError('invalid_take_profit')
  if (stopLoss === null && takeProfit === null) throw protectionError('protection_price_required')
  const syncScope = input.sync_scope === 'signal' ? 'signal' : 'source_only'
  const reason = textValue(input.reason)
  if (reason.length < 2 || reason.length > 500) throw protectionError('change_reason_required')
  return { stopLoss, takeProfit, syncScope, reason }
}

function ensureInventory(result) {
  if (result?.status !== 'success' || !result.account || !Array.isArray(result.positions)) {
    throw protectionError('source_inventory_unavailable', textValue(result?.message || result?.error))
  }
  return result
}

function findInventoryPosition(inventory, ticket) {
  const wanted = textValue(ticket)
  return inventory.positions.find(position => textValue(position.ticket) === wanted) || null
}

async function findCurrentAccount(userId, account) {
  return queryOne(`SELECT ta.id AS trading_account_id, ta.user_id, ta.margin_mode,
      ownership.id AS ownership_history_id, ownership.broker_server_key, ownership.login_account
    FROM trading_accounts ta
    JOIN mt5_account_ownership_history ownership
      ON ownership.trading_account_id = ta.id AND ownership.user_id = ta.user_id
      AND ownership.ended_at IS NULL
    WHERE ta.user_id = ? AND ta.is_deleted = 0
      AND UPPER(ta.broker_server) = ? AND ta.login_account = ?
    ORDER BY ownership.started_at DESC, ownership.id DESC LIMIT 1`, [
    Number(userId), textValue(account.server).toUpperCase(), textValue(account.login),
  ])
}

async function loadSourceContext(actorUserId, ticket, { bridge = mt5Bridge } = {}) {
  if (!textValue(ticket)) throw protectionError('position_ticket_required')
  const inventory = ensureInventory(await bridge(actorUserId, 'system_trade_inventory', {}, {
    noFallback:true,
    timeoutMs:10000,
  }))
  const position = findInventoryPosition(inventory, ticket)
  if (!position) throw protectionError('system_position_not_found')
  if (Number(position.magic) !== SYSTEM_POSITION_MAGIC) throw protectionError('position_not_system_owned')
  const account = await findCurrentAccount(actorUserId, inventory.account)
  if (!account) throw protectionError('source_account_identity_unavailable')

  const outcomes = await queryAll(`SELECT outcomes.*, users.email, users.nickname
    FROM signal_outcomes outcomes
    LEFT JOIN users ON users.id = outcomes.user_id
    WHERE outcomes.user_id = ? AND outcomes.trading_account_id = ?
      AND outcomes.status IN (?, ?)
      AND (outcomes.position_id = ? OR outcomes.entry_order_ticket = ?)
    ORDER BY outcomes.id`, [
    Number(actorUserId), Number(account.trading_account_id),
    ...OPEN_OUTCOME_STATUSES, textValue(ticket), textValue(ticket),
  ])
  const attributable = outcomes.filter(outcome => Number(outcome.system_magic || SYSTEM_POSITION_MAGIC) === SYSTEM_POSITION_MAGIC)
  const signalIds = [...new Set(attributable.map(outcome => Number(outcome.signal_id)).filter(Boolean))]
  const sourceOutcome = attributable.length === 1 && signalIds.length === 1 ? attributable[0] : null
  return { inventory, position, account, outcomes:attributable, sourceOutcome, signalIds }
}

function buildSourceTarget(context, actorUserId) {
  const { position, account, sourceOutcome } = context
  return {
    is_source:true,
    user_id:Number(actorUserId),
    trading_account_id:Number(account.trading_account_id),
    ownership_history_id:Number(account.ownership_history_id) || null,
    signal_id:Number(sourceOutcome?.signal_id) || null,
    outcome_id:Number(sourceOutcome?.id) || null,
    broker_server_key:textValue(account.broker_server_key),
    login_account:textValue(account.login_account),
    ticket:textValue(position.ticket),
    symbol:textValue(position.symbol),
    direction:textValue(position.type).toLowerCase(),
    volume:Number(position.volume || 0),
    magic:Number(position.magic),
    current_stop_loss:numeric(position.sl) || 0,
    current_take_profit:numeric(position.tp) || 0,
    bridge_connected:isBridgeAlive(Number(actorUserId)),
    user_label:textValue(sourceOutcome?.nickname || sourceOutcome?.email) || `用户 ${actorUserId}`,
  }
}

async function loadSignalTargets(sourceContext, actorUserId) {
  const signalId = Number(sourceContext.sourceOutcome?.signal_id)
  if (!signalId) return { targets:[], exclusions:[] }
  const rows = await queryAll(`SELECT outcomes.*, users.email, users.nickname,
      ownership.id AS current_ownership_history_id,
      ownership.broker_server_key AS current_broker_server_key,
      ownership.login_account AS current_login_account,
      accounts.margin_mode AS current_margin_mode,
      (SELECT COUNT(*) FROM signal_outcomes siblings
        WHERE siblings.user_id = outcomes.user_id
          AND siblings.trading_account_id = outcomes.trading_account_id
          AND siblings.status IN (?, ?)
          AND siblings.position_id = outcomes.position_id) AS position_source_count
    FROM signal_outcomes outcomes
    JOIN users ON users.id = outcomes.user_id
    JOIN trading_accounts accounts ON accounts.id = outcomes.trading_account_id
      AND accounts.user_id = outcomes.user_id AND accounts.is_deleted = 0
    JOIN mt5_account_ownership_history ownership
      ON ownership.trading_account_id = outcomes.trading_account_id
      AND ownership.user_id = outcomes.user_id AND ownership.ended_at IS NULL
    WHERE outcomes.signal_id = ? AND outcomes.status IN (?, ?)
      AND outcomes.position_id IS NOT NULL
      AND COALESCE(outcomes.system_magic, ?) = ?
    ORDER BY outcomes.user_id, outcomes.trading_account_id, outcomes.id`, [
    ...OPEN_OUTCOME_STATUSES, signalId, ...OPEN_OUTCOME_STATUSES,
    SYSTEM_POSITION_MAGIC, SYSTEM_POSITION_MAGIC,
  ])

  const targets = []
  const exclusions = []
  const seen = new Set()
  for (const outcome of rows) {
    const ticket = positionRef(outcome)
    const key = `${Number(outcome.user_id)}:${Number(outcome.trading_account_id)}:${ticket}`
    if (!ticket || seen.has(key)) continue
    seen.add(key)
    if (Number(outcome.position_source_count || 0) !== 1) {
      exclusions.push({ user_id:Number(outcome.user_id), ticket, reason:'multiple_position_sources' })
      continue
    }
    targets.push({
      is_source:Number(outcome.user_id) === Number(actorUserId)
        && Number(outcome.trading_account_id) === Number(sourceContext.account.trading_account_id)
        && ticket === textValue(sourceContext.position.ticket),
      user_id:Number(outcome.user_id),
      trading_account_id:Number(outcome.trading_account_id),
      ownership_history_id:Number(outcome.current_ownership_history_id) || null,
      signal_id:signalId,
      outcome_id:Number(outcome.id),
      broker_server_key:textValue(outcome.current_broker_server_key),
      login_account:textValue(outcome.current_login_account),
      ticket,
      symbol:textValue(outcome.original_symbol || outcome.symbol),
      direction:textValue(outcome.entry_direction).toLowerCase(),
      volume:Number(outcome.expected_volume || outcome.entry_volume || 0),
      magic:SYSTEM_POSITION_MAGIC,
      current_stop_loss:null,
      current_take_profit:null,
      bridge_connected:isBridgeAlive(Number(outcome.user_id)),
      user_label:textValue(outcome.nickname || outcome.email) || `用户 ${outcome.user_id}`,
    })
  }
  return { targets, exclusions }
}

export async function getPositionProtectionPreview(actorUserId, ticket, options = {}) {
  const syncScope = options.syncScope === 'signal' ? 'signal' : 'source_only'
  const context = await loadSourceContext(actorUserId, ticket, options)
  const sourceTarget = buildSourceTarget(context, actorUserId)
  const syncAvailable = context.outcomes.length === 1 && context.signalIds.length === 1
  if (syncScope === 'signal' && !syncAvailable) throw protectionError(
    context.outcomes.length > 1 ? 'multiple_source_signals' : 'source_signal_unavailable',
  )
  const resolved = syncScope === 'signal'
    ? await loadSignalTargets(context, actorUserId)
    : { targets:[sourceTarget], exclusions:[] }
  const targetsByKey = new Map(resolved.targets.map(target => [targetKey(target), target]))
  targetsByKey.set(targetKey(sourceTarget), { ...targetsByKey.get(targetKey(sourceTarget)), ...sourceTarget, is_source:true })
  const targets = [...targetsByKey.values()].sort((a, b) => Number(b.is_source) - Number(a.is_source)
    || Number(a.user_id) - Number(b.user_id))
  const previewHash = stableHash({
    actor_user_id:Number(actorUserId),
    source_ticket:textValue(ticket),
    source_stop_loss:sourceTarget.current_stop_loss,
    source_take_profit:sourceTarget.current_take_profit,
    sync_scope:syncScope,
    targets:targets.map(target => [target.user_id, target.trading_account_id, target.ticket, target.outcome_id]),
  })
  return {
    source:{ ...sourceTarget, signal_id:Number(context.sourceOutcome?.signal_id) || null },
    sync_scope:syncScope,
    sync_available:syncAvailable,
    sync_unavailable_reason:syncAvailable ? null
      : context.outcomes.length > 1 ? 'multiple_source_signals' : 'source_signal_unavailable',
    affected_users:new Set(targets.map(target => target.user_id)).size,
    affected_positions:targets.length,
    online_users:new Set(targets.filter(target => target.bridge_connected).map(target => target.user_id)).size,
    exclusions:resolved.exclusions,
    targets,
    preview_hash:previewHash,
  }
}

async function insertJob(actorUserId, ticket, input, preview) {
  const now = beijingNow()
  const idempotencyKey = textValue(input.idempotency_key) || crypto.randomUUID()
  return withTransaction(async run => {
    const [existingRows] = await run('SELECT id FROM admin_position_protection_jobs WHERE idempotency_key = ? LIMIT 1', [idempotencyKey])
    if (existingRows[0]) return Number(existingRows[0].id)
    const [jobResult] = await run(`INSERT INTO admin_position_protection_jobs
      (idempotency_key, actor_user_id, source_user_id, source_trading_account_id,
       source_outcome_id, source_signal_id, source_ticket, source_symbol, source_direction,
       requested_stop_loss, requested_take_profit, sync_scope, change_reason, preview_hash,
       status, total_users, total_positions, pending_positions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`, [
      idempotencyKey, Number(actorUserId), Number(preview.source.user_id), Number(preview.source.trading_account_id),
      preview.source.outcome_id || null, preview.source.signal_id || null, textValue(ticket),
      preview.source.symbol, preview.source.direction, input.stopLoss, input.takeProfit,
      input.syncScope, input.reason, preview.preview_hash, preview.affected_users,
      preview.affected_positions, preview.affected_positions, now, now,
    ])
    const jobId = Number(jobResult.insertId)
    let order = 0
    for (const target of preview.targets) {
      await run(`INSERT INTO admin_position_protection_targets
        (job_id, target_order, is_source, user_id, trading_account_id, ownership_history_id,
         signal_id, outcome_id, broker_server_key, login_account, ticket, symbol, direction,
         volume, magic, expected_stop_loss, expected_take_profit, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, [
        jobId, order++, target.is_source ? 1 : 0, target.user_id, target.trading_account_id,
        target.ownership_history_id, target.signal_id, target.outcome_id,
        target.broker_server_key, target.login_account, target.ticket, target.symbol,
        target.direction, target.volume, target.magic,
        target.is_source ? target.current_stop_loss : null,
        target.is_source ? target.current_take_profit : null,
        now, now,
      ])
    }
    return jobId
  })
}

export async function createPositionProtectionJob(actorUserId, ticket, body = {}, options = {}) {
  const suppliedKey = textValue(body.idempotency_key)
  if (suppliedKey) {
    const existing = await queryOne(`SELECT id FROM admin_position_protection_jobs
      WHERE idempotency_key = ? AND actor_user_id = ? LIMIT 1`, [suppliedKey, Number(actorUserId)])
    if (existing) return getPositionProtectionJob(existing.id)
  }
  const input = normalizeProtectionInput(body)
  const preview = await getPositionProtectionPreview(actorUserId, ticket, {
    ...options,
    syncScope:input.syncScope,
  })
  if (textValue(body.preview_hash) !== preview.preview_hash) throw protectionError('position_preview_changed')
  const nextStopLoss = input.stopLoss ?? Number(preview.source.current_stop_loss || 0)
  const nextTakeProfit = input.takeProfit ?? Number(preview.source.current_take_profit || 0)
  if (Math.abs(nextStopLoss - Number(preview.source.current_stop_loss || 0)) <= 1e-8
    && Math.abs(nextTakeProfit - Number(preview.source.current_take_profit || 0)) <= 1e-8) {
    throw protectionError('protection_price_unchanged')
  }
  const jobId = await insertJob(actorUserId, ticket, input, preview)
  void runProtectionWorkerOnce()
  return getPositionProtectionJob(jobId)
}

function serializeTarget(row) {
  return {
    id:Number(row.id),
    is_source:Boolean(Number(row.is_source)),
    user_id:Number(row.user_id),
    user_label:textValue(row.nickname || row.email) || `用户 ${row.user_id}`,
    trading_account_id:Number(row.trading_account_id),
    ticket:textValue(row.ticket),
    symbol:textValue(row.symbol),
    status:textValue(row.status),
    attempt_count:Number(row.attempt_count || 0),
    error_code:row.error_code || null,
    error_message:row.error_message || null,
    completed_at:row.completed_at || null,
  }
}

export async function getPositionProtectionJob(jobId, { includeTargets = true } = {}) {
  const job = await queryOne('SELECT * FROM admin_position_protection_jobs WHERE id = ? LIMIT 1', [Number(jobId)])
  if (!job) throw protectionError('position_protection_job_not_found')
  const targets = includeTargets
    ? await queryAll(`SELECT targets.*, users.email, users.nickname
      FROM admin_position_protection_targets targets
      LEFT JOIN users ON users.id = targets.user_id
      WHERE targets.job_id = ? ORDER BY targets.target_order, targets.id`, [Number(jobId)])
    : null
  const total = Number(job.total_positions || 0)
  const completed = Number(job.succeeded_positions || 0) + Number(job.failed_positions || 0) + Number(job.skipped_positions || 0)
  return {
    id:Number(job.id),
    status:textValue(job.status),
    sync_scope:textValue(job.sync_scope),
    source_ticket:textValue(job.source_ticket),
    requested_stop_loss:numeric(job.requested_stop_loss),
    requested_take_profit:numeric(job.requested_take_profit),
    reason:textValue(job.change_reason),
    total_users:Number(job.total_users || 0),
    total_positions:total,
    succeeded_positions:Number(job.succeeded_positions || 0),
    failed_positions:Number(job.failed_positions || 0),
    skipped_positions:Number(job.skipped_positions || 0),
    pending_positions:Number(job.pending_positions || 0),
    progress_percent:total ? Math.round(completed / total * 100) : 0,
    created_at:job.created_at,
    started_at:job.started_at,
    completed_at:job.completed_at,
    ...(targets ? { targets:targets.map(serializeTarget) } : {}),
  }
}

async function publishJob(jobId, target = null) {
  const job = await getPositionProtectionJob(jobId, { includeTargets:!target })
  sendToAdminBrowsers({ type:'position_protection_job_updated', job })
  if (target) sendToAdminBrowsers({ type:'position_protection_target_updated', job_id:jobId, target })
  broadcastAdminEvent('ai-operations', 'position_protection_job_updated', {
    job_id:jobId,
    status:job.status,
    progress_percent:job.progress_percent,
  }, { refresh:false, throttleKey:`position-protection:${jobId}`, minIntervalMs:250 })
  return job
}

async function refreshJobCounts(jobId, status = null) {
  const counts = await queryOne(`SELECT
      SUM(status = 'succeeded') AS succeeded,
      SUM(status = 'failed') AS failed,
      SUM(status = 'skipped') AS skipped,
      SUM(status IN ('pending','running')) AS pending
    FROM admin_position_protection_targets WHERE job_id = ?`, [Number(jobId)])
  const params = [Number(counts?.succeeded || 0), Number(counts?.failed || 0),
    Number(counts?.skipped || 0), Number(counts?.pending || 0), beijingNow()]
  let sql = `UPDATE admin_position_protection_jobs SET succeeded_positions = ?, failed_positions = ?,
    skipped_positions = ?, pending_positions = ?, updated_at = ?`
  if (status) {
    sql += ', status = ?, completed_at = ?'
    params.push(status, beijingNow())
  }
  sql += ' WHERE id = ?'
  params.push(Number(jobId))
  await queryRun(sql, params)
}

function commandError(result) {
  const message = textValue(result?.message || result?.error || 'position_protection_command_failed')
  const code = /^[a-z0-9_:-]+$/i.test(message) ? message : textValue(result?.code || 'position_protection_command_failed')
  return { code, message }
}

export async function executePositionProtectionTarget(job, target) {
  const generation = getBridgeGeneration(target.user_id)
  if (generation == null || !isBridgeAlive(target.user_id)) {
    throw protectionError('bridge_offline')
  }
  const inventory = ensureInventory(await mt5Bridge(target.user_id, 'system_trade_inventory', {}, {
    noFallback:true,
    timeoutMs:10000,
    expectedGeneration:generation,
  }))
  if (textValue(inventory.account.server).toUpperCase() !== textValue(target.broker_server_key).toUpperCase()
    || textValue(inventory.account.login) !== textValue(target.login_account)) {
    throw protectionError('management_account_identity_mismatch')
  }
  const position = findInventoryPosition(inventory, target.ticket)
  if (!position) throw protectionError('system_position_not_found')
  if (Number(position.magic) !== SYSTEM_POSITION_MAGIC) throw protectionError('position_not_system_owned')
  const expectedStopLoss = Number(target.is_source) && target.expected_stop_loss != null
    ? Number(target.expected_stop_loss) : Number(position.sl || 0)
  const expectedTakeProfit = Number(target.is_source) && target.expected_take_profit != null
    ? Number(target.expected_take_profit) : Number(position.tp || 0)
  const result = await sendBridgeCommand(target.user_id, 'modify_system_position_protection', {
    operation_id:`admin-protection:${job.id}:${target.id}:${Number(target.attempt_count || 0) + 1}`,
    ticket:target.ticket,
    stop_loss:job.requested_stop_loss == null ? null : Number(job.requested_stop_loss),
    take_profit:job.requested_take_profit == null ? null : Number(job.requested_take_profit),
    expected_state:{
      broker_server_key:target.broker_server_key,
      login_account:target.login_account,
      ticket:target.ticket,
      symbol:Number(target.is_source) ? target.symbol : position.symbol,
      direction:Number(target.is_source) ? target.direction : position.type,
      volume:Number(target.is_source) ? Number(target.volume || 0) : Number(position.volume || 0),
      magic:SYSTEM_POSITION_MAGIC,
      stop_loss:expectedStopLoss,
      take_profit:expectedTakeProfit,
    },
  }, COMMAND_TIMEOUT_MS, { noFallback:true, expectedGeneration:generation })
  if (result?.status !== 'success') {
    const detail = commandError(result)
    throw protectionError(detail.code, detail.message)
  }
  return result
}

export async function completePositionProtectionTarget(job, target, status, detail = {}) {
  const now = beijingNow()
  await queryRun(`UPDATE admin_position_protection_targets SET status = ?, attempt_count = attempt_count + 1,
    error_code = ?, error_message = ?, result_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [
    status, detail.code || null, textValue(detail.message).slice(0, 500) || null,
    detail.result ? JSON.stringify(detail.result) : null, now, now, Number(target.id),
  ])
  if (status === 'succeeded') {
    const stopLoss = numeric(detail.result?.stop_loss)
    const takeProfit = numeric(detail.result?.take_profit)
    await queryRun(`UPDATE signal_outcomes SET actual_stop_loss = ?, actual_take_profit = ?,
      authorized_stop_loss = ?, authorized_take_profit = ?, protection_revision = protection_revision + 1,
      protection_updated_by = ?, protection_updated_at = ?, protection_job_id = ?,
      protection_status = CASE WHEN ? > 0 THEN 'protected' ELSE protection_status END,
      protection_modified = CASE
        WHEN original_stop_loss IS NOT NULL AND ABS(COALESCE(?, 0) - original_stop_loss) > 0.00000001 THEN 1
        ELSE protection_modified END,
      updated_at = ?
      WHERE user_id = ? AND trading_account_id = ? AND status IN (?, ?)
        AND COALESCE(system_magic, ?) = ?
        AND (position_id = ? OR entry_order_ticket = ?)`, [
      stopLoss, takeProfit, stopLoss, takeProfit, Number(job.actor_user_id), now, Number(job.id),
      stopLoss, stopLoss, now, Number(target.user_id), Number(target.trading_account_id),
      ...OPEN_OUTCOME_STATUSES, SYSTEM_POSITION_MAGIC, SYSTEM_POSITION_MAGIC,
      textValue(target.ticket), textValue(target.ticket),
    ])
  }
  await refreshJobCounts(job.id)
  await publishJob(job.id, { id:Number(target.id), status, error_code:detail.code || null })
}

async function skipRemaining(jobId, code, message) {
  const now = beijingNow()
  await queryRun(`UPDATE admin_position_protection_targets SET status = 'skipped', error_code = ?,
    error_message = ?, completed_at = ?, updated_at = ?
    WHERE job_id = ? AND status = 'pending'`, [code, message, now, now, Number(jobId)])
}

export async function processPositionProtectionJob(job) {
  const targets = await queryAll(`SELECT * FROM admin_position_protection_targets
    WHERE job_id = ? AND status = 'pending' ORDER BY target_order, id`, [Number(job.id)])
  let sourceFailed = false
  for (const target of targets) {
    await queryRun(`UPDATE admin_position_protection_targets SET status = 'running', started_at = ?,
      updated_at = ? WHERE id = ? AND status = 'pending'`, [beijingNow(), beijingNow(), Number(target.id)])
    try {
      const result = await executePositionProtectionTarget(job, target)
      await completePositionProtectionTarget(job, target, 'succeeded', { result })
    } catch (error) {
      const code = textValue(error?.code || error?.message || 'position_protection_command_failed')
      await completePositionProtectionTarget(job, target, 'failed', { code, message:error?.publicMessage || error?.message || code })
      if (Number(target.is_source)) {
        sourceFailed = true
        await skipRemaining(job.id, 'source_position_update_failed', '发起持仓修改失败，未继续同步其他账户')
        break
      }
    }
  }
  const counts = await queryOne(`SELECT
      SUM(status = 'succeeded') AS succeeded, SUM(status = 'failed') AS failed,
      SUM(status = 'skipped') AS skipped FROM admin_position_protection_targets WHERE job_id = ?`, [Number(job.id)])
  const succeeded = Number(counts?.succeeded || 0)
  const failed = Number(counts?.failed || 0)
  const skipped = Number(counts?.skipped || 0)
  const finalStatus = sourceFailed || succeeded === 0 ? 'failed' : (failed > 0 || skipped > 0 ? 'partial_failed' : 'completed')
  await refreshJobCounts(job.id, finalStatus)
  await publishJob(job.id)
}

export async function runProtectionWorkerOnce() {
  if (workerRunning) return false
  workerRunning = true
  try {
    const job = await queryOne(`SELECT * FROM admin_position_protection_jobs
      WHERE status = 'queued' ORDER BY id LIMIT 1`)
    if (!job) return false
    const claimed = await queryRun(`UPDATE admin_position_protection_jobs
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status = 'queued'`, [beijingNow(), beijingNow(), Number(job.id)])
    if (!claimed.changes) return false
    await publishJob(Number(job.id))
    try {
      await processPositionProtectionJob({ ...job, status:'running' })
    } catch (error) {
      console.error(`[AdminPositionProtection] job ${job.id} failed:`, error)
      await queryRun(`UPDATE admin_position_protection_jobs SET status = 'failed',
        failed_positions = total_positions - succeeded_positions - skipped_positions,
        pending_positions = 0, completed_at = ?, updated_at = ? WHERE id = ?`,
      [beijingNow(), beijingNow(), Number(job.id)])
      await publishJob(Number(job.id))
    }
    return true
  } finally {
    workerRunning = false
  }
}

export async function retryPositionProtectionJob(jobId, actorUserId, body = {}, options = {}) {
  const job = await queryOne('SELECT * FROM admin_position_protection_jobs WHERE id = ? LIMIT 1', [Number(jobId)])
  if (!job) throw protectionError('position_protection_job_not_found')
  if (JOB_ACTIVE_STATUSES.includes(textValue(job.status))) throw protectionError('position_protection_job_active')
  if (Number(job.actor_user_id) !== Number(actorUserId)) throw protectionError('position_protection_retry_forbidden')
  const preview = await getPositionProtectionPreview(Number(job.source_user_id), job.source_ticket, {
    ...options,
    syncScope:job.sync_scope,
  })
  if (textValue(body.preview_hash) !== preview.preview_hash) throw protectionError('position_preview_changed')
  const storedTargets = await queryAll(`SELECT user_id, trading_account_id, ticket
    FROM admin_position_protection_targets WHERE job_id = ? ORDER BY target_order, id`, [Number(jobId)])
  const storedScope = storedTargets.map(targetKey).sort()
  const currentScope = preview.targets.map(targetKey).sort()
  if (stableHash(storedScope) !== stableHash(currentScope)) throw protectionError('position_retry_scope_changed')
  const source = await queryOne(`SELECT status FROM admin_position_protection_targets
    WHERE job_id = ? AND is_source = 1 LIMIT 1`, [Number(jobId)])
  const resetSource = source?.status !== 'succeeded'
  const now = beijingNow()
  await queryRun(`UPDATE admin_position_protection_targets
    SET expected_stop_loss = ?, expected_take_profit = ?, updated_at = ?
    WHERE job_id = ? AND is_source = 1`, [
    Number(preview.source.current_stop_loss || 0), Number(preview.source.current_take_profit || 0),
    now, Number(jobId),
  ])
  await queryRun(`UPDATE admin_position_protection_targets
    SET status = 'pending', error_code = NULL, error_message = NULL, result_json = NULL,
      started_at = NULL, completed_at = NULL, updated_at = ?
    WHERE job_id = ? AND (${resetSource ? '1 = 1' : "status IN ('failed','skipped','running')"})`, [now, Number(jobId)])
  await queryRun(`UPDATE admin_position_protection_jobs SET status = 'queued', preview_hash = ?, completed_at = NULL,
    pending_positions = total_positions - succeeded_positions, failed_positions = 0,
    skipped_positions = 0, updated_at = ? WHERE id = ?`, [preview.preview_hash, now, Number(jobId)])
  void runProtectionWorkerOnce()
  return getPositionProtectionJob(jobId)
}

export function startAdminPositionProtectionWorker() {
  if (workerTimer) return workerTimer
  const recoverStaleJobs = async () => {
    const now = beijingNow()
    await queryRun(`UPDATE admin_position_protection_targets targets
      JOIN admin_position_protection_jobs jobs ON jobs.id = targets.job_id
      SET targets.status = 'pending', targets.started_at = NULL, targets.updated_at = ?
      WHERE jobs.status = 'running' AND jobs.updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)
        AND targets.status = 'running'`, [now])
    await queryRun(`UPDATE admin_position_protection_jobs SET status = 'queued', updated_at = ?
      WHERE status = 'running' AND updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`, [now])
  }
  recoverStaleJobs().catch(error => console.error('[AdminPositionProtection] stale job recovery failed:', error.message))
  workerTimer = setInterval(() => {
    runProtectionWorkerOnce().catch(error => console.error('[AdminPositionProtection] worker failed:', error.message))
  }, WORKER_INTERVAL_MS)
  workerTimer.unref?.()
  void runProtectionWorkerOnce()
  return workerTimer
}

function sendRouteError(res, error) {
  const code = textValue(error?.code || error?.message || 'position_protection_failed')
  const status = code.includes('forbidden') ? 403
    : code.includes('not_found') ? 404
      : code.includes('active') || code.includes('changed') ? 409 : 400
  const messages = {
    position_ticket_required:'缺少持仓票号',
    system_position_not_found:'系统持仓不存在或已经平仓',
    position_not_system_owned:'该持仓不是系统下单，不能批量修改',
    source_inventory_unavailable:'无法读取当前 MT5 系统持仓',
    source_account_identity_unavailable:'当前 MT5 账户尚未完成平台身份绑定',
    source_signal_unavailable:'该持仓缺少唯一信号来源，只能修改当前持仓',
    multiple_source_signals:'该净持仓包含多个信号来源，不能批量同步',
    invalid_stop_loss:'止损价格必须大于 0',
    invalid_take_profit:'止盈价格必须大于 0',
    protection_price_required:'请至少填写一个新的止损或止盈价格',
    protection_price_unchanged:'止损和止盈均未发生变化',
    change_reason_required:'请填写 2 至 500 字的变更原因',
    position_preview_changed:'持仓或影响范围已经变化，请重新预览后再执行',
    position_retry_scope_changed:'本次任务的影响范围已经变化，请关闭后重新创建修改任务',
    position_protection_job_not_found:'修改任务不存在',
    position_protection_job_active:'任务仍在执行中，请勿重复提交',
    position_protection_retry_forbidden:'只能由创建任务的管理员重新核对并重试',
  }
  res.status(status).json({ ok:false, code, error:messages[code] || error?.publicMessage || '持仓保护价修改失败' })
}

router.get('/admin/ai/positions/:ticket/protection-preview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const preview = await getPositionProtectionPreview(req.user.id, req.params.ticket, {
      syncScope:req.query.sync_scope,
    })
    res.json({ ok:true, preview })
  } catch (error) { sendRouteError(res, error) }
})

router.post('/admin/ai/position-protection-jobs', authMiddleware, adminOnly, async (req, res) => {
  try {
    const ticket = textValue(req.body?.source_ticket)
    const job = await createPositionProtectionJob(req.user.id, ticket, req.body || {})
    await logAudit({
      userId:req.user.id,
      action:'admin_position_protection_job_created',
      targetType:'position_protection_job',
      targetId:job.id,
      detail:JSON.stringify({ ticket, sync_scope:job.sync_scope, reason:job.reason }),
      ip:req.ip,
      userAgent:req.headers['user-agent'],
    })
    res.status(202).json({ ok:true, job })
  } catch (error) { sendRouteError(res, error) }
})

router.get('/admin/ai/position-protection-jobs/:jobId', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, job:await getPositionProtectionJob(req.params.jobId) }) }
  catch (error) { sendRouteError(res, error) }
})

router.post('/admin/ai/position-protection-jobs/:jobId/retry-failed', authMiddleware, adminOnly, async (req, res) => {
  try {
    const job = await retryPositionProtectionJob(req.params.jobId, req.user.id, req.body || {})
    await logAudit({
      userId:req.user.id,
      action:'admin_position_protection_job_retried',
      targetType:'position_protection_job',
      targetId:job.id,
      detail:JSON.stringify({ preview_hash:textValue(req.body?.preview_hash) }),
      ip:req.ip,
      userAgent:req.headers['user-agent'],
    })
    res.status(202).json({ ok:true, job })
  }
  catch (error) { sendRouteError(res, error) }
})

export default router
