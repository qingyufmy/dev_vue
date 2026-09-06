import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { evaluateSubscriptionWindow, subscriptionWindowFingerprint, executionPreferencesMatch, type SubscriptionExecutionPreferences } from '../../strategies/index.js'
import { readTransactionAccountClock } from '../../trading/index.js'
import { ExecutionError, sha256Canonical } from '../domain/execution.js'

export async function assertRiskDecisionWindow(connection: PoolConnection, riskDecisionId: string, userId: number, accountId: string, now: Date) {
  const [rows] = await connection.execute<(RowDataPacket & { receive_timezone: string; receive_window_json: unknown; snapshot_json: unknown; snapshot_sha256: string | null; preference_version: number; preference_mode: string; preference_revision: string })[]>(`SELECT sc.receive_timezone,sc.receive_window_json,payload.payload_json snapshot_json,snapshot.payload_sha256 snapshot_sha256,pref.contract_version preference_version,pref.take_profit_mode preference_mode,CAST(pref.revision AS CHAR) preference_revision
    FROM risk_decisions_v4 rd INNER JOIN trade_decisions d ON d.id=rd.trade_decision_id
    INNER JOIN ai_trader_runs r ON r.id=d.trader_run_id AND r.user_id=d.user_id AND r.trading_account_id=d.trading_account_id
    INNER JOIN strategy_subscriptions s ON s.id=r.subscription_id AND s.user_id=r.user_id AND s.trading_account_id=r.trading_account_id
      AND s.revision=r.subscription_revision AND s.trader_strategy_id=r.strategy_id AND s.trader_strategy_version_id=r.strategy_version_id
      AND s.status='active' AND s.trader_enabled=1 AND s.trade_send_enabled=1
    INNER JOIN trading_accounts account ON account.id=s.trading_account_id AND account.deleted_at_utc IS NULL
    INNER JOIN trading_account_ownerships own ON own.trading_account_id=account.id AND own.user_id=s.user_id
      AND own.role='owner' AND own.revoked_at_utc IS NULL AND own.revision=account.ownership_revision
    INNER JOIN strategies strategy ON strategy.id=s.trader_strategy_id AND strategy.kind='trader'
      AND strategy.status='active' AND strategy.deleted_at_utc IS NULL AND strategy.active_version_id=s.trader_strategy_version_id
    INNER JOIN subscription_schedules sc ON sc.subscription_id=s.id
    LEFT JOIN subscription_execution_preferences_v4 pref ON pref.subscription_id=s.id
    LEFT JOIN inference_snapshots snapshot ON snapshot.id=d.input_snapshot_id AND snapshot.id=r.input_snapshot_id
      AND snapshot.purpose='trader' AND snapshot.user_id=d.user_id AND snapshot.trading_account_id=d.trading_account_id
    LEFT JOIN inference_snapshot_payloads payload ON payload.snapshot_id=snapshot.id AND payload.encoding='json'
    WHERE rd.id=? AND rd.user_id=? AND rd.trading_account_id=? AND d.user_id=rd.user_id AND d.trading_account_id=rd.trading_account_id
    FOR SHARE`, [riskDecisionId, userId, accountId])
  if (rows.length !== 1) throw new ExecutionError('execution_subscription_changed', 409)
  await assertWindow(connection, rows[0]!, userId, accountId, now)
  const row = rows[0]!
  let snapshot: unknown
  try { snapshot = typeof row.snapshot_json === 'string' ? JSON.parse(row.snapshot_json) : row.snapshot_json }
  catch { throw new ExecutionError('execution_schedule_unproven', 409) }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || sha256Canonical(snapshot) !== row.snapshot_sha256) throw new ExecutionError('execution_schedule_unproven', 409)
  const frozen = (snapshot as Record<string, unknown>).subscriptionWindowHash
  if (typeof frozen !== 'string' || !/^[a-f0-9]{64}$/.test(frozen)) throw new ExecutionError('execution_schedule_unproven', 409)
  if (frozen !== subscriptionWindowFingerprint(row.receive_window_json, row.receive_timezone)) throw new ExecutionError('execution_schedule_changed', 409)
  const preferences = { contractVersion: Number(row.preference_version), takeProfitMode: row.preference_mode, revision: row.preference_revision } as SubscriptionExecutionPreferences
  if (!executionPreferencesMatch((snapshot as Record<string, unknown>).executionPreferences, preferences)) throw new ExecutionError('execution_preferences_changed', 409)
}

export async function assertDistributionWindow(connection: PoolConnection, targetId: string, userId: number, accountId: string, now: Date) {
  const [rows] = await connection.execute<(RowDataPacket & { receive_timezone: string; receive_window_json: unknown; frozen_context_json: unknown; request_sha256: string; distribution_id: string; command_json: unknown; source_outcome_id: string | null; source_ticket: string | null })[]>(`SELECT sc.receive_timezone,sc.receive_window_json,target.frozen_context_json,target.request_sha256,target.distribution_id,distribution.command_json,target.source_outcome_id,target.source_ticket
    FROM execution_distribution_targets target
    INNER JOIN execution_distributions distribution ON distribution.id=target.distribution_id AND distribution.kind='manual_order'
    INNER JOIN strategy_subscriptions s ON s.id=target.subscription_id AND s.user_id=target.target_user_id
      AND s.trading_account_id=target.trading_account_id AND s.revision=target.subscription_revision
      AND s.trader_strategy_id=distribution.strategy_id AND s.trader_strategy_version_id=distribution.strategy_version_id
      AND s.status='active' AND s.trader_enabled=1 AND s.trade_send_enabled=1
    INNER JOIN strategies strategy ON strategy.id=s.trader_strategy_id AND strategy.kind='trader'
      AND strategy.status='active' AND strategy.deleted_at_utc IS NULL AND strategy.active_version_id=s.trader_strategy_version_id
    INNER JOIN trading_accounts account ON account.id=s.trading_account_id AND account.deleted_at_utc IS NULL
    INNER JOIN trading_account_ownerships own ON own.trading_account_id=account.id AND own.user_id=s.user_id
      AND own.role='owner' AND own.revoked_at_utc IS NULL AND own.revision=account.ownership_revision
    INNER JOIN subscription_schedules sc ON sc.subscription_id=s.id
    WHERE target.id=? AND target.target_user_id=? AND target.trading_account_id=? FOR SHARE`, [targetId, userId, accountId])
  if (rows.length !== 1) throw new ExecutionError('execution_subscription_changed', 409)
  await assertWindow(connection, rows[0]!, userId, accountId, now)
  const row = rows[0]!
  let context: unknown, command: unknown
  try {
    context = typeof row.frozen_context_json === 'string' ? JSON.parse(row.frozen_context_json) : row.frozen_context_json
    command = typeof row.command_json === 'string' ? JSON.parse(row.command_json) : row.command_json
  } catch { throw new ExecutionError('execution_schedule_unproven', 409) }
  if (!context || typeof context !== 'object' || Array.isArray(context) || !command || typeof command !== 'object' || Array.isArray(command)) throw new ExecutionError('execution_schedule_unproven', 409)
  const hash = sha256Canonical({ distributionId: row.distribution_id, targetId, command, frozenContext: context, sourceOutcomeId: row.source_outcome_id, sourceTicket: row.source_ticket })
  if (hash !== row.request_sha256) throw new ExecutionError('execution_schedule_unproven', 409)
  const subscription = (context as Record<string, unknown>).subscription
  const frozen = subscription && typeof subscription === 'object' ? (subscription as Record<string, unknown>).windowHash : null
  if (typeof frozen !== 'string' || !/^[a-f0-9]{64}$/.test(frozen)) throw new ExecutionError('execution_schedule_unproven', 409)
  if (frozen !== subscriptionWindowFingerprint(row.receive_window_json, row.receive_timezone)) throw new ExecutionError('execution_schedule_changed', 409)
}

async function assertWindow(connection: PoolConnection, row: { receive_timezone: string; receive_window_json: unknown }, userId: number, accountId: string, now: Date) {
  let decision
  try { decision = evaluateSubscriptionWindow(row.receive_window_json, row.receive_timezone, now, null) }
  catch { throw new ExecutionError('execution_schedule_invalid', 409) }
  if (decision.reason === 'clock_unverified') decision = evaluateSubscriptionWindow(row.receive_window_json, row.receive_timezone, now,
    await readTransactionAccountClock(connection, userId, accountId))
  if (!decision.executionAllowed) throw new ExecutionError('execution_schedule_closed', 409)
}
