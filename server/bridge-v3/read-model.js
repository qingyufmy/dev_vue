import { queryRun, withTransaction } from '../db.js'
import { assertBridgeV3Message, sameBridgeRoute } from './protocol.js'
import { sha256Json, stableJson } from './command-ledger.js'

const SUPPORTED_READ_MODEL_STREAMS = new Set(['account', 'positions', 'orders', 'deals'])
const BATCH_SIZE = 250

function readModelError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeTerminalRow(row) {
  if (!row) return null
  return {
    ...row,
    user_id:Number(row.user_id),
    connection_epoch:Number(row.connection_epoch),
    connected:Number(row.connected),
  }
}

function terminalRoute(row) {
  return {
    terminal_instance_id:row.terminal_instance_id,
    account_ref:{ broker_server:row.broker_server, login:String(row.login_account) },
    connection_epoch:Number(row.connection_epoch),
  }
}

function itemTicket(item, stream) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw readModelError(`bridge_${stream}_item_invalid`)
  }
  const fallback = stream === 'positions' ? item.position_id
    : stream === 'orders' ? item.order_id
      : item.deal_ticket ?? item.deal
  const ticket = String(item.ticket ?? fallback ?? '').trim()
  if (!ticket || ticket.length > 64) throw readModelError(`bridge_${stream}_ticket_invalid`)
  return ticket
}

function chunks(items, size = BATCH_SIZE) {
  const result = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

async function replaceAccount(run, message) {
  if (message.deletes.length || message.upserts.length !== 1
    || !message.upserts[0] || typeof message.upserts[0] !== 'object' || Array.isArray(message.upserts[0])) {
    throw readModelError('bridge_account_delta_invalid')
  }
  await run(`INSERT INTO bridge_v3_account_latest
    (terminal_instance_id, connection_epoch, revision, observed_at_utc_msc, source_time_msc, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE connection_epoch = VALUES(connection_epoch), revision = VALUES(revision),
      observed_at_utc_msc = VALUES(observed_at_utc_msc), source_time_msc = VALUES(source_time_msc),
      payload_json = VALUES(payload_json)`, [
    message.terminal_instance_id, message.connection_epoch, message.revision,
    message.observed_at_utc_msc, message.source_time_msc, stableJson(message.upserts[0]),
  ])
}

async function applyCollection(run, message) {
  const table = message.stream === 'positions' ? 'bridge_v3_positions_latest' : 'bridge_v3_orders_latest'
  const upserts = message.upserts.map(item => ({ ticket:itemTicket(item, message.stream), payload:stableJson(item) }))
  const deletes = message.deletes.map(ticket => {
    const normalized = String(ticket).trim()
    if (!normalized || normalized.length > 64) throw readModelError(`bridge_${message.stream}_ticket_invalid`)
    return normalized
  })

  if (message.full_snapshot === true) {
    await run(`DELETE FROM ${table} WHERE terminal_instance_id = ?`, [message.terminal_instance_id])
  }
  for (const batch of chunks(upserts)) {
    if (!batch.length) continue
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')
    const params = batch.flatMap(item => [
      message.terminal_instance_id, item.ticket, message.connection_epoch, message.revision,
      message.observed_at_utc_msc, message.source_time_msc, item.payload,
    ])
    await run(`INSERT INTO ${table}
      (terminal_instance_id, ticket, connection_epoch, revision, observed_at_utc_msc, source_time_msc, payload_json)
      VALUES ${values}
      ON DUPLICATE KEY UPDATE connection_epoch = VALUES(connection_epoch), revision = VALUES(revision),
        observed_at_utc_msc = VALUES(observed_at_utc_msc), source_time_msc = VALUES(source_time_msc),
        payload_json = VALUES(payload_json)`, params)
  }
  for (const batch of chunks(deletes)) {
    if (!batch.length) continue
    await run(`DELETE FROM ${table}
      WHERE terminal_instance_id = ? AND ticket IN (${batch.map(() => '?').join(', ')})`,
    [message.terminal_instance_id, ...batch])
  }
}

function dealTimeMsc(item) {
  const milliseconds = Number(item?.time_msc || 0)
  if (Number.isSafeInteger(milliseconds) && milliseconds > 0) return milliseconds
  const seconds = Number(item?.time || 0)
  if (Number.isSafeInteger(seconds) && seconds > 0
    && Number.isSafeInteger(seconds * 1000)) return seconds * 1000
  throw readModelError('bridge_deals_time_invalid')
}

function optionalDealText(value, code, maxLength = 64, { allowEmpty = false } = {}) {
  if (value == null) return null
  const normalized = String(value).trim()
  if (!normalized && allowEmpty) return null
  if (!normalized || normalized.length > maxLength) throw readModelError(code)
  return normalized
}

async function applyDeals(run, message, userId) {
  if (message.deletes.length) throw readModelError('bridge_deals_delete_invalid')
  const deals = message.upserts.map(item => ({
    ticket:itemTicket(item, 'deals'),
    orderTicket:optionalDealText(item.order ?? item.order_ticket, 'bridge_deals_order_ticket_invalid'),
    positionId:optionalDealText(item.position_id, 'bridge_deals_position_id_invalid'),
    // Balance, credit and other account-history events legitimately have no
    // trading symbol. The database column is nullable, so preserve that
    // distinction instead of rejecting the entire immutable deals revision.
    symbol:optionalDealText(item.symbol, 'bridge_deals_symbol_invalid', 64, { allowEmpty:true }),
    timeMsc:dealTimeMsc(item),
    payload:stableJson(item),
  }))
  for (const batch of chunks(deals)) {
    if (!batch.length) continue
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const params = batch.flatMap(item => [
      message.terminal_instance_id, item.ticket, Number(userId), message.connection_epoch,
      item.orderTicket, item.positionId, item.symbol || null, item.timeMsc,
      message.observed_at_utc_msc, message.source_time_msc, item.payload,
    ])
    await run(`INSERT INTO bridge_v3_deals
      (terminal_instance_id, deal_ticket, user_id, connection_epoch, order_ticket, position_id,
       symbol, deal_time_msc, observed_at_utc_msc, source_time_msc, payload_json)
      VALUES ${values}
      ON DUPLICATE KEY UPDATE connection_epoch = VALUES(connection_epoch),
        order_ticket = VALUES(order_ticket), position_id = VALUES(position_id), symbol = VALUES(symbol),
        deal_time_msc = VALUES(deal_time_msc), observed_at_utc_msc = VALUES(observed_at_utc_msc),
        source_time_msc = VALUES(source_time_msc), payload_json = VALUES(payload_json)`, params)
  }
}

export async function registerBridgeTerminalSession({
  userId,
  sessionId,
  terminalInstanceId,
  platform,
  brokerServer,
  login,
  connectionEpoch,
  clientVersion = null,
  nowUtcMsc = Date.now(),
}, { transactionFn = withTransaction } = {}) {
  const normalized = {
    userId:Number(userId),
    sessionId:String(sessionId || '').trim(),
    terminalInstanceId:String(terminalInstanceId || '').trim(),
    platform:String(platform || '').trim().toLowerCase(),
    brokerServer:String(brokerServer || '').trim(),
    login:String(login || '').trim(),
    connectionEpoch:Number(connectionEpoch),
    clientVersion:clientVersion == null ? null : String(clientVersion).trim(),
  }
  if (!Number.isSafeInteger(normalized.userId) || normalized.userId <= 0) throw readModelError('bridge_terminal_user_invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized.sessionId)) throw readModelError('bridge_session_id_invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized.terminalInstanceId)) throw readModelError('bridge_terminal_id_invalid')
  if (!['mt4', 'mt5'].includes(normalized.platform)) throw readModelError('bridge_platform_invalid')
  if (!normalized.brokerServer || !normalized.login) throw readModelError('bridge_account_ref_invalid')
  if (!Number.isSafeInteger(normalized.connectionEpoch) || normalized.connectionEpoch <= 0) throw readModelError('bridge_connection_epoch_invalid')

  return transactionFn(async run => {
    const [rows] = await run(
      'SELECT * FROM bridge_v3_terminal_sessions WHERE terminal_instance_id = ? LIMIT 1 FOR UPDATE',
      [normalized.terminalInstanceId]
    )
    const existing = normalizeTerminalRow(rows?.[0])
    if (existing) {
      const routeMatch = String(existing.platform) === normalized.platform
        && String(existing.broker_server).toLowerCase() === normalized.brokerServer.toLowerCase()
        && String(existing.login_account) === normalized.login
      if (!routeMatch) throw readModelError('bridge_terminal_binding_mismatch')
      if (existing.user_id !== normalized.userId
        && (existing.connected || normalized.connectionEpoch <= existing.connection_epoch)) {
        throw readModelError('bridge_terminal_binding_mismatch')
      }
      if (normalized.connectionEpoch < existing.connection_epoch) throw readModelError('bridge_connection_epoch_stale')
    }

    await run(`INSERT INTO bridge_v3_terminal_sessions
      (terminal_instance_id, user_id, platform, broker_server, login_account, connection_epoch,
       session_id, client_version, connected, last_seen_at_utc_msc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), connection_epoch = VALUES(connection_epoch),
        session_id = VALUES(session_id),
        client_version = VALUES(client_version), connected = 1,
        last_seen_at_utc_msc = VALUES(last_seen_at_utc_msc)`, [
      normalized.terminalInstanceId, normalized.userId, normalized.platform, normalized.brokerServer,
      normalized.login, normalized.connectionEpoch, normalized.sessionId, normalized.clientVersion, nowUtcMsc,
    ])
    return { ...normalized, connected:true, lastSeenAtUtcMsc:nowUtcMsc,
      resumed:Boolean(existing && existing.user_id === normalized.userId
        && normalized.connectionEpoch === existing.connection_epoch),
      rebound:Boolean(existing && existing.user_id !== normalized.userId) }
  })
}

export async function applyBridgeDataDelta(message, {
  userId,
  nowUtcMsc = Date.now(),
  transactionFn = withTransaction,
} = {}) {
  assertBridgeV3Message(message, { nowUtcMsc })
  if (message.type !== 'data_delta') throw readModelError('bridge_data_type_invalid')
  if (!SUPPORTED_READ_MODEL_STREAMS.has(message.stream)) throw readModelError('bridge_data_stream_not_implemented')

  return transactionFn(async run => {
    const [terminalRows] = await run(
      'SELECT * FROM bridge_v3_terminal_sessions WHERE terminal_instance_id = ? LIMIT 1 FOR UPDATE',
      [message.terminal_instance_id]
    )
    const terminal = normalizeTerminalRow(terminalRows?.[0])
    if (!terminal || terminal.connected !== 1) throw readModelError('bridge_terminal_session_inactive')
    if (terminal.user_id !== Number(userId) || !sameBridgeRoute(terminalRoute(terminal), message)) {
      throw readModelError('bridge_data_route_mismatch')
    }

    const [revisionRows] = await run(`SELECT * FROM bridge_v3_stream_revisions
      WHERE terminal_instance_id = ? AND connection_epoch = ? AND stream = ? LIMIT 1 FOR UPDATE`,
    [message.terminal_instance_id, message.connection_epoch, message.stream])
    const current = revisionRows?.[0] || null
    const currentRevision = Number(current?.revision || 0)
    const payloadHash = sha256Json(message)

    if (message.revision === currentRevision) {
      if (String(current?.payload_hash || '') !== payloadHash) throw readModelError('bridge_data_revision_conflict')
      return { status:'duplicate', stream:message.stream, revision:currentRevision, expected_revision:currentRevision + 1 }
    }
    if (message.revision < currentRevision) {
      return { status:'gap', stream:message.stream, revision:message.revision, expected_revision:currentRevision + 1 }
    }
    if (message.full_snapshot !== true && message.base_revision !== currentRevision) {
      return { status:'gap', stream:message.stream, revision:message.revision, expected_revision:currentRevision + 1 }
    }

    if (message.stream === 'account') await replaceAccount(run, message)
    else if (message.stream === 'deals') await applyDeals(run, message, userId)
    else await applyCollection(run, message)

    await run(`INSERT INTO bridge_v3_stream_revisions
      (terminal_instance_id, connection_epoch, stream, revision, message_id, payload_hash,
       observed_at_utc_msc, source_time_msc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE revision = VALUES(revision), message_id = VALUES(message_id),
        payload_hash = VALUES(payload_hash), observed_at_utc_msc = VALUES(observed_at_utc_msc),
        source_time_msc = VALUES(source_time_msc)`, [
      message.terminal_instance_id, message.connection_epoch, message.stream, message.revision,
      message.message_id, payloadHash, message.observed_at_utc_msc, message.source_time_msc,
    ])
    await run(`UPDATE bridge_v3_terminal_sessions SET last_seen_at_utc_msc = ?
      WHERE terminal_instance_id = ? AND connection_epoch = ?`,
    [nowUtcMsc, message.terminal_instance_id, message.connection_epoch])
    return { status:'applied', stream:message.stream, revision:message.revision,
      expected_revision:message.revision + 1 }
  })
}

export async function disconnectBridgeTerminalSessions(sessionId, userId, {
  nowUtcMsc = Date.now(),
  queryRunFn = queryRun,
} = {}) {
  return queryRunFn(`UPDATE bridge_v3_terminal_sessions
    SET connected = 0, last_seen_at_utc_msc = ?
    WHERE session_id = ? AND user_id = ? AND connected = 1`,
  [nowUtcMsc, sessionId, Number(userId)])
}
