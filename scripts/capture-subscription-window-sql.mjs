import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MysqlAnalysisScheduleRepository } from '../server/dist-v4/modules/inference/infrastructure/mysql-analysis-schedule-repository.js'
import { MysqlAnalysisWindowGuard } from '../server/dist-v4/modules/inference/infrastructure/mysql-analysis-window-guard.js'
import { MysqlTraderWindowGuard } from '../server/dist-v4/modules/inference/infrastructure/mysql-trader-window-guard.js'
import { readTransactionAccountClock } from '../server/dist-v4/modules/trading/infrastructure/mysql-transaction-account-clock.js'
import { assertDistributionWindow, assertRiskDecisionWindow } from '../server/dist-v4/modules/execution/infrastructure/mysql-execution-window.js'
import { traderWindowStaleReason } from '../server/dist-v4/modules/inference/infrastructure/mysql-trader-window-evidence.js'

import { readSubscriptionExecutionPreferences } from '../server/dist-v4/modules/strategies/infrastructure/mysql-subscription-execution-preferences.js'

import { MysqlTradingRepository } from '../server/dist-v4/modules/trading/infrastructure/mysql-trading-repository.js'

const queries = []
let name
const db = { async execute(sql, parameters) { queries.push({ name, sql, parameters }); return [[]] },
  async getConnection() { return db }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} }
const capture = async (label, work, expectedError) => {
  name = label
  try { await work(); if (expectedError) throw new Error('expected_rejection_missing') }
  catch (error) { if (error.message !== expectedError) throw error }
}
const run = { trigger: 'scheduled', userId: -1, marketSourceAccountId: '-1', tradingAccountId: '-1', strategyId: '-1', strategyVersionId: '-1',
  symbol: 'SQL_PROBE', subscriptionId: '-1', subscriptionRevision: 1 }
const now = new Date('2000-01-01T00:00:00Z')
await capture('analysis_schedule', () => new MysqlAnalysisScheduleRepository(db).listDue(now.toISOString(), 1))
await capture('analysis_window', () => new MysqlAnalysisWindowGuard(db, async () => null).assertAllowed(run, now), 'analysis_schedule_closed')
await capture('trader_window', () => new MysqlTraderWindowGuard(db).assertAllowed(run, now), 'subscription_revision_conflict')
await capture('clock_provenance', () => readTransactionAccountClock(db, -1, '-1'))
await capture('execution_window', () => assertRiskDecisionWindow(db, 'sql-probe-nonexistent', -1, '-1', now), 'execution_subscription_changed')
await capture('distribution_window', () => assertDistributionWindow(db, 'sql-probe-nonexistent', -1, '-1', now), 'execution_subscription_changed')
await capture('trader_window_evidence', () => traderWindowStaleReason(db, { ...run, inputSnapshotId: 'sql-probe-nonexistent' }))
await capture('subscription_preferences', () => readSubscriptionExecutionPreferences(db, { subscriptionId: '-1', userId: -1, accountId: '-1' }))
await capture('market_candles', () => new MysqlTradingRepository(db).listCandles('-1', 'SQL_PROBE', 'M1', 30))
const source = await readFile(new URL('../server/src/modules/inference/infrastructure/mysql-inference-repository.ts', import.meta.url), 'utf8')
const matches = [...source.matchAll(/execute<WindowSubscriptionRow\[\]>\(`([^`]+)`/g)]
if (matches.length !== 1 || matches[0][1].includes('${')) throw new Error('fanout_query_changed')
queries.push({ name: 'trader_fanout', sql: matches[0][1], parameters: [-1, '-1', 'SQL_PROBE'] })
const distributionSource = await readFile(new URL('../server/src/modules/execution/infrastructure/mysql-execution-distribution-repository.ts', import.meta.url), 'utf8')
const candidateQueries = [...distributionSource.matchAll(/execute<CandidateRow\[\]>\(`([^`]+)`/g)]
if (candidateQueries.length !== 1 || !candidateQueries[0][1].endsWith('${lockClause}')) throw new Error('distribution_candidate_query_changed')
const candidateSql = candidateQueries[0][1].replace('${lockClause}', ' FOR SHARE')
if (candidateSql.includes('${')) throw new Error('distribution_candidate_query_dynamic')
queries.push({ name: 'distribution_candidates', sql: candidateSql, parameters: ['-1', '-1', 'SQL_PROBE'] })
if (queries.length !== 11 || queries.some(query => !query.sql.startsWith('SELECT ') || query.sql.includes(';'))) throw new Error('query_capture_invalid')
const sha = text => createHash('sha256').update(text).digest('hex')
const report = { kind: 'subscription-window-selects/v7', queries: queries.map(query => ({ ...query, sqlSha256: sha(query.sql) })) }
await writeFile(new URL('../docs/migration/subscription-window-sql-input-v7-20260907.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ captured: queries.length }))
