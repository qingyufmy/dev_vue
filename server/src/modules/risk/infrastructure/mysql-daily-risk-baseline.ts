import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { sha256Canonical } from '../../../shared/canonical-json.js'
import { calculateDailyRiskMetrics, type DailyRiskFacts, type DailyRiskBaseline } from '../domain/daily-risk-metrics.js'

interface BaselineRow extends RowDataPacket {
  business_date: string; observed_at: string; day_start_equity: string; equity_high_water: string; net_capital_flow: string
  daily_loss_percent: string; drawdown_percent: string; revision: number; source_hash: string
}
/** Caller owns one transaction spanning verified source reads, baseline and summary writes. */
export async function projectDailyRiskBaseline(connection: Pick<PoolConnection, 'execute'>,
  userId: number, facts: DailyRiskFacts, expectedRevision: number | null) {
  const [accounts] = await connection.execute<RowDataPacket[]>(
    'SELECT id FROM trading_accounts WHERE id=? AND deleted_at_utc IS NULL FOR UPDATE', [facts.accountId])
  if (accounts.length !== 1) throw Error('daily_risk_account_forbidden')
  const [owners] = await connection.execute<RowDataPacket[]>(`SELECT o.user_id FROM trading_account_ownerships o
    INNER JOIN trading_accounts a ON a.id=o.trading_account_id AND a.ownership_revision=o.revision
    INNER JOIN users u ON u.id=o.user_id AND u.deletion_status='active' AND u.deleted_at IS NULL
    WHERE o.trading_account_id=? AND o.user_id=? AND o.interval_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL FOR SHARE`,
  [facts.accountId, userId, facts.ownershipIntervalId])
  if (owners.length !== 1) throw Error('daily_risk_account_forbidden')
  const [rows] = await connection.execute<BaselineRow[]>(`SELECT DATE_FORMAT(business_date,'%Y-%m-%d') business_date,
    DATE_FORMAT(observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') observed_at,
    day_start_equity,equity_high_water,net_capital_flow,daily_loss_percent,drawdown_percent,revision,source_hash
    FROM account_daily_risk_baselines WHERE trading_account_id=? AND ownership_interval_id=?
    ORDER BY business_date DESC LIMIT 1 FOR UPDATE`, [facts.accountId, facts.ownershipIntervalId])
  const current = rows[0]
  const sameDay = current?.business_date === facts.businessDate
  const revision = sameDay ? Number(current!.revision) : null
  const hash = sha256Canonical(facts)
  if (sameDay && current!.source_hash === hash) return { applied: false, revision: revision!,
    dailyLossPercent: Number(current!.daily_loss_percent), drawdownPercent: Number(current!.drawdown_percent) }
  if (revision !== expectedRevision || revision !== null && (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER)) throw Error('daily_risk_revision_conflict')
  const previous: DailyRiskBaseline | null = current ? { accountId: facts.accountId, ownershipIntervalId: facts.ownershipIntervalId,
    businessDate: current.business_date, observedAt: current.observed_at.replace(/(\.\d{3})000Z$/, '$1Z'),
    dayStartEquity: current.day_start_equity, equityHighWater: current.equity_high_water, netCapitalFlow: current.net_capital_flow } : null
  if (previous?.observedAt === facts.observedAt) throw Error('daily_risk_snapshot_conflict')
  const result = calculateDailyRiskMetrics(facts, previous)
  const nextRevision = (revision ?? 0) + 1
  await connection.execute(`INSERT INTO account_daily_risk_baselines
    (trading_account_id,ownership_interval_id,business_date,day_start_equity,equity_high_water,net_capital_flow,
      daily_loss_percent,drawdown_percent,source_hash,observed_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE day_start_equity=VALUES(day_start_equity),equity_high_water=VALUES(equity_high_water),
      net_capital_flow=VALUES(net_capital_flow),daily_loss_percent=VALUES(daily_loss_percent),drawdown_percent=VALUES(drawdown_percent),
      source_hash=VALUES(source_hash),observed_at_utc=VALUES(observed_at_utc),revision=VALUES(revision)`,
  [facts.accountId, facts.ownershipIntervalId, facts.businessDate, result.baseline.dayStartEquity,
    result.baseline.equityHighWater, result.baseline.netCapitalFlow, result.dailyLossPercent, result.drawdownPercent,
    hash, new Date(facts.observedAt), nextRevision])
  return { applied: true, revision: nextRevision, dailyLossPercent: result.dailyLossPercent, drawdownPercent: result.drawdownPercent }
}
