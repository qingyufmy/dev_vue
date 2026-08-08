import { createHash } from 'node:crypto'

import { queryOne, withTransaction } from '../db.js'
import { assertBridgeV3Message, sameBridgeRoute } from './protocol.js'

export const BRIDGE_COMMAND_STATUSES = Object.freeze(new Set([
  'queued', 'dispatched', 'succeeded', 'rejected', 'failed', 'uncertain', 'expired',
]))

const FINAL_RESULTS = new Set(['succeeded', 'rejected', 'failed'])
export const BRIDGE_COMMAND_HISTORY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

export function sha256Json(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function normalizedBusinessIdentity(command, userId) {
  return {
    user_id:Number(userId),
    command_id:command.command_id,
    terminal_instance_id:String(command.terminal_instance_id || '').trim(),
    account_ref:{
      broker_server:String(command.account_ref?.broker_server || '').trim().toLowerCase(),
      login:String(command.account_ref?.login || '').trim(),
    },
    action:String(command.action || '').trim(),
    params:command.params,
  }
}

/** Hash only the durable business operation; transport envelope fields are excluded. */
export function commandBusinessPayloadHash(command, userId) {
  return sha256Json(normalizedBusinessIdentity(command, userId))
}

/** Backward-compatible public name. New rows store this business hash. */
export function commandPayloadHash(command, userId) {
  return commandBusinessPayloadHash(command, userId)
}

export function commandEnvelopeHash(command) {
  return sha256Json({
    connection_epoch:Number(command.connection_epoch),
    issued_at_utc_msc:Number(command.issued_at_utc_msc),
    deadline_utc_msc:Number(command.deadline_utc_msc),
  })
}

function ledgerError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function parseJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

export function normalizeCommandLedgerRow(row) {
  if (!row) return null
  return {
    ...row,
    user_id:Number(row.user_id),
    connection_epoch:Number(row.connection_epoch),
    deadline_at_utc_msc:Number(row.deadline_at_utc_msc),
    dispatch_attempt_count:Number(row.dispatch_attempt_count || 0),
    last_dispatched_at_utc_msc:row.last_dispatched_at_utc_msc == null ? null : Number(row.last_dispatched_at_utc_msc),
    completed_at_utc_msc:row.completed_at_utc_msc == null ? null : Number(row.completed_at_utc_msc),
    payload_hash:row.payload_hash || null,
    envelope_hash:row.envelope_hash || null,
    params:parseJson(row.params_json) || {},
    result:parseJson(row.result_json),
  }
}

function rowBusinessIdentity(row) {
  return {
    user_id:Number(row.user_id),
    command_id:row.command_id,
    terminal_instance_id:String(row.terminal_instance_id || '').trim(),
    account_ref:{
      broker_server:String(row.broker_server || '').trim().toLowerCase(),
      login:String(row.login_account || '').trim(),
    },
    action:String(row.action || '').trim(),
    params:parseJson(row.params_json),
  }
}

function sameBusinessPayload(row, command, userId) {
  const identity = rowBusinessIdentity(row)
  if (identity.params == null) return false
  return sha256Json(identity) === commandBusinessPayloadHash(command, userId)
}

function hasDispatchEvidence(row) {
  return Number(row.dispatch_attempt_count || 0) > 0
    || ['dispatched', 'uncertain', 'succeeded', 'rejected', 'failed'].includes(String(row.status || ''))
    || row.result_hash != null || row.result_json != null || row.result_status != null
}

function rowRoute(row) {
  return {
    terminal_instance_id:row.terminal_instance_id,
    account_ref:{ broker_server:row.broker_server, login:String(row.login_account) },
    connection_epoch:Number(row.connection_epoch),
  }
}

async function appendEvent(run, commandId, eventType, fromStatus, toStatus, detail = null) {
  await run(
    `INSERT INTO bridge_v3_command_events
      (command_id, event_type, from_status, to_status, detail_json)
     VALUES (?, ?, ?, ?, ?)`,
    [commandId, eventType, fromStatus, toStatus, detail == null ? null : stableJson(detail)]
  )
}

export async function createCommandLedgerEntry(command, {
  userId,
  nowUtcMsc = Date.now(),
  transactionFn = withTransaction,
} = {}) {
  assertBridgeV3Message(command, { nowUtcMsc })
  if (command.type !== 'command') throw ledgerError('bridge_command_type_invalid')
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) throw ledgerError('bridge_command_user_invalid')

  const businessPayloadHash = commandBusinessPayloadHash(command, userId)
  const envelopeHash = commandEnvelopeHash(command)
  const paramsJson = stableJson(command.params)
  return transactionFn(async run => {
    // Acquire the command-id uniqueness lock in the same transaction as the
    // row read. A no-op duplicate update keeps concurrent first requests from
    // racing between SELECT and INSERT without overwriting business fields.
    const [inserted] = await run(`INSERT INTO bridge_v3_command_ledger
        (command_id, user_id, terminal_instance_id, broker_server, login_account,
         connection_epoch, action, params_json, payload_hash, envelope_hash,
         status, deadline_at_utc_msc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
        ON DUPLICATE KEY UPDATE command_id = command_id`, [
        command.command_id, Number(userId), command.terminal_instance_id,
        command.account_ref.broker_server.trim(), String(command.account_ref.login).trim(),
        command.connection_epoch, command.action, paramsJson, businessPayloadHash,
        envelopeHash, command.deadline_utc_msc,
      ])
    const [rows] = await run(
      'SELECT * FROM bridge_v3_command_ledger WHERE command_id = ? LIMIT 1 FOR UPDATE',
      [command.command_id]
    )
    let row = normalizeCommandLedgerRow(rows?.[0])
    if (!row) throw ledgerError('bridge_command_persist_failed')

    const created = Number(inserted?.affectedRows ?? inserted?.changes ?? 0) === 1
    if (created) {
      await appendEvent(run, command.command_id, 'queued', null, 'queued', {
        payload_hash:businessPayloadHash, envelope_hash:envelopeHash,
      })
      return { created:true, command:row }
    }

    if (!sameBusinessPayload(row, command, userId)) throw ledgerError('bridge_command_id_conflict')

    const [evidenceEvents] = await run(`SELECT event_type FROM bridge_v3_command_events
      WHERE command_id = ? AND event_type IN
        ('dispatched', 'delivery_uncertain', 'result_received', 'reconciled')
      ORDER BY id DESC LIMIT 1 FOR UPDATE`, [command.command_id])
    const eventShowsDispatch = (evidenceEvents || []).some(event => Boolean(event?.event_type))
    if (eventShowsDispatch && ['queued', 'expired'].includes(String(row.status || ''))) {
      throw ledgerError('bridge_command_reconciliation_required')
    }

    if (['queued', 'expired'].includes(String(row.status || '')) && hasDispatchEvidence(row)) {
      throw ledgerError('bridge_command_reconciliation_required')
    }

    if (['queued', 'expired'].includes(String(row.status || ''))) {
      const wasExpired = row.status === 'expired'
      await run(`UPDATE bridge_v3_command_ledger
        SET connection_epoch = ?, deadline_at_utc_msc = ?, envelope_hash = ?,
            payload_hash = ?, status = 'queued', completed_at_utc_msc = NULL,
            result_status = NULL, result_json = NULL, result_hash = NULL,
            error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP(3)
        WHERE command_id = ? AND status IN ('queued', 'expired')
          AND dispatch_attempt_count = 0 AND result_hash IS NULL`, [
        command.connection_epoch, command.deadline_utc_msc, envelopeHash,
        businessPayloadHash, command.command_id,
      ])
      await appendEvent(run, command.command_id, 'resumed', row.status, 'queued', {
        previous_status:row.status, resumed_from_expired:wasExpired,
        connection_epoch:command.connection_epoch, deadline_utc_msc:command.deadline_utc_msc,
        payload_hash:businessPayloadHash,
        envelope_hash:envelopeHash,
      })
      const [resumedRows] = await run(
        'SELECT * FROM bridge_v3_command_ledger WHERE command_id = ? LIMIT 1 FOR UPDATE',
        [command.command_id]
      )
      row = normalizeCommandLedgerRow(resumedRows?.[0])
      if (!row) throw ledgerError('bridge_command_persist_failed')
      return { created:false, resumed:true, command:row }
    }
    return { created:false, command:row }
  })
}

export async function markCommandDispatched(commandId, {
  connectionEpoch,
  allowRedispatch = false,
  nowUtcMsc = Date.now(),
  queryOneFn = queryOne,
  transactionFn = withTransaction,
} = {}) {
  return transactionFn(async run => {
    const [rows] = await run(
      'SELECT * FROM bridge_v3_command_ledger WHERE command_id = ? LIMIT 1 FOR UPDATE',
      [commandId]
    )
    const row = normalizeCommandLedgerRow(rows?.[0])
    if (!row) throw ledgerError('bridge_command_not_found')
    if (row.connection_epoch !== Number(connectionEpoch)) throw ledgerError('bridge_command_epoch_mismatch')
    if (row.deadline_at_utc_msc <= nowUtcMsc) {
      if (row.status === 'queued') {
        await run(`UPDATE bridge_v3_command_ledger
          SET status = 'expired', completed_at_utc_msc = ?, error_code = 'command_expired'
          WHERE command_id = ? AND status = 'queued'`, [nowUtcMsc, commandId])
        await appendEvent(run, commandId, 'expired', 'queued', 'expired', { now_utc_msc:nowUtcMsc })
      }
      throw ledgerError('bridge_command_expired')
    }
    if (row.status === 'dispatched' && !allowRedispatch) {
      throw ledgerError('bridge_command_reconciliation_required')
    }
    if (!['queued', 'dispatched'].includes(row.status)) throw ledgerError('bridge_command_not_dispatchable')

    await run(`UPDATE bridge_v3_command_ledger
      SET status = 'dispatched', dispatch_attempt_count = dispatch_attempt_count + 1,
          last_dispatched_at_utc_msc = ?
      WHERE command_id = ?`, [nowUtcMsc, commandId])
    await appendEvent(run, commandId, 'dispatched', row.status, 'dispatched', {
      attempt:row.dispatch_attempt_count + 1,
      connection_epoch:row.connection_epoch,
    })
    return { ...row, status:'dispatched', dispatch_attempt_count:row.dispatch_attempt_count + 1,
      last_dispatched_at_utc_msc:nowUtcMsc }
  })
}

export async function markCommandDeliveryUncertain(commandId, {
  reason = 'bridge_result_timeout',
  nowUtcMsc = Date.now(),
  transactionFn = withTransaction,
} = {}) {
  return transactionFn(async run => {
    const [rows] = await run(
      'SELECT * FROM bridge_v3_command_ledger WHERE command_id = ? LIMIT 1 FOR UPDATE',
      [commandId]
    )
    const row = normalizeCommandLedgerRow(rows?.[0])
    if (!row) throw ledgerError('bridge_command_not_found')
    if (row.status === 'uncertain') return { command:row, duplicate:true }
    if (FINAL_RESULTS.has(row.status)) return { command:row, duplicate:true }
    if (row.status !== 'dispatched') throw ledgerError('bridge_command_not_in_flight')

    await run(`UPDATE bridge_v3_command_ledger
      SET status = 'uncertain', completed_at_utc_msc = ?, result_status = 'uncertain', error_code = ?
      WHERE command_id = ? AND status = 'dispatched'`, [nowUtcMsc, reason, commandId])
    await appendEvent(run, commandId, 'delivery_uncertain', 'dispatched', 'uncertain', { reason })
    return { command:{ ...row, status:'uncertain', result_status:'uncertain',
      completed_at_utc_msc:nowUtcMsc, error_code:reason }, duplicate:false }
  })
}

export async function recordCommandResult(message, {
  allowUncertainResolution = false,
  nowUtcMsc = Date.now(),
  transactionFn = withTransaction,
} = {}) {
  assertBridgeV3Message(message, { nowUtcMsc })
  if (message.type !== 'command_result') throw ledgerError('bridge_result_type_invalid')
  const resultJson = stableJson(message)
  const resultHash = sha256Json(message)

  return transactionFn(async run => {
    const [rows] = await run(
      'SELECT * FROM bridge_v3_command_ledger WHERE command_id = ? LIMIT 1 FOR UPDATE',
      [message.command_id]
    )
    const row = normalizeCommandLedgerRow(rows?.[0])
    if (!row) throw ledgerError('bridge_command_not_found')
    if (!sameBridgeRoute(rowRoute(row), message)) throw ledgerError('bridge_command_route_mismatch')

    if (row.result_hash) {
      if (row.result_hash === resultHash) return { command:row, duplicate:true }
      if (!(row.status === 'uncertain' && allowUncertainResolution && FINAL_RESULTS.has(message.status))) {
        throw ledgerError('bridge_command_result_conflict')
      }
    }
    const resolvesUncertain = row.status === 'uncertain'
      && allowUncertainResolution && FINAL_RESULTS.has(message.status)
    const recordsUncertainEvidence = row.status === 'uncertain'
      && message.status === 'uncertain' && !row.result_hash
    if (row.status === 'uncertain' && !resolvesUncertain && !recordsUncertainEvidence) {
      throw ledgerError('bridge_command_reconciliation_required')
    }
    if (row.status !== 'dispatched' && row.status !== 'uncertain') {
      throw ledgerError('bridge_command_result_unexpected')
    }

    await run(`UPDATE bridge_v3_command_ledger
      SET status = ?, completed_at_utc_msc = ?, result_status = ?, result_json = ?, result_hash = ?,
          error_code = ?, error_message = ?
      WHERE command_id = ?`, [
      message.status, message.completed_at_utc_msc, message.status, resultJson, resultHash,
      message.error_code || null, message.error_message || null, message.command_id,
    ])
    await appendEvent(run, message.command_id,
      resolvesUncertain ? 'reconciled' : 'result_received', row.status, message.status,
      { result_hash:resultHash, received_at_utc_msc:nowUtcMsc })
    return { command:{ ...row, status:message.status, completed_at_utc_msc:message.completed_at_utc_msc,
      result_status:message.status, result:message, result_hash:resultHash }, duplicate:false }
  })
}

export async function expireQueuedCommands({
  nowUtcMsc = Date.now(),
  limit = 100,
  transactionFn = withTransaction,
} = {}) {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100
  return transactionFn(async run => {
    const [rows] = await run(`SELECT command_id FROM bridge_v3_command_ledger
      WHERE status = 'queued' AND deadline_at_utc_msc <= ?
      ORDER BY deadline_at_utc_msc, command_id LIMIT ? FOR UPDATE`, [nowUtcMsc, safeLimit])
    let changes = 0
    for (const row of rows || []) {
      const [updated] = await run(`UPDATE bridge_v3_command_ledger
        SET status = 'expired', completed_at_utc_msc = ?, error_code = 'command_expired'
        WHERE command_id = ? AND status = 'queued' AND deadline_at_utc_msc <= ?`,
      [nowUtcMsc, row.command_id, nowUtcMsc])
      if (Number(updated?.affectedRows || 0) !== 1) continue
      await appendEvent(run, row.command_id, 'expired', 'queued', 'expired', {
        now_utc_msc:nowUtcMsc, source:'maintenance_expiry_sweep',
      })
      changes += 1
    }
    return { changes }
  })
}

export async function pruneFinalizedCommands({
  nowUtcMsc = Date.now(),
  retentionMs = BRIDGE_COMMAND_HISTORY_RETENTION_MS,
  limit = 500,
  transactionFn = withTransaction,
} = {}) {
  const safeRetentionMs = Number.isSafeInteger(retentionMs) && retentionMs >= 30 * 24 * 60 * 60 * 1000
    ? retentionMs : BRIDGE_COMMAND_HISTORY_RETENTION_MS
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 2_000) : 500
  const cutoffUtcMsc = nowUtcMsc - safeRetentionMs
  return transactionFn(async run => {
    const [rows] = await run(`SELECT command_id FROM bridge_v3_command_ledger
      WHERE completed_at_utc_msc IS NOT NULL AND completed_at_utc_msc <= ?
        AND (status IN ('succeeded', 'rejected', 'failed')
          OR (status = 'expired' AND dispatch_attempt_count = 0 AND result_hash IS NULL))
      ORDER BY completed_at_utc_msc, command_id LIMIT ? FOR UPDATE`, [cutoffUtcMsc, safeLimit])
    const commandIds = (rows || []).map(row => String(row.command_id || '')).filter(Boolean)
    if (commandIds.length === 0) return { changes:0 }

    const placeholders = commandIds.map(() => '?').join(', ')
    await run(`DELETE FROM bridge_v3_command_events
      WHERE command_id IN (${placeholders})`, commandIds)
    const [deleted] = await run(`DELETE FROM bridge_v3_command_ledger
      WHERE command_id IN (${placeholders})
        AND completed_at_utc_msc <= ?
        AND (status IN ('succeeded', 'rejected', 'failed')
          OR (status = 'expired' AND dispatch_attempt_count = 0 AND result_hash IS NULL))`,
    [...commandIds, cutoffUtcMsc])
    return { changes:Number(deleted?.affectedRows || deleted?.changes || 0) }
  })
}

export async function getCommandLedgerEntry(commandId, { queryOneFn = queryOne } = {}) {
  return normalizeCommandLedgerRow(await queryOneFn(
    'SELECT * FROM bridge_v3_command_ledger WHERE command_id = ? LIMIT 1',
    [commandId]
  ))
}

export async function countOutstandingCommands(terminalInstanceIds, {
  queryOneFn = queryOne,
  nowUtcMsc = Date.now(),
} = {}) {
  if (!Array.isArray(terminalInstanceIds) || terminalInstanceIds.length < 1
    || terminalInstanceIds.length > 64
    || new Set(terminalInstanceIds).size !== terminalInstanceIds.length
    || terminalInstanceIds.some(value => typeof value !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value))) {
    throw ledgerError('bridge_maintenance_terminal_scope_invalid')
  }
  const row = await queryOneFn(
    `SELECT COUNT(*) AS count FROM bridge_v3_command_ledger
      WHERE terminal_instance_id IN (${terminalInstanceIds.map(() => '?').join(', ')})
        AND (status = 'dispatched' OR (status = 'queued' AND deadline_at_utc_msc > ?))`,
    [...terminalInstanceIds, nowUtcMsc],
  )
  return Number(row?.count || 0)
}
