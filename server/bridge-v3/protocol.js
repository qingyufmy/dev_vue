export const BRIDGE_PROTOCOL_VERSION = 3

export const BRIDGE_V3_MESSAGE_TYPES = Object.freeze(new Set([
  'hello', 'hello_ack', 'command', 'command_result', 'command_result_ack', 'quote_request', 'quote',
  'data_request', 'data_response',
  'data_delta', 'data_ack', 'heartbeat', 'release_available', 'error',
]))

export const BRIDGE_V3_DATA_REQUEST_ACTIONS = Object.freeze(new Set([
  'rates', 'symbol_snapshot', 'risk_snapshot', 'performance_daily',
  'symbols', 'history', 'history_page', 'history_evidence', 'chart_data', 'pending_order_state', 'diagnostics',
]))

export const BRIDGE_V3_COMMAND_ACTIONS = Object.freeze(new Set([
  'place_order', 'cancel_order', 'modify_order', 'modify_position', 'close_position', 'query_execution',
]))

export const BRIDGE_V3_RESULT_STATUSES = Object.freeze(new Set([
  'succeeded', 'rejected', 'failed', 'uncertain',
]))

export const BRIDGE_V3_DATA_STREAMS = Object.freeze(new Set([
  'account', 'positions', 'orders', 'deals', 'symbols', 'quotes', 'rates',
]))

const BRIDGE_V3_HEARTBEAT_STREAMS = new Set(['account', 'positions', 'orders', 'deals'])

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const CAPABILITY_PATTERN = /^[A-Za-z0-9_]{1,64}$/
const INSTALLATION_ID_PATTERN = /^install_[a-f0-9]{32}$/
const UPDATE_REPORT_STATES = new Set(['healthy', 'rolled_back', 'failed'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function validateId(errors, path, value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) errors.push(`${path}:invalid_id`)
}

function validateAccountRef(errors, value) {
  if (!isRecord(value)) {
    errors.push('account_ref:required_object')
    return
  }
  const brokerServer = String(value.broker_server || '').trim()
  const login = String(value.login || '').trim()
  if (!brokerServer || brokerServer.length > 128) errors.push('account_ref.broker_server:invalid')
  if (!login || login.length > 64) errors.push('account_ref.login:invalid')
}

function validateEnvelope(message) {
  const errors = []
  if (!isRecord(message)) return ['message:required_object']
  if (message.v !== BRIDGE_PROTOCOL_VERSION) errors.push('v:unsupported')
  if (!BRIDGE_V3_MESSAGE_TYPES.has(message.type)) errors.push('type:unsupported')
  validateId(errors, 'message_id', message.message_id)
  if (!isPositiveInteger(message.sent_at_utc_msc)) errors.push('sent_at_utc_msc:invalid')
  return errors
}

function validateTerminalRoute(errors, message) {
  validateId(errors, 'terminal_instance_id', message.terminal_instance_id)
  validateAccountRef(errors, message.account_ref)
  if (!isPositiveInteger(message.connection_epoch)) errors.push('connection_epoch:invalid')
}

function validateCommand(message, nowUtcMsc) {
  const errors = validateEnvelope(message)
  validateId(errors, 'command_id', message.command_id)
  validateTerminalRoute(errors, message)
  if (!isPositiveInteger(message.issued_at_utc_msc)) errors.push('issued_at_utc_msc:invalid')
  if (!isPositiveInteger(message.deadline_utc_msc)) errors.push('deadline_utc_msc:invalid')
  if (isPositiveInteger(message.issued_at_utc_msc) && isPositiveInteger(message.deadline_utc_msc)
    && message.deadline_utc_msc < message.issued_at_utc_msc) errors.push('deadline_utc_msc:before_issue')
  if (isPositiveInteger(message.deadline_utc_msc) && message.deadline_utc_msc <= nowUtcMsc) errors.push('deadline_utc_msc:expired')
  if (!BRIDGE_V3_COMMAND_ACTIONS.has(message.action)) errors.push('action:unsupported')
  if (!isRecord(message.params)) errors.push('params:required_object')
  return errors
}

function validateHello(message, nowUtcMsc) {
  const errors = validateEnvelope(message)
  validateId(errors, 'session_id', message.session_id)
  const bridgeVersion = String(message.bridge_version || '').trim()
  if (!bridgeVersion || bridgeVersion.length > 64) errors.push('bridge_version:invalid')
  if (message.capabilities !== undefined) {
    if (!Array.isArray(message.capabilities) || message.capabilities.length > 32) {
      errors.push('capabilities:invalid')
    } else {
      const uniqueCapabilities = new Set()
      for (const capability of message.capabilities) {
        if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)
          || uniqueCapabilities.has(capability)) {
          errors.push('capabilities:invalid')
          break
        }
        uniqueCapabilities.add(capability)
      }
    }
  }
  if (message.installation_id !== undefined && message.installation_id !== null
    && (typeof message.installation_id !== 'string'
      || !INSTALLATION_ID_PATTERN.test(message.installation_id))) {
    errors.push('installation_id:invalid')
  }
  if (message.update_report !== undefined && message.update_report !== null) {
    const report = message.update_report
    if (!isRecord(report)) errors.push('update_report:invalid')
    else {
      if (!INSTALLATION_ID_PATTERN.test(message.installation_id || '')) {
        errors.push('update_report:installation_required')
      }
      validateId(errors, 'update_report.release_id', report.release_id)
      const targetVersion = String(report.target_version || '').trim()
      if (!/^\d+\.\d+(?:\.\d+){0,2}$/.test(targetVersion)) {
        errors.push('update_report.target_version:invalid')
      }
      if (!UPDATE_REPORT_STATES.has(report.state)) errors.push('update_report.state:invalid')
      if (report.started_at_utc_msc !== undefined && report.started_at_utc_msc !== null
        && !isPositiveInteger(report.started_at_utc_msc)) {
        errors.push('update_report.started_at_utc_msc:invalid')
      }
      if (!isPositiveInteger(report.updated_at_utc_msc)) errors.push('update_report.updated_at_utc_msc:invalid')
      if (isPositiveInteger(report.updated_at_utc_msc)
        && report.updated_at_utc_msc > nowUtcMsc + 10 * 60 * 1000) {
        errors.push('update_report.updated_at_utc_msc:future')
      }
      if (isPositiveInteger(report.started_at_utc_msc) && isPositiveInteger(report.updated_at_utc_msc)
        && report.updated_at_utc_msc < report.started_at_utc_msc) {
        errors.push('update_report.updated_at_utc_msc:before_start')
      }
      if (report.error_code !== undefined && report.error_code !== null
        && (typeof report.error_code !== 'string' || !/^[A-Za-z0-9_]{1,128}$/.test(report.error_code))) {
        errors.push('update_report.error_code:invalid')
      }
      if (report.state === 'failed' && !report.error_code) errors.push('update_report.error_code:required')
    }
  }
  if (!Array.isArray(message.terminals) || !message.terminals.length || message.terminals.length > 32) {
    errors.push('terminals:invalid')
    return errors
  }
  const ids = new Set()
  for (const [index, terminal] of message.terminals.entries()) {
    if (!isRecord(terminal)) {
      errors.push(`terminals.${index}:invalid`)
      continue
    }
    const routeErrors = []
    validateTerminalRoute(routeErrors, terminal)
    for (const error of routeErrors) errors.push(`terminals.${index}.${error}`)
    if (!['mt4', 'mt5'].includes(terminal.platform)) errors.push(`terminals.${index}.platform:unsupported`)
    if (ids.has(terminal.terminal_instance_id)) errors.push(`terminals.${index}.terminal_instance_id:duplicate`)
    ids.add(terminal.terminal_instance_id)
  }
  return errors
}

function validateHeartbeat(message) {
  const errors = validateEnvelope(message)
  validateId(errors, 'session_id', message.session_id)
  if (!Array.isArray(message.terminals) || message.terminals.length < 1 || message.terminals.length > 32) {
    errors.push('terminals:invalid')
    return errors
  }
  const ids = new Set()
  for (const [index, terminal] of message.terminals.entries()) {
    if (!isRecord(terminal)) {
      errors.push(`terminals.${index}:invalid`)
      continue
    }
    validateId(errors, `terminals.${index}.terminal_instance_id`, terminal.terminal_instance_id)
    if (!isPositiveInteger(terminal.connection_epoch)) {
      errors.push(`terminals.${index}.connection_epoch:invalid`)
    }
    if (ids.has(terminal.terminal_instance_id)) {
      errors.push(`terminals.${index}.terminal_instance_id:duplicate`)
    }
    ids.add(terminal.terminal_instance_id)
    if (!isRecord(terminal.streams)) {
      errors.push(`terminals.${index}.streams:required_object`)
      continue
    }
    for (const [stream, observedAt] of Object.entries(terminal.streams)) {
      if (!BRIDGE_V3_HEARTBEAT_STREAMS.has(stream)) {
        errors.push(`terminals.${index}.streams.${stream}:unsupported`)
      } else if (!isPositiveInteger(observedAt)) {
        errors.push(`terminals.${index}.streams.${stream}:invalid`)
      }
    }
  }
  return errors
}

function validateCommandResult(message) {
  const errors = validateEnvelope(message)
  validateId(errors, 'command_id', message.command_id)
  validateTerminalRoute(errors, message)
  if (!BRIDGE_V3_RESULT_STATUSES.has(message.status)) errors.push('status:unsupported')
  if (!isPositiveInteger(message.completed_at_utc_msc)) errors.push('completed_at_utc_msc:invalid')
  if (message.error_code !== undefined && message.error_code !== null
    && (typeof message.error_code !== 'string' || !/^[A-Za-z0-9_]{1,128}$/.test(message.error_code))) {
    errors.push('error_code:invalid')
  }
  if (message.error_message !== undefined && message.error_message !== null
    && (typeof message.error_message !== 'string' || message.error_message.length > 1000)) {
    errors.push('error_message:invalid')
  }
  if (message.raw_result !== undefined && message.raw_result !== null && !isRecord(message.raw_result)) {
    errors.push('raw_result:invalid')
  }
  if (!isRecord(message.evidence)) errors.push('evidence:required_object')
  else {
    const evidence = message.evidence
    if (!isPositiveInteger(evidence.observed_at_utc_msc)) {
      errors.push('evidence.observed_at_utc_msc:invalid')
    }
    for (const field of ['order_tickets', 'position_tickets', 'deal_tickets']) {
      const tickets = evidence[field]
      if (tickets === undefined) continue
      if (!Array.isArray(tickets)) {
        errors.push(`evidence.${field}:required_array`)
        continue
      }
      if (tickets.length > 100) errors.push(`evidence.${field}:too_many`)
      for (const [index, ticket] of tickets.entries()) {
        if (typeof ticket !== 'string' || !ticket.trim() || ticket.length > 64) {
          errors.push(`evidence.${field}.${index}:invalid`)
        }
      }
    }
    if (evidence.broker_retcode !== undefined && evidence.broker_retcode !== null
      && !Number.isSafeInteger(evidence.broker_retcode)) {
      errors.push('evidence.broker_retcode:invalid')
    }
  }
  return errors
}

function validateCommandResultAck(message) {
  const errors = validateEnvelope(message)
  validateId(errors, 'acked_message_id', message.acked_message_id)
  validateId(errors, 'command_id', message.command_id)
  validateTerminalRoute(errors, message)
  if (!['applied', 'duplicate'].includes(message.status)) errors.push('status:unsupported')
  return errors
}

function validateSymbol(errors, value) {
  const symbol = String(value || '').trim()
  if (!symbol || symbol.length > 64 || value !== symbol) errors.push('symbol:invalid')
}

function validateQuoteRequest(message) {
  const errors = validateEnvelope(message)
  validateId(errors, 'request_id', message.request_id)
  validateTerminalRoute(errors, message)
  validateSymbol(errors, message.symbol)
  return errors
}

function validateQuote(message) {
  const errors = validateQuoteRequest(message)
  if (!isPositiveInteger(message.observed_at_utc_msc)) errors.push('observed_at_utc_msc:invalid')
  if (!['succeeded', 'rejected'].includes(message.status)) errors.push('status:unsupported')
  const hasErrorCode = message.error_code !== undefined && message.error_code !== null
  const validErrorCode = typeof message.error_code === 'string'
    && Boolean(message.error_code.trim()) && message.error_code.length <= 128
  if (message.status === 'succeeded') {
    if (!Number.isFinite(message.bid) || message.bid <= 0) errors.push('bid:invalid')
    if (!Number.isFinite(message.ask) || message.ask <= 0) errors.push('ask:invalid')
    if (Number.isFinite(message.bid) && Number.isFinite(message.ask) && message.ask < message.bid) {
      errors.push('ask:below_bid')
    }
    if (hasErrorCode) errors.push('error_code:forbidden')
  } else if (!validErrorCode) {
    errors.push('error_code:invalid')
  }
  if (message.last !== undefined && message.last !== null
    && (!Number.isFinite(message.last) || message.last < 0)) errors.push('last:invalid')
  if (message.symbol_trade_mode !== undefined && message.symbol_trade_mode !== null
    && (!Number.isInteger(message.symbol_trade_mode)
      || message.symbol_trade_mode < 0 || message.symbol_trade_mode > 4)) {
    errors.push('symbol_trade_mode:invalid')
  }
  if (message.terminal_connected !== undefined && message.terminal_connected !== null
    && typeof message.terminal_connected !== 'boolean') errors.push('terminal_connected:invalid')
  if (message.digits !== undefined && message.digits !== null
    && (!Number.isInteger(message.digits) || message.digits < 0 || message.digits > 16)) {
    errors.push('digits:invalid')
  }
  if (message.point !== undefined && message.point !== null
    && (!Number.isFinite(message.point) || message.point <= 0)) errors.push('point:invalid')
  if (message.timezone_offset_minutes !== undefined && message.timezone_offset_minutes !== null
    && (!Number.isInteger(message.timezone_offset_minutes)
      || message.timezone_offset_minutes < -840 || message.timezone_offset_minutes > 840)) {
    errors.push('timezone_offset_minutes:invalid')
  }
  if (message.clock_status !== undefined && message.clock_status !== null
    && (typeof message.clock_status !== 'string'
      || !message.clock_status.length || message.clock_status.length > 64)) {
    errors.push('clock_status:invalid')
  }
  return errors
}

function validateDataRequest(message) {
  const errors = validateEnvelope(message)
  validateId(errors, 'request_id', message.request_id)
  validateTerminalRoute(errors, message)
  if (!BRIDGE_V3_DATA_REQUEST_ACTIONS.has(message.action)) errors.push('action:unsupported')
  if (!isRecord(message.params)) errors.push('params:required_object')
  return errors
}

function validateDataResponse(message) {
  const errors = validateDataRequest(message)
  if (!isPositiveInteger(message.observed_at_utc_msc)) errors.push('observed_at_utc_msc:invalid')
  if (!['succeeded', 'rejected'].includes(message.status)) errors.push('status:unsupported')
  if (message.status === 'succeeded' && !isRecord(message.payload)) errors.push('payload:required_object')
  if (message.status === 'rejected' && (typeof message.error_code !== 'string'
    || !message.error_code.trim() || message.error_code.length > 128)) errors.push('error_code:invalid')
  return errors
}

function validateDataDelta(message) {
  const errors = validateEnvelope(message)
  validateTerminalRoute(errors, message)
  if (!BRIDGE_V3_DATA_STREAMS.has(message.stream)) errors.push('stream:unsupported')
  if (!isPositiveInteger(message.revision)) errors.push('revision:invalid')
  if (!Number.isSafeInteger(message.base_revision) || message.base_revision < 0) errors.push('base_revision:invalid')
  if (typeof message.full_snapshot !== 'boolean') errors.push('full_snapshot:invalid')
  if (isPositiveInteger(message.revision) && Number.isSafeInteger(message.base_revision)
    && message.full_snapshot !== true
    && message.revision !== message.base_revision + 1) errors.push('revision:not_next')
  if (message.full_snapshot === true && message.base_revision !== 0) errors.push('base_revision:full_snapshot_requires_zero')
  if (message.full_snapshot === true && Array.isArray(message.deletes) && message.deletes.length) {
    errors.push('deletes:full_snapshot_requires_empty')
  }
  if (!isPositiveInteger(message.observed_at_utc_msc)) errors.push('observed_at_utc_msc:invalid')
  if (message.source_time_msc !== null
    && (!Number.isSafeInteger(message.source_time_msc) || message.source_time_msc < 0)) errors.push('source_time_msc:invalid')
  if (!Array.isArray(message.upserts)) errors.push('upserts:required_array')
  else {
    if (message.upserts.length > 10_000) errors.push('upserts:too_many')
    for (const [index, item] of message.upserts.entries()) {
      if (!isRecord(item)) errors.push(`upserts.${index}:required_object`)
    }
  }
  if (!Array.isArray(message.deletes)) errors.push('deletes:required_array')
  else {
    if (message.deletes.length > 10_000) errors.push('deletes:too_many')
    for (const [index, ticket] of message.deletes.entries()) {
      const validString = typeof ticket === 'string' && ticket.trim().length > 0 && ticket.length <= 64
      const validNumber = Number.isSafeInteger(ticket) && ticket >= 0
      if (!validString && !validNumber) errors.push(`deletes.${index}:invalid`)
    }
  }
  if (message.stream === 'account' && Array.isArray(message.upserts) && Array.isArray(message.deletes)
    && message.upserts.length === 1 && message.deletes.length === 0 && isRecord(message.upserts[0])) {
    const account = message.upserts[0]
    const routeLogin = String(message.account_ref?.login || '').trim()
    const loginMatches = typeof account.login === 'string'
      ? account.login === routeLogin
      : Number.isSafeInteger(account.login) && account.login >= 0 && String(account.login) === routeLogin
    const serverMatches = typeof account.server === 'string'
      && account.server === String(message.account_ref?.broker_server || '').trim()
    if (!loginMatches || !serverMatches) errors.push('account:route_mismatch')
  } else if (message.stream === 'account'
    && Array.isArray(message.upserts) && Array.isArray(message.deletes)) {
    errors.push('account:invalid')
  }
  return errors
}

function validateReleaseAvailable(message) {
  const errors = validateEnvelope(message)
  if (message.release_id !== null && message.release_id !== undefined) {
    validateId(errors, 'release_id', message.release_id)
  }
  if (typeof message.release_version !== 'string'
    || !/^\d+\.\d+(?:\.\d+){0,2}$/.test(message.release_version)) {
    errors.push('release_version:invalid')
  }
  if (!['internal', 'stable'].includes(message.rollout_channel)) {
    errors.push('rollout_channel:unsupported')
  }
  if (!['published', 'rollback'].includes(message.reason)) errors.push('reason:unsupported')
  return errors
}

export function validateBridgeV3Message(message, { nowUtcMsc = Date.now() } = {}) {
  const envelopeErrors = validateEnvelope(message)
  if (envelopeErrors.length || !isRecord(message)) return { ok:false, errors:envelopeErrors }

  let errors
  if (message.type === 'hello') errors = validateHello(message, nowUtcMsc)
  else if (message.type === 'command') errors = validateCommand(message, nowUtcMsc)
  else if (message.type === 'command_result') errors = validateCommandResult(message)
  else if (message.type === 'command_result_ack') errors = validateCommandResultAck(message)
  else if (message.type === 'heartbeat') errors = validateHeartbeat(message)
  else if (message.type === 'quote_request') errors = validateQuoteRequest(message)
  else if (message.type === 'quote') errors = validateQuote(message)
  else if (message.type === 'data_request') errors = validateDataRequest(message)
  else if (message.type === 'data_response') errors = validateDataResponse(message)
  else if (message.type === 'data_delta') errors = validateDataDelta(message)
  else if (message.type === 'release_available') errors = validateReleaseAvailable(message)
  else errors = envelopeErrors

  return errors.length ? { ok:false, errors } : { ok:true, errors:[] }
}

export function assertBridgeV3Message(message, options) {
  const result = validateBridgeV3Message(message, options)
  if (result.ok) return message
  const error = new Error(`bridge_v3_message_invalid:${result.errors.join(',')}`)
  error.code = 'bridge_v3_message_invalid'
  error.details = result.errors
  throw error
}

export function sameBridgeRoute(left, right) {
  return String(left?.terminal_instance_id || '') === String(right?.terminal_instance_id || '')
    && Number(left?.connection_epoch || 0) === Number(right?.connection_epoch || 0)
    && String(left?.account_ref?.broker_server || '').trim().toLowerCase()
      === String(right?.account_ref?.broker_server || '').trim().toLowerCase()
    && String(left?.account_ref?.login || '').trim() === String(right?.account_ref?.login || '').trim()
}
