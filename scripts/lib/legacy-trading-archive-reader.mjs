import assert from 'node:assert/strict'

// Local archive inspection only. These retained facts never enter a V4 worker.
// No source_id parsing, ticket/time guesses, or current-owner substitution.
const columns = {
  ai_signals: 'id,user_id,prompt_type_id,symbol,timeframe,signal_type,analysis,reasoning,decision_json,inference_task_id,created_at,created_at_utc_msc',
  inference_snapshots_legacy_v3: 'id,signal_id,strategy_id,strategy_version,owner_user_id,system_prompt,user_prompt,prompt_hash,content_hash,evidence_status,created_at',
  ai_model_tasks_legacy_v3: 'task_id,owner_user_id,strategy_id,task_kind,status,result_ref,result_hash,error_code,created_at_utc_msc,completed_at_utc_msc',
  auto_signal_deliveries: 'id,signal_id,user_id,execution_status,order_intent_id,risk_decision_id,trade_ticket,pending_ticket,created_at',
  order_intents: 'id,user_id,trading_account_id,source_type,source_id,action,symbol,status,risk_decision_id,trade_ticket,pending_ticket,created_at,completed_at',
  signal_outcomes: 'id,signal_id,delivery_id,order_intent_id,user_id,trading_account_id,status,entry_volume,closed_volume,gross_profit,commission,swap,fee,net_profit,created_at',
}

export async function readLegacySignalArchive(db, { userId, signalId }) {
  // Zero identifies retained system-owned records for this local administrative tool.
  // It is never translated into an authenticated V4 user or browser permission.
  assert.ok(Number.isSafeInteger(userId) && userId >= 0, 'archive_user_invalid')
  assert.match(signalId, /^[1-9][0-9]{0,19}$/, 'archive_signal_invalid')
  const [signals] = await db.execute(`SELECT ${columns.ai_signals} FROM ai_signals WHERE id=? AND user_id=?`, [signalId, userId])
  if (!signals.length) return null
  const signal = signals[0]
  const [snapshots] = await db.execute(`SELECT ${columns.inference_snapshots_legacy_v3} FROM inference_snapshots_legacy_v3 WHERE signal_id=? AND owner_user_id=? ORDER BY id`, [signalId, userId])
  const [tasks] = signal.inference_task_id
    ? await db.execute(`SELECT ${columns.ai_model_tasks_legacy_v3} FROM ai_model_tasks_legacy_v3 WHERE task_id=? AND owner_user_id=?`, [signal.inference_task_id, userId])
    : [[]]
  const [deliveries] = await db.execute(`SELECT ${columns.auto_signal_deliveries} FROM auto_signal_deliveries WHERE signal_id=? AND user_id=? ORDER BY id`, [signalId, userId])
  const [outcomes] = await db.execute(`SELECT ${columns.signal_outcomes} FROM signal_outcomes WHERE signal_id=? AND user_id=? ORDER BY id`, [signalId, userId])
  const intentIds = [...new Set([...deliveries, ...outcomes].map(row => row.order_intent_id).filter(id => id !== null).map(String))]
  const intents = []
  for (const id of intentIds) {
    const [rows] = await db.execute(`SELECT ${columns.order_intents} FROM order_intents WHERE id=? AND user_id=?`, [id, userId])
    intents.push(...rows)
  }
  const known = new Set(intents.map(row => String(row.id)))
  return { kind: 'legacy-signal-archive/v1', executable: false, timeConvention: 'UTC',
    identityNamespace: 'retained-legacy', signal, snapshots, tasks, deliveries, outcomes, intents,
    unresolvedIntentIds: intentIds.filter(id => !known.has(id)),
    // A retained snapshot is not a new market_analysis; original IDs stay original.
    v4RuntimeIds: null }
}

export async function readLegacyExecutionArchive(db, { userId, intentId }) {
  assert.ok(Number.isSafeInteger(userId) && userId > 0, 'archive_user_invalid')
  assert.match(intentId, /^[1-9][0-9]{0,19}$/, 'archive_intent_invalid')
  const [intents] = await db.execute(`SELECT ${columns.order_intents} FROM order_intents WHERE id=? AND user_id=?`, [intentId, userId])
  if (!intents.length) return null
  const intent = intents[0]
  const [deliveries] = await db.execute(`SELECT ${columns.auto_signal_deliveries} FROM auto_signal_deliveries WHERE order_intent_id=? AND user_id=? ORDER BY id`, [intentId, userId])
  const [outcomes] = await db.execute(`SELECT ${columns.signal_outcomes} FROM signal_outcomes WHERE order_intent_id=? AND user_id=? AND trading_account_id=? ORDER BY id`, [intentId, userId, intent.trading_account_id])
  const [risks] = await db.execute('SELECT id,order_intent_id,decision_status,reject_code,created_at FROM risk_decisions WHERE order_intent_id=? ORDER BY id', [intentId])
  const deals = []
  for (const outcome of outcomes) {
    const [rows] = await db.execute('SELECT id,outcome_id,user_id,trading_account_id,deal_ticket,position_id,order_ticket,volume,price,profit,commission,swap,fee,deal_time FROM signal_outcome_deals WHERE outcome_id=? AND user_id=? AND trading_account_id=? ORDER BY id', [outcome.id, userId, intent.trading_account_id])
    deals.push(...rows)
  }
  return { kind: 'legacy-execution-archive/v1', executable: false, timeConvention: 'UTC', identityNamespace: 'retained-legacy',
    intent, deliveries, outcomes, risks, deals, v4RuntimeIds: null }
}
