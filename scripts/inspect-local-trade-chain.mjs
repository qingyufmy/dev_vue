// Read-only local evidence: no model calls, queue consumption, or terminal commands.
import assert from 'node:assert/strict'
import { loadServerEnvironment, loadV4RuntimeConfig, createMysqlPool } from '../server/dist-v4/bootstrap/index.js'
import { MysqlExecutionRepository } from '../server/dist-v4/modules/execution/infrastructure/mysql-execution-repository.js'
import { prepareExecutionBundle } from '../server/dist-v4/modules/execution/domain/execution.js'

loadServerEnvironment()
const config = loadV4RuntimeConfig()
assert.equal(config.mysql.host, '192.168.1.254')
assert.equal(config.mysql.database, 'dev_vue')
const pool = createMysqlPool(config.mysql)
let connection
try {
  connection = await pool.getConnection()
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const forbidden = () => { throw Error('read_only_probe_write_forbidden') }
  const repository = new MysqlExecutionRepository({
    execute: (sql, values) => {
      if (!/^\s*SELECT\b/i.test(sql)) forbidden()
      return connection.execute(sql, values)
    },
    getConnection: forbidden,
  }, forbidden, forbidden)
  const [rows] = await connection.query(`SELECT d.id,d.user_id,d.market_analysis_id,d.action_kind,d.status,
    d.created_at_utc,r.status run_status,r.error_code run_error,rd.id risk_id,rd.decision_status risk_status,rd.reject_code,
    (SELECT COUNT(*) FROM execution_intents e WHERE e.trade_decision_id=d.id) intent_count
    FROM trade_decisions d JOIN ai_trader_runs r ON r.id=d.trader_run_id
    LEFT JOIN risk_decisions_v4 rd ON rd.id=d.risk_decision_id
    ORDER BY d.created_at_utc DESC,d.id DESC LIMIT 5`)
  const decisions = []
  for (const row of rows) {
    const { user_id, ...publicRow } = row
    const evidence = { ...publicRow, preparation: 'not_approved' }
    if (row.risk_status === 'approved') {
      const source = await repository.loadApprovedRiskSource(Number(user_id), row.risk_id)
      if (!source) evidence.preparation = 'source_unavailable'
      else {
        evidence.approved_actions = source.approvedActions.length
        try {
          const result = prepareExecutionBundle(source)
          evidence.preparation = result.kind
          // A plan is computed in memory only; nothing is persisted or dispatched.
          if (result.kind === 'noop') evidence.reason = result.reason
        } catch (error) { evidence.preparation = 'blocked'; evidence.reason = error.code || 'preparation_failed' }
      }
    }
    decisions.push(evidence)
  }
  const [analysisRuns] = await connection.query(`SELECT id,status,error_code,created_at_utc,completed_at_utc
    FROM ai_analysis_runs ORDER BY created_at_utc DESC,id DESC LIMIT 5`)
  const [traderRuns] = await connection.query(`SELECT id,market_analysis_id,task_mode,status,error_code,created_at_utc,completed_at_utc
    FROM ai_trader_runs ORDER BY created_at_utc DESC,id DESC LIMIT 5`)
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), database: 'dev_vue',
    mode: 'read_only', writes: 0, terminalCommands: 0, analysisRuns, traderRuns, decisions }, null, 2))
} finally {
  if (connection) { await connection.rollback(); connection.release() }
  await pool.end()
}
