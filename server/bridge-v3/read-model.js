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

function normalizeUpdateReport(value, nowUtcMsc) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw readModelError('bridge_update_report_invalid')
  }
  const report = {
    release_id:String(value.release_id || '').trim(),
    target_version:String(value.target_version || '').trim(),
    state:String(value.state || '').trim(),
    started_at_utc_msc:value.started_at_utc_msc == null ? null : Number(value.started_at_utc_msc),
    updated_at_utc_msc:Number(value.updated_at_utc_msc),
    error_code:value.error_code == null ? null : String(value.error_code).trim(),
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(report.release_id)
    || !/^\d+\.\d+(?:\.\d+){0,2}$/.test(report.target_version)
    || !['healthy', 'rolled_back', 'failed'].includes(report.state)
    || report.started_at_utc_msc != null
      && (!Number.isSafeInteger(report.started_at_utc_msc) || report.started_at_utc_msc <= 0)
    || !Number.isSafeInteger(report.updated_at_utc_msc) || report.updated_at_utc_msc <= 0
    || report.updated_at_utc_msc > nowUtcMsc + 10 * 60 * 1000
    || report.started_at_utc_msc != null && report.updated_at_utc_msc < report.started_at_utc_msc
    || report.error_code != null && !/^[A-Za-z0-9_]{1,128}$/.test(report.error_code)
    || report.state === 'failed' && !report.error_code) {
    throw readModelError('bridge_update_report_invalid')
  }
  return report
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
  const milliseconds = Number(item?.time_utc_msc ?? item?.time_msc ?? 0)
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

async function clearTerminalReadModel(run, terminalInstanceId) {
  for (const table of [
    'bridge_v3_stream_revisions',
    'bridge_v3_account_latest',
    'bridge_v3_positions_latest',
    'bridge_v3_orders_latest',
    'bridge_v3_deals',
  ]) {
    await run(`DELETE FROM ${table} WHERE terminal_instance_id = ?`, [terminalInstanceId])
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
  bridgeVersion = null,
  installationId = null,
  updateReport = null,
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
    bridgeVersion:bridgeVersion == null ? null : String(bridgeVersion).trim(),
    installationId:installationId == null ? null : String(installationId).trim(),
    updateReport:normalizeUpdateReport(updateReport, nowUtcMsc),
  }
  if (!Number.isSafeInteger(normalized.userId) || normalized.userId <= 0) throw readModelError('bridge_terminal_user_invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized.sessionId)) throw readModelError('bridge_session_id_invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized.terminalInstanceId)) throw readModelError('bridge_terminal_id_invalid')
  if (!['mt4', 'mt5'].includes(normalized.platform)) throw readModelError('bridge_platform_invalid')
  if (!normalized.brokerServer || !normalized.login) throw readModelError('bridge_account_ref_invalid')
  if (!Number.isSafeInteger(normalized.connectionEpoch) || normalized.connectionEpoch <= 0) throw readModelError('bridge_connection_epoch_invalid')
  if (normalized.clientVersion && normalized.clientVersion.length > 64) throw readModelError('bridge_client_version_invalid')
  if (normalized.bridgeVersion && normalized.bridgeVersion.length > 64) throw readModelError('bridge_version_invalid')
  if (normalized.installationId && !/^install_[a-f0-9]{32}$/.test(normalized.installationId)) {
    throw readModelError('bridge_installation_id_invalid')
  }
  if (normalized.updateReport && !normalized.installationId) throw readModelError('bridge_update_installation_required')

  return transactionFn(async run => {
    const [rows] = await run(
      'SELECT * FROM bridge_v3_terminal_sessions WHERE terminal_instance_id = ? LIMIT 1 FOR UPDATE',
      [normalized.terminalInstanceId]
    )
    const existing = normalizeTerminalRow(rows?.[0])
    const sameUser = Boolean(existing && existing.user_id === normalized.userId)
    const routeMatch = Boolean(existing
      && String(existing.platform) === normalized.platform
      && String(existing.broker_server).toLowerCase() === normalized.brokerServer.toLowerCase()
      && String(existing.login_account) === normalized.login)
    const routeChanged = Boolean(existing && !routeMatch)
    const accountRebound = Boolean(existing && sameUser && routeChanged)
    const ownerRebound = Boolean(existing && !sameUser)
    const previousRoute = existing ? {
      userId:existing.user_id,
      platform:String(existing.platform || '').trim().toLowerCase(),
      brokerServer:String(existing.broker_server || '').trim(),
      login:String(existing.login_account || '').trim(),
      connectionEpoch:Number(existing.connection_epoch),
    } : null
    if (existing) {
      if (accountRebound) {
        if (String(existing.platform) !== normalized.platform) {
          throw readModelError('bridge_terminal_binding_mismatch')
        }
        if (normalized.connectionEpoch <= existing.connection_epoch) {
          throw readModelError('bridge_connection_epoch_stale')
        }
      } else if (ownerRebound) {
        // A different user may only reclaim a disconnected terminal while
        // preserving its platform/account route. Their isolated profile may
        // have an unrelated (and lower) epoch counter.
        if (!routeMatch || existing.connected) {
          throw readModelError('bridge_terminal_binding_mismatch')
        }
      } else if (normalized.connectionEpoch < existing.connection_epoch) {
        throw readModelError('bridge_connection_epoch_stale')
      }
    }
    if (accountRebound || ownerRebound) {
      // The terminal ID is installation-scoped rather than account-scoped, so
      // every account-dependent V3 projection must be rebuilt for the new
      // route before it can be read or used for trading.
      await clearTerminalReadModel(run, normalized.terminalInstanceId)
    }

    await run(`INSERT INTO bridge_v3_terminal_sessions
      (terminal_instance_id, user_id, platform, broker_server, login_account, connection_epoch,
       session_id, client_version, bridge_version, installation_id, update_release_id, update_target_version,
       update_state, update_started_at_utc_msc, update_reported_at_utc_msc, update_error_code,
       connected, last_seen_at_utc_msc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform),
        broker_server = VALUES(broker_server), login_account = VALUES(login_account),
        connection_epoch = VALUES(connection_epoch),
        session_id = VALUES(session_id),
        client_version = VALUES(client_version), bridge_version = VALUES(bridge_version),
        installation_id = VALUES(installation_id),
        update_release_id = VALUES(update_release_id), update_target_version = VALUES(update_target_version),
        update_state = VALUES(update_state), update_started_at_utc_msc = VALUES(update_started_at_utc_msc),
        update_reported_at_utc_msc = VALUES(update_reported_at_utc_msc),
        update_error_code = VALUES(update_error_code), connected = 1,
        last_seen_at_utc_msc = VALUES(last_seen_at_utc_msc)`, [
      normalized.terminalInstanceId, normalized.userId, normalized.platform, normalized.brokerServer,
      normalized.login, normalized.connectionEpoch, normalized.sessionId, normalized.clientVersion,
      normalized.bridgeVersion, normalized.installationId, normalized.updateReport?.release_id || null,
      normalized.updateReport?.target_version || null, normalized.updateReport?.state || null,
      normalized.updateReport?.started_at_utc_msc || null,
      normalized.updateReport?.updated_at_utc_msc || null,
      normalized.updateReport?.error_code || null, nowUtcMsc,
    ])
    if (normalized.updateReport) {
      await run(`INSERT IGNORE INTO bridge_update_events
        (installation_id, release_id, target_version, state, started_at_utc_msc,
         updated_at_utc_msc, error_code, bridge_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        normalized.installationId, normalized.updateReport.release_id,
        normalized.updateReport.target_version, normalized.updateReport.state,
        normalized.updateReport.started_at_utc_msc || null,
        normalized.updateReport.updated_at_utc_msc,
        normalized.updateReport.error_code || null, normalized.bridgeVersion,
      ])
    }
    return { ...normalized, connected:true, lastSeenAtUtcMsc:nowUtcMsc,
      resumed:Boolean(existing && sameUser && routeMatch
        && normalized.connectionEpoch === existing.connection_epoch),
      rebound:ownerRebound,
      accountRebound,
      ownerRebound,
      previousRoute,
    }
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
