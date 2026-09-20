import { unchangedUserCommandTradeState } from './mysql-user-command-trade-state.js'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { JsonObject, JsonValue, TraderAction } from '../../inference/index.js'
import type { ExecutionCommandSource } from '../application/execution-dispatch-ports.js'
import { BridgeCommandError, type BridgeCommandAction } from '../domain/bridge-command.js'
import { sha256Canonical } from '../domain/execution.js'

interface CandidateRow extends RowDataPacket {
  account_busy: number; intent_id: string; user_id: number; trading_account_id: string | number; action_kind: TraderAction['kind']; expires_at_utc: Date
  action_json: string | TraderAction; action_sha256: string; terminal_profile_id: string; terminal_instance_id: string
  broker_server: string; account_login: string; connection_epoch_v4: string | number; source_type: string
}
interface StateRow extends RowDataPacket { state_json: string | JsonObject; state_sha256: string; projection_revision: string | number }

export interface BridgeExecutionDefaults { magic: number; deviation: number }

export class MysqlExecutionCommandSource implements ExecutionCommandSource {
  constructor(private readonly pool: Pool, private readonly defaults: BridgeExecutionDefaults) {
    if (!Number.isSafeInteger(defaults.magic) || defaults.magic < 0 || defaults.magic > 2_147_483_647
      || !Number.isSafeInteger(defaults.deviation) || defaults.deviation < 0 || defaults.deviation > 100_000) {
      throw new BridgeCommandError('bridge_execution_defaults_invalid', 500)
    }
  }

  async loadPrepared(intentId: string, now: string) {
    const [rows] = await this.pool.execute<CandidateRow[]>(`SELECT i.id intent_id,i.user_id,i.trading_account_id,i.action_kind,i.expires_at_utc,i.source_type,
        EXISTS (
          SELECT 1 FROM bridge_commands_v4 active_command
          WHERE active_command.trading_account_id=i.trading_account_id
            AND active_command.execution_intent_id<>i.id
            AND active_command.status IN ('queued','dispatched','accepted','uncertain','reconciling')
        ) account_busy,
        p.action_json,p.action_sha256,b.terminal_profile_id,b.terminal_instance_id,a.broker_server,a.account_login,s.connection_epoch_v4
      FROM execution_intents i
      INNER JOIN execution_intent_payloads p ON p.execution_intent_id=i.id
      INNER JOIN trading_accounts a ON a.id=i.trading_account_id AND a.deleted_at_utc IS NULL
      INNER JOIN terminal_account_bindings b ON b.trading_account_id=a.id AND b.unbound_at_utc IS NULL
      INNER JOIN terminal_profiles tp ON tp.id=b.terminal_profile_id AND tp.user_id=i.user_id AND tp.deleted_at_utc IS NULL
      INNER JOIN bridge_connection_sessions s ON s.trading_account_id=a.id AND s.user_id=i.user_id
        AND s.terminal_profile_id=b.terminal_profile_id AND s.terminal_instance_id=b.terminal_instance_id
        AND s.connection_epoch_v4 IS NOT NULL AND s.disconnected_at_utc IS NULL
      INNER JOIN account_runtime_snapshots snap ON snap.trading_account_id=a.id AND snap.trade_permission=1
      WHERE i.id=? AND i.status='prepared' AND i.expires_at_utc>?
      ORDER BY s.connection_epoch_v4 DESC LIMIT 1`, [intentId, now])
    const row = rows[0]
    if (!row) return null
    if (Number(row.account_busy) === 1) return { blocked: true as const, accountId: String(row.trading_account_id) }
    const action = parse<TraderAction>(row.action_json)
    if (sha256Canonical(action) !== row.action_sha256 || action.kind !== row.action_kind) {
      throw new BridgeCommandError('bridge_command_intent_payload_invalid', 409)
    }
    const actionName = bridgeAction(action.kind)
    const params = commandParams(action, this.defaults)
    const expectedState = actionName === 'order.place' ? null : await this.expectedState(String(row.trading_account_id), row, action)
    return {
      intentId: row.intent_id,
      accountId: String(row.trading_account_id),
      command: {
        executionIntentId: row.intent_id,
        commandSequence: 1,
        userId: Number(row.user_id),
        accountId: String(row.trading_account_id),
        terminalProfileId: row.terminal_profile_id,
        route: {
          terminalInstanceId: row.terminal_instance_id,
          brokerServer: row.broker_server,
          login: row.account_login,
          connectionEpoch: Number(row.connection_epoch_v4),
        },
        action: actionName,
        params,
        expectedState,
        deadlineAt: new Date(row.expires_at_utc).toISOString(),
      },
    }
  }

  private async expectedState(accountId: string, row: CandidateRow, action: TraderAction) {
    const ticket = action.parameters.ticket
    if (typeof ticket !== 'string') throw new BridgeCommandError('bridge_command_expected_state_missing', 409)
    const entityKind = action.kind === 'modify_position' || action.kind === 'close_position' ? 'position' : 'pending_order'
    const revisionKey = entityKind === 'position' ? 'positionsRevision' : 'pendingOrdersRevision'
    const revision = action.expectedState[revisionKey]
    const [states] = await this.pool.execute<StateRow[]>(`SELECT state_json,state_sha256,projection_revision
      FROM bridge_trade_state_snapshots_v4 WHERE trading_account_id=? AND entity_kind=? AND ticket=?
        AND terminal_instance_id=? AND connection_epoch=? LIMIT 1`, [
      accountId, entityKind, ticket, row.terminal_instance_id, row.connection_epoch_v4,
    ])
    const state = states[0] ? parse<JsonObject>(states[0].state_json) : null
    const currentRevision = Number(states[0]?.projection_revision)
    const unchangedUserState = state && currentRevision > Number(revision) && row.source_type === 'user_command'
      && await unchangedUserCommandTradeState(this.pool, row.intent_id, state)
    // Workflow candidates are only hints; the command transaction must review and bind this exact newer snapshot.
    const revisionMatches = Number.isSafeInteger(revision) && Number(revision) > 0
      && Number.isSafeInteger(currentRevision) && currentRevision > 0
      && ((row.source_type === 'position_workflow' && action.kind === 'modify_position') || unchangedUserState
        ? currentRevision >= Number(revision) : currentRevision === revision)
    if (!state || !revisionMatches || sha256Canonical(state) !== states[0]!.state_sha256) {
      throw new BridgeCommandError('bridge_command_expected_state_stale', 409)
    }
    return state
  }
}

function bridgeAction(kind: TraderAction['kind']): BridgeCommandAction {
  if (kind === 'market_order' || kind === 'pending_order') return 'order.place'
  if (kind === 'modify_position') return 'position.protection.set'
  if (kind === 'close_position') return 'position.close'
  if (kind === 'modify_order') return 'pending_order.modify'
  return 'pending_order.cancel'
}

function commandParams(action: TraderAction, defaults: BridgeExecutionDefaults): JsonObject {
  const source = action.parameters
  const copy = (keys: string[]) => Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key] as JsonValue]))
  switch (action.kind) {
    case 'market_order': return { ...copy(['symbol', 'volume', 'stop_loss', 'take_profit']), direction: source.side!, order_type: 'market', magic: source.magic ?? defaults.magic, deviation: source.deviation ?? defaults.deviation }
    case 'pending_order': return { ...copy(['symbol', 'volume', 'price', 'stop_limit_price', 'stop_loss', 'take_profit', 'expiration_utc_msc']), direction: String(source.type).startsWith('buy_') ? 'buy' : 'sell', order_type: source.type!, magic: source.magic ?? defaults.magic, deviation: source.deviation ?? defaults.deviation }
    case 'modify_position': return copy(['ticket', 'stop_loss', 'remove_stop_loss', 'take_profit', 'remove_take_profit'])
    case 'close_position': return { ...copy(['ticket', 'volume']), deviation: source.deviation ?? defaults.deviation }
    case 'modify_order': return copy(['ticket', 'price', 'stop_limit_price', 'stop_loss', 'remove_stop_loss', 'take_profit', 'remove_take_profit', 'expiration_utc_msc', 'remove_expiration'])
    case 'cancel_order': return copy(['ticket'])
  }
}

function parse<T>(value: string | T): T { return typeof value === 'string' ? JSON.parse(value) as T : value }
