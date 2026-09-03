import { createHash } from 'node:crypto'
import type { JsonObject } from '../../inference/domain/inference.js'

export const BRIDGE_COMMAND_ACTIONS = [
  'order.place', 'position.protection.set', 'position.close',
  'pending_order.modify', 'pending_order.cancel',
] as const
export type BridgeCommandAction = typeof BRIDGE_COMMAND_ACTIONS[number]

export const BRIDGE_COMMAND_STATUSES = [
  'queued', 'dispatched', 'accepted', 'succeeded', 'rejected', 'failed', 'uncertain', 'reconciling',
] as const
export type BridgeCommandStatus = typeof BRIDGE_COMMAND_STATUSES[number]
export type BridgeCommandResultStatus = 'succeeded' | 'rejected' | 'failed' | 'uncertain'

export interface BridgeRoute {
  terminalInstanceId: string
  brokerServer: string
  login: string
  connectionEpoch: number
}

export interface BridgeCommand {
  id: string
  executionIntentId: string
  commandSequence: number
  userId: number
  accountId: string
  terminalProfileId: string
  route: BridgeRoute
  action: BridgeCommandAction
  idempotencyKey: string
  requestHash: string
  status: BridgeCommandStatus
  issuedAt: string
  deadlineAt: string
  dispatchedAt: string | null
  acceptedAt: string | null
  completedAt: string | null
  errorCode: string | null
  terminalCode: string | null
  resultHash: string | null
  resultMessageId: string | null
  revision: number
  createdAt: string
  updatedAt: string
  request: BridgeCommandRequestEnvelope
}

export interface BridgeCommandRequestEnvelope {
  v: 4
  message_id: string
  type: 'command.request'
  sent_at_utc_msc: number
  correlation_id: string
  route: BridgeWireRoute
  payload: BridgeCommandSpec
}

export interface BridgeCommandAcceptedEnvelope {
  v: 4
  message_id: string
  type: 'command.accepted'
  sent_at_utc_msc: number
  correlation_id: string | null
  route: BridgeWireRoute
  payload: { command_id: string; status: 'recorded' | 'duplicate'; accepted_at_utc_msc: number }
}

export interface BridgeCommandResultEnvelope {
  v: 4
  message_id: string
  type: 'command.result'
  sent_at_utc_msc: number
  correlation_id: string | null
  route: BridgeWireRoute
  payload: {
    command_id: string
    action: BridgeCommandAction
    status: BridgeCommandResultStatus
    completed_at_utc_msc: number
    result: JsonObject | null
    error_code: string | null
    terminal_code?: string | number | null
  }
}

export interface BridgeCommandResultAckEnvelope {
  v: 4
  message_id: string
  type: 'command.result_ack'
  sent_at_utc_msc: number
  correlation_id: string
  route: BridgeWireRoute
  payload: { command_id: string; status: 'persisted' | 'duplicate' }
}

export interface BridgeCommandReconcileEnvelope {
  v: 4
  message_id: string
  type: 'command.reconcile'
  sent_at_utc_msc: number
  correlation_id: string
  route: BridgeWireRoute
  payload: { command_id: string; action: BridgeCommandAction; terminal_ticket?: string | null }
}

export interface BridgeWireRoute {
  terminal_instance_id: string
  account_ref: { broker_server: string; login: string }
  connection_epoch: number
}

export interface BridgeCommandSpec {
  command_id: string
  idempotency_key: string
  action: BridgeCommandAction
  issued_at_utc_msc: number
  deadline_utc_msc: number
  params: JsonObject
  expected_state: JsonObject | null
}

export interface CreateBridgeCommandInput {
  executionIntentId: string
  commandSequence: number
  userId: number
  accountId: string
  terminalProfileId: string
  route: BridgeRoute
  action: BridgeCommandAction
  params: JsonObject
  expectedState: JsonObject | null
  deadlineAt: string
}

export class BridgeCommandError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code)
    this.name = 'BridgeCommandError'
  }
}

export function bridgeCommandId(executionIntentId: string, commandSequence: number) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(executionIntentId)) fail('bridge_command_execution_intent_id_invalid')
  if (!Number.isSafeInteger(commandSequence) || commandSequence < 1 || commandSequence > 65_535) fail('bridge_command_sequence_invalid')
  return `cmd_${canonicalHash({ executionIntentId, commandSequence }).slice(0, 48)}`
}

export function bridgeCommandInputMatches(command: BridgeCommand, input: CreateBridgeCommandInput) {
  const deadline = Date.parse(input.deadlineAt)
  return command.id === bridgeCommandId(input.executionIntentId, input.commandSequence)
    && command.executionIntentId === input.executionIntentId
    && command.commandSequence === input.commandSequence
    && command.userId === input.userId
    && command.accountId === input.accountId
    && command.terminalProfileId === input.terminalProfileId
    && canonical(command.route) === canonical(input.route)
    && command.action === input.action
    && canonical(command.request.payload.params) === canonical(input.params)
    && canonical(command.request.payload.expected_state) === canonical(input.expectedState)
    && Number.isFinite(deadline)
    && Date.parse(command.deadlineAt) === deadline
}

export function createBridgeCommand(input: CreateBridgeCommandInput, now = new Date()): BridgeCommand {
  assertDate(now)
  const id = bridgeCommandId(input.executionIntentId, input.commandSequence)
  assertInternalId(input.accountId, 'account_id')
  assertOpaque(input.terminalProfileId, 'terminal_profile_id')
  if (!Number.isSafeInteger(input.userId) || input.userId < 1) fail('bridge_command_user_id_invalid')
  if (!BRIDGE_COMMAND_ACTIONS.includes(input.action)) fail('bridge_command_action_invalid')
  assertRoute(input.route)
  assertObject(input.params, 64, 'bridge_command_params_invalid')
  if (input.expectedState !== null) assertObject(input.expectedState, 32, 'bridge_command_expected_state_invalid')
  if ((input.action === 'order.place') !== (input.expectedState === null)) fail('bridge_command_expected_state_invalid')
  assertCommandShape(input.action, input.params, input.expectedState)
  const deadline = Date.parse(input.deadlineAt)
  if (!Number.isFinite(deadline) || deadline <= now.getTime()) fail('bridge_command_deadline_invalid')
  const issuedAt = now.toISOString()
  const wireRoute = toWireRoute(input.route)
  const payload: BridgeCommandSpec = {
    command_id: id,
    idempotency_key: `intent:${input.executionIntentId}:${input.commandSequence}`,
    action: input.action,
    issued_at_utc_msc: now.getTime(),
    deadline_utc_msc: deadline,
    params: input.params,
    expected_state: input.expectedState,
  }
  const request: BridgeCommandRequestEnvelope = {
    v: 4,
    message_id: `msg_${canonicalHash({ id, kind: 'request' }).slice(0, 48)}`,
    type: 'command.request',
    sent_at_utc_msc: now.getTime(),
    correlation_id: input.executionIntentId,
    route: wireRoute,
    payload,
  }
  return {
    id, executionIntentId: input.executionIntentId, commandSequence: input.commandSequence,
    userId: input.userId, accountId: input.accountId, terminalProfileId: input.terminalProfileId,
    route: input.route, action: input.action, idempotencyKey: payload.idempotency_key,
    requestHash: canonicalHash(payload), status: 'queued', issuedAt, deadlineAt: new Date(deadline).toISOString(),
    dispatchedAt: null, acceptedAt: null, completedAt: null, errorCode: null, terminalCode: null,
    resultHash: null, resultMessageId: null, revision: 1, createdAt: issuedAt, updatedAt: issuedAt, request,
  }
}

export function bridgeResultHash(envelope: BridgeCommandResultEnvelope) {
  assertResultEnvelope(envelope)
  // Bridge durable Outbox refreshes the route epoch after reconnect. The
  // terminal result identity is its immutable payload, not its transport route.
  return canonicalHash(envelope.payload)
}

export function assertAcceptedEnvelope(envelope: BridgeCommandAcceptedEnvelope) {
  assertEnvelopeBase(envelope, 'command.accepted')
  assertOpaque(envelope.payload.command_id, 'command_id')
  if (envelope.payload.status !== 'recorded' && envelope.payload.status !== 'duplicate') fail('bridge_command_accepted_status_invalid')
  assertUtcMsc(envelope.payload.accepted_at_utc_msc, 'bridge_command_accepted_time_invalid')
}

export function assertResultEnvelope(envelope: BridgeCommandResultEnvelope) {
  assertEnvelopeBase(envelope, 'command.result')
  assertOpaque(envelope.payload.command_id, 'command_id')
  if (!BRIDGE_COMMAND_ACTIONS.includes(envelope.payload.action)) fail('bridge_command_result_action_invalid')
  if (!['succeeded', 'rejected', 'failed', 'uncertain'].includes(envelope.payload.status)) fail('bridge_command_result_status_invalid')
  assertUtcMsc(envelope.payload.completed_at_utc_msc, 'bridge_command_result_time_invalid')
  if (envelope.payload.result !== null) assertObject(envelope.payload.result, 64, 'bridge_command_result_invalid')
  if (envelope.payload.error_code !== null && !safeText(envelope.payload.error_code, 128)) fail('bridge_command_result_error_invalid')
}

export function resultAck(command: BridgeCommand, resultMessageId: string, duplicate: boolean, now = new Date(), route = command.request.route): BridgeCommandResultAckEnvelope {
  assertDate(now); assertOpaque(resultMessageId, 'result_message_id')
  return { v: 4, message_id: `ack_${canonicalHash({ commandId: command.id, resultMessageId }).slice(0, 48)}`,
    type: 'command.result_ack', sent_at_utc_msc: now.getTime(), correlation_id: resultMessageId,
    route, payload: { command_id: command.id, status: duplicate ? 'duplicate' : 'persisted' } }
}

export function reconcileEnvelope(command: BridgeCommand, terminalTicket: string | null, now = new Date(), route = command.request.route): BridgeCommandReconcileEnvelope {
  assertDate(now)
  if (command.status !== 'uncertain') fail('bridge_command_reconcile_status_invalid', 409)
  if (terminalTicket !== null && !/^[1-9][0-9]{0,19}$/.test(terminalTicket)) fail('bridge_command_terminal_ticket_invalid')
  const payload: BridgeCommandReconcileEnvelope['payload'] = { command_id: command.id, action: command.action }
  if (terminalTicket !== null) payload.terminal_ticket = terminalTicket
  return { v: 4, message_id: `rec_${canonicalHash({ commandId: command.id, revision: command.revision }).slice(0, 48)}`,
    type: 'command.reconcile', sent_at_utc_msc: now.getTime(), correlation_id: command.id,
    route, payload }
}

export function routeMatches(command: BridgeCommand, route: BridgeWireRoute) {
  return route.terminal_instance_id === command.route.terminalInstanceId
    && route.account_ref.broker_server === command.route.brokerServer
    && route.account_ref.login === command.route.login
    && route.connection_epoch === command.route.connectionEpoch
}

export function routeContinues(command: BridgeCommand, route: BridgeWireRoute) {
  return route.terminal_instance_id === command.route.terminalInstanceId
    && route.account_ref.broker_server === command.route.brokerServer
    && route.account_ref.login === command.route.login
    && Number.isSafeInteger(route.connection_epoch)
    && route.connection_epoch >= command.route.connectionEpoch
}

export function canonicalHash(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function toWireRoute(route: BridgeRoute): BridgeWireRoute {
  return { terminal_instance_id: route.terminalInstanceId,
    account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: route.connectionEpoch }
}

function assertEnvelopeBase(envelope: { v: number; type: string; message_id: string; sent_at_utc_msc: number; route: BridgeWireRoute }, type: string) {
  if (envelope.v !== 4 || envelope.type !== type) fail('bridge_command_envelope_invalid')
  assertOpaque(envelope.message_id, 'message_id'); assertUtcMsc(envelope.sent_at_utc_msc, 'bridge_command_message_time_invalid')
  assertRoute({ terminalInstanceId: envelope.route.terminal_instance_id, brokerServer: envelope.route.account_ref.broker_server,
    login: envelope.route.account_ref.login, connectionEpoch: envelope.route.connection_epoch })
}

function assertRoute(route: BridgeRoute) {
  assertOpaque(route.terminalInstanceId, 'terminal_instance_id')
  if (!safeText(route.brokerServer, 128) || !safeText(route.login, 64)) fail('bridge_command_route_invalid')
  assertUtcMsc(route.connectionEpoch, 'bridge_command_epoch_invalid')
}
function assertCommandShape(action: BridgeCommandAction, params: JsonObject, expected: JsonObject | null) {
  const ticket = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
  const positive = (value: unknown) => typeof value === 'string' && /^(?:0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]+)?)$/.test(value)
  const integer = (value: unknown, max = 100_000) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max
  const optionalPositive = (key: string) => params[key] === undefined || positive(params[key])
  const optionalTrue = (key: string) => params[key] === undefined || params[key] === true
  const exact = (allowed: string[]) => Object.keys(params).every(key => allowed.includes(key))
  switch (action) {
    case 'order.place': {
      const allowed = ['symbol', 'direction', 'order_type', 'volume', 'price', 'stop_limit_price', 'stop_loss', 'take_profit', 'expiration_utc_msc', 'magic', 'deviation']
      const direction = params.direction; const orderType = params.order_type
      if (!exact(allowed) || !safeText(String(params.symbol ?? ''), 64) || !['buy', 'sell'].includes(String(direction))
        || !['market', 'buy_limit', 'buy_stop', 'buy_stop_limit', 'sell_limit', 'sell_stop', 'sell_stop_limit'].includes(String(orderType))
        || !positive(params.volume) || !integer(params.magic, 2_147_483_647) || !integer(params.deviation)
        || !optionalPositive('price') || !optionalPositive('stop_limit_price') || !optionalPositive('stop_loss') || !optionalPositive('take_profit')) fail('bridge_command_params_invalid')
      if (orderType === 'market' ? (params.price !== undefined || params.stop_limit_price !== undefined || params.expiration_utc_msc !== undefined) : !positive(params.price)) fail('bridge_command_params_invalid')
      const stopLimit = orderType === 'buy_stop_limit' || orderType === 'sell_stop_limit'
      if (stopLimit !== (params.stop_limit_price !== undefined)) fail('bridge_command_params_invalid')
      if ((direction === 'buy' && String(orderType).startsWith('sell_')) || (direction === 'sell' && String(orderType).startsWith('buy_'))) fail('bridge_command_params_invalid')
      if (params.expiration_utc_msc !== undefined && (!Number.isSafeInteger(params.expiration_utc_msc) || Number(params.expiration_utc_msc) < 1)) fail('bridge_command_params_invalid')
      break
    }
    case 'position.protection.set':
      if (!exact(['ticket', 'stop_loss', 'remove_stop_loss', 'take_profit', 'remove_take_profit']) || !ticket(params.ticket)
        || !optionalPositive('stop_loss') || !optionalPositive('take_profit') || !optionalTrue('remove_stop_loss') || !optionalTrue('remove_take_profit')
        || (params.stop_loss === undefined && params.remove_stop_loss === undefined && params.take_profit === undefined && params.remove_take_profit === undefined)
        || (params.stop_loss !== undefined && params.remove_stop_loss !== undefined) || (params.take_profit !== undefined && params.remove_take_profit !== undefined)) fail('bridge_command_params_invalid')
      break
    case 'position.close':
      if (!exact(['ticket', 'volume', 'deviation']) || !ticket(params.ticket) || !integer(params.deviation) || !optionalPositive('volume')) fail('bridge_command_params_invalid')
      break
    case 'pending_order.modify':
      if (!exact(['ticket', 'price', 'stop_limit_price', 'stop_loss', 'remove_stop_loss', 'take_profit', 'remove_take_profit', 'expiration_utc_msc', 'remove_expiration'])
        || !ticket(params.ticket) || !optionalPositive('price') || !optionalPositive('stop_limit_price') || !optionalPositive('stop_loss') || !optionalPositive('take_profit')
        || !optionalTrue('remove_stop_loss') || !optionalTrue('remove_take_profit') || !optionalTrue('remove_expiration')
        || (params.expiration_utc_msc !== undefined && (!Number.isSafeInteger(params.expiration_utc_msc) || Number(params.expiration_utc_msc) < 1))
        || Object.keys(params).length < 2 || (params.stop_loss !== undefined && params.remove_stop_loss !== undefined)
        || (params.take_profit !== undefined && params.remove_take_profit !== undefined) || (params.expiration_utc_msc !== undefined && params.remove_expiration !== undefined)) fail('bridge_command_params_invalid')
      break
    case 'pending_order.cancel':
      if (!exact(['ticket']) || !ticket(params.ticket)) fail('bridge_command_params_invalid')
      break
  }
  if (expected !== null) assertExpectedTradeState(expected)
}
function assertExpectedTradeState(value: JsonObject) {
  const keys = ['ticket', 'symbol', 'direction', 'order_type', 'magic', 'volume', 'open_price', 'stop_limit_price', 'stop_loss', 'take_profit', 'expiration_utc_msc']
  const decimalOrNull = (item: unknown) => item === null || (typeof item === 'string' && /^(?:0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]+)?)$/.test(item))
  if (Object.keys(value).length !== keys.length || !keys.every(key => key in value)
    || typeof value.ticket !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.ticket)
    || !safeText(String(value.symbol ?? ''), 64) || !['buy', 'sell'].includes(String(value.direction))
    || !['market', 'buy_limit', 'buy_stop', 'buy_stop_limit', 'sell_limit', 'sell_stop', 'sell_stop_limit'].includes(String(value.order_type))
    || !Number.isSafeInteger(value.magic) || Number(value.magic) < 0 || Number(value.magic) > 2_147_483_647
    || !decimalOrNull(value.volume) || value.volume === null || !decimalOrNull(value.open_price) || value.open_price === null
    || !decimalOrNull(value.stop_limit_price) || !decimalOrNull(value.stop_loss) || !decimalOrNull(value.take_profit)
    || (value.expiration_utc_msc !== null && (!Number.isSafeInteger(value.expiration_utc_msc) || Number(value.expiration_utc_msc) < 1))) fail('bridge_command_expected_state_invalid')
}
function assertUtcMsc(value: number, code: string) { if (!Number.isSafeInteger(value) || value < 1) fail(code) }
function assertOpaque(value: string, field: string) { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/.test(String(value ?? ''))) fail(`bridge_command_${field}_invalid`) }
function assertInternalId(value: string, field: string) { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(String(value ?? ''))) fail(`bridge_command_${field}_invalid`) }
function assertObject(value: JsonObject, max: number, code: string) { if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length > max) fail(code) }
function safeText(value: string, max: number) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n]/.test(value) }
function assertDate(value: Date) { if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() < 1) fail('bridge_command_time_invalid') }
function fail(code: string, status = 422): never { throw new BridgeCommandError(code, status) }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
