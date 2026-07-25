export const BRIDGE_PROTOCOL_VERSION = 3

export const BRIDGE_V3_MESSAGE_TYPES = Object.freeze(new Set([
  'hello', 'hello_ack', 'command', 'command_result', 'quote_request', 'quote',
  'data_delta', 'data_ack', 'heartbeat', 'error',
]))

export const BRIDGE_V3_COMMAND_ACTIONS = Object.freeze(new Set([
  'place_order', 'cancel_order', 'modify_order', 'close_position', 'query_execution',
]))

export const BRIDGE_V3_RESULT_STATUSES = Object.freeze(new Set([
  'succeeded', 'rejected', 'failed', 'uncertain',
]))

export const BRIDGE_V3_DATA_STREAMS = Object.freeze(new Set([
  'account', 'positions', 'orders', 'deals', 'symbols', 'quotes', 'rates',
]))

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

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

function validateHello(message) {
  const errors = validateEnvelope(message)
  validateId(errors, 'session_id', message.session_id)
  const bridgeVersion = String(message.bridge_version || '').trim()
  if (!bridgeVersion || bridgeVersion.length > 64) errors.push('bridge_version:invalid')
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

function validateCommandResult(message) {
  const errors = validateEnvelope(message)
  validateId(errors, 'command_id', message.command_id)
  validateTerminalRoute(errors, message)
  if (!BRIDGE_V3_RESULT_STATUSES.has(message.status)) errors.push('status:unsupported')
  if (!isPositiveInteger(message.completed_at_utc_msc)) errors.push('completed_at_utc_msc:invalid')
  if (!isRecord(message.evidence)) errors.push('evidence:required_object')
  else if (!isPositiveInteger(message.evidence.observed_at_utc_msc)) errors.push('evidence.observed_at_utc_msc:invalid')
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
  if (!Number.isFinite(message.bid) || message.bid <= 0) errors.push('bid:invalid')
  if (!Number.isFinite(message.ask) || message.ask <= 0) errors.push('ask:invalid')
  if (Number.isFinite(message.bid) && Number.isFinite(message.ask) && message.ask < message.bid) {
    errors.push('ask:below_bid')
  }
  if (message.last !== undefined && message.last !== null
    && (!Number.isFinite(message.last) || message.last < 0)) errors.push('last:invalid')
  return errors
}

function validateDataDelta(message) {
  const errors = validateEnvelope(message)
  validateTerminalRoute(errors, message)
  if (!BRIDGE_V3_DATA_STREAMS.has(message.stream)) errors.push('stream:unsupported')
  if (!isPositiveInteger(message.revision)) errors.push('revision:invalid')
  if (!Number.isSafeInteger(message.base_revision) || message.base_revision < 0) errors.push('base_revision:invalid')
  if (isPositiveInteger(message.revision) && Number.isSafeInteger(message.base_revision)
    && message.full_snapshot !== true
    && message.revision !== message.base_revision + 1) errors.push('revision:not_next')
  if (message.full_snapshot === true && message.base_revision !== 0) errors.push('base_revision:full_snapshot_requires_zero')
  if (!isPositiveInteger(message.observed_at_utc_msc)) errors.push('observed_at_utc_msc:invalid')
  if (message.source_time_msc !== null
    && (!Number.isSafeInteger(message.source_time_msc) || message.source_time_msc < 0)) errors.push('source_time_msc:invalid')
  if (!Array.isArray(message.upserts)) errors.push('upserts:required_array')
  if (!Array.isArray(message.deletes)) errors.push('deletes:required_array')
  return errors
}

export function validateBridgeV3Message(message, { nowUtcMsc = Date.now() } = {}) {
  const envelopeErrors = validateEnvelope(message)
  if (envelopeErrors.length || !isRecord(message)) return { ok:false, errors:envelopeErrors }

  let errors
  if (message.type === 'hello') errors = validateHello(message)
  else if (message.type === 'command') errors = validateCommand(message, nowUtcMsc)
  else if (message.type === 'command_result') errors = validateCommandResult(message)
  else if (message.type === 'quote_request') errors = validateQuoteRequest(message)
  else if (message.type === 'quote') errors = validateQuote(message)
  else if (message.type === 'data_delta') errors = validateDataDelta(message)
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
