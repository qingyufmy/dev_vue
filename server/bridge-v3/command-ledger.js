import { createHash } from 'node:crypto'

import { queryOne, queryRun, withTransaction } from '../db.js'
import { assertBridgeV3Message, sameBridgeRoute } from './protocol.js'

export const BRIDGE_COMMAND_STATUSES = Object.freeze(new Set([
  'queued', 'dispatched', 'succeeded', 'rejected', 'failed', 'uncertain', 'expired',
]))

const FINAL_RESULTS = new Set(['succeeded', 'rejected', 'failed'])

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

export function commandPayloadHash(command, userId) {
  return sha256Json({
    user_id:Number(userId),
    command_id:command.command_id,
    terminal_instance_id:command.terminal_instance_id,
    account_ref:command.account_ref,
    connection_epoch:command.connection_epoch,
    issued_at_utc_msc:command.issued_at_utc_msc,
    deadline_utc_msc:command.deadline_utc_msc,
    action:command.action,
    params:command.params,
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
    params:parseJson(row.params_json) || {},
    result:parseJson(row.result_json),
  }
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
  queryOneFn = queryOne,
  queryRunFn = queryRun,
} = {}) {
  assertBridgeV3Message(command, { nowUtcMsc })
  if (command.type !== 'command') throw ledgerError('bridge_command_type_invalid')
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) throw ledgerError('bridge_command_user_invalid')

  const payloadHash = commandPayloadHash(command, userId)
  const paramsJson = stableJson(command.params)
  const inserted = await queryRunFn(
    `INSERT IGNORE INTO bridge_v3_command_ledger
      (command_id, user_id, terminal_instance_id, broker_server, login_account,
       connection_epoch, action, params_json, payload_hash, status, deadline_at_utc_msc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    [
      command.command_id, Number(userId), command.terminal_instance_id,
      command.account_ref.broker_server.trim(), String(command.account_ref.login).trim(),
      command.connection_epoch, command.action, paramsJson, payloadHash, command.deadline_utc_msc,
    ]
  )
  const row = normalizeCommandLedgerRow(await queryOneFn(
    'SELECT * FROM bridge_v3_command_ledger WHERE command_id = ? LIMIT 1',
    [command.command_id]
  ))
  if (!row) throw ledgerError('bridge_command_persist_failed')
  if (row.payload_hash !== payloadHash) throw ledgerError('bridge_command_id_conflict')
  return { created:Number(inserted?.changes || 0) === 1, command:row }
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
    if (row.status === 'uncertain' && !(allowUncertainResolution && FINAL_RESULTS.has(message.status))) {
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
      row.status === 'uncertain' ? 'reconciled' : 'result_received', row.status, message.status,
      { result_hash:resultHash, received_at_utc_msc:nowUtcMsc })
    return { command:{ ...row, status:message.status, completed_at_utc_msc:message.completed_at_utc_msc,
      result_status:message.status, result:message, result_hash:resultHash }, duplicate:false }
  })
}

export async function expireQueuedCommands({
  nowUtcMsc = Date.now(),
  queryRunFn = queryRun,
} = {}) {
  return queryRunFn(`UPDATE bridge_v3_command_ledger
    SET status = 'expired', completed_at_utc_msc = ?, error_code = 'command_expired'
    WHERE status = 'queued' AND deadline_at_utc_msc <= ?`, [nowUtcMsc, nowUtcMsc])
}

export async function getCommandLedgerEntry(commandId, { queryOneFn = queryOne } = {}) {
  return normalizeCommandLedgerRow(await queryOneFn(
    'SELECT * FROM bridge_v3_command_ledger WHERE command_id = ? LIMIT 1',
    [commandId]
  ))
}
