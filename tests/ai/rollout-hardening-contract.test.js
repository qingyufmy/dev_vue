import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const admin = readFileSync(new URL('../../server/routes/admin.js', import.meta.url), 'utf8')
const auth = readFileSync(new URL('../../server/middleware/auth.js', import.meta.url), 'utf8')
const migrations = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
const db = readFileSync(new URL('../../server/db.js', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
const config = readFileSync(new URL('../../server/routes/ai/config.js', import.meta.url), 'utf8')
const rollout = readFileSync(new URL('../../server/routes/ai/rollout-governance.js', import.meta.url), 'utf8')
const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
const strategy = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
const strategyOwnership = readFileSync(new URL('../../server/routes/ai/strategy-ownership.js', import.meta.url), 'utf8')
const preferences = readFileSync(new URL('../../server/routes/ai/inference-preferences.js', import.meta.url), 'utf8')
const userDeletion = readFileSync(new URL('../../server/admin/user-deletion.js', import.meta.url), 'utf8')

describe('rollout hardening contract', () => {
  it('persists every supported entry method without truncation', () => {
    expect(migrations).toContain("id: '082_expand_ai_signal_entry_method'")
    expect(migrations).toContain("MODIFY COLUMN entry_method VARCHAR(20) DEFAULT 'market'")
    expect(db).toContain("entry_method VARCHAR(20) DEFAULT 'market'")
  })
  it('repairs deterministic MT5 rejections without inventing order tickets', () => {
    expect(migrations).toContain("id: '083_reject_deterministic_mt5_errors'")
    expect(migrations).toContain("oi.trade_ticket IS NULL AND oi.pending_ticket IS NULL")
    expect(migrations).toContain("rr.status = 'released'")
    expect(migrations).toContain("d.execution_status = 'rejected'")
  })

  it('backfills durable risk decision links for intents and deliveries', () => {
    expect(migrations).toContain("id: '086_backfill_risk_decision_links'")
    expect(migrations).toContain('SET oi.risk_decision_id = rd.id')
    expect(migrations).toContain('SET d.risk_decision_id = oi.risk_decision_id')
  })

  it('promotes legacy pending risk changes into an immediately active version', () => {
    expect(migrations).toContain("id: '087_apply_pending_risk_changes_immediately'")
    expect(migrations).toContain("SET status = 'applied', effective_at = ?")
    expect(migrations).toContain("'待生效风控参数改为立即生效'")
  })
  it('adds the readiness-tracked rollout migration and defaults generative features off', () => {
    expect(migrations).toContain("id: '065_ai_rollout_governance'")
    expect(migrations).toContain("VALUES ('global', 0, 0, 0, 0, 1, 0")
    expect(rollout).toContain('065_ai_rollout_governance')
    expect(rollout).toContain('066_paired_inference_evidence')
    expect(rollout).toContain('067_manual_inference_snapshots')
    expect(rollout).toContain('068_inference_preferences')
  })

  it('persists manual inference evidence atomically and keeps paired control outside execution', () => {
    const analyze = strategy.slice(strategy.indexOf('export async function handleAnalyze'))
    expect(analyze).toContain('await withTransaction(async run =>')
    expect(analyze).toContain('await persistInferenceSnapshotTx(run, {')
    expect(analyze).toContain('strategyScope: strategy.scope')
    expect(analyze).toContain('strategyId: Number(strategy.id)')
    expect(analyze).toContain('INSERT INTO ai_signals(user_id, prompt_type_id, source, session_id')
    expect(analyze).toContain("VALUES (?, ?, 'manual'")
    expect(analyze).toContain("signal._inference_source === 'ai_error_hold'")
    expect(analyze).toContain("error_code: 'ai_inference_failed'")
    expect(analyze).toContain('attachMemoryInjectionSignal(memory.logId, userId, signal.id, persisted.snapshotId)')
    const paired = analyze.slice(analyze.indexOf("if (strategy.scope === 'private' && memory.pairedExperimentEnabled"))
    expect(paired).toContain("_memoryContext: ''")
    expect(paired).toContain('recordPairedInferenceRun')
    expect(paired).not.toContain('executeOrder(')
  })

  it('keeps every provider request behind the metered JSON request path', () => {
    expect(scheduler).not.toContain('await fetch(')
    expect(scheduler).toContain('await requestJsonObject({')
    expect(scheduler).toContain("usage: 'manual'")
  })

  it('checks scheduler cooldown before repeated database and model resolution work', () => {
    const tick = scheduler.slice(scheduler.indexOf('const tick = async () =>'), scheduler.indexOf('const lockToken = await acquireLock(key)'))
    expect(tick.indexOf('redis.ttl')).toBeLessThan(tick.indexOf('getAutoSubscribers'))
    expect(tick.indexOf('redis.ttl')).toBeLessThan(tick.indexOf('getUnifiedAutoInferenceConfig'))
    expect(tick).toContain('Math.min(ttl * 1000, 30000)')
    expect(scheduler).toContain('config: resolvedConfig')
    expect(scheduler).toContain('let config = preflight.config || null')
  })

  it('anonymizes deleted accounts, destroys credentials and preserves trading evidence', () => {
    const deleteRoute = admin.slice(admin.indexOf("router.delete('/admin-users/:id'"), admin.indexOf("router.get('/admin-audit'"))
    expect(deleteRoute).toContain('anonymizeAdminUser')
    expect(userDeletion).toContain("deletion_status = 'anonymized'")
    expect(userDeletion).toContain('api_key_encrypted = NULL')
    expect(userDeletion).not.toContain('DELETE FROM users')
    expect(userDeletion).not.toContain('DELETE FROM trade_audit_logs')
    expect(userDeletion).not.toContain('DELETE FROM orders')
    expect(auth).toContain("deletion_status = 'active'")
  })

  it('separates inference preferences from credentials and removes legacy websocket writes', () => {
    expect(preferences).toContain('INSERT INTO ai_inference_preferences')
    expect(preferences).not.toContain('api_key')
    expect(bridge).not.toContain("case 'save_config'")
    expect(bridge).not.toContain("case 'get_auto_config'")
    expect(bridge).not.toContain('UPDATE ai_configs SET session_id = session_id')
    expect(config).toContain("upsertDefaultModelProfileFromLegacyInput(userId, 'user'")
  })

  it('synchronizes the persisted trade switch into every newly connected Bridge', () => {
    expect(bridge).toContain("sendBridgeCommand(userId, 'toggle_trade', { enable: defaultTrade }")
    expect(bridge).toContain('Failed to synchronize trade state')
  })

  it('projects the authorized observer channel source without routing writes to it', () => {
    expect(bridge).toContain("_source: 'admin_market_fallback'")
    expect(bridge).toContain("const readActions = ['rates', 'symbols', 'quote']")
    expect(bridge).toContain('resolveObserverBridgeContext(userId, user, params.observer_channel_id)')
    expect(bridge).toContain("const dataUserId = access.mode === 'observer' ? observerContext.bridgeUserId : userId")
    expect(bridge).toContain("observerWsActionAllowed(access, action)")
    expect(bridge).toContain("ai.mt5Bridge(dataUserId, 'account', {}, { noFallback:true })")
    expect(bridge).toContain("ai.mt5Bridge(dataUserId, 'positions', {}, { noFallback:true })")
    expect(bridge).toContain("ai.mt5Bridge(dataUserId, 'pending_list', { symbol }, { noFallback:true })")
    expect(bridge).toContain("ai.mt5Bridge(userId, 'toggle_trade'")
    expect(bridge).toContain("ai.executeOrderCore(userId")
  })

  it('gives complete history queries a queue-aware Bridge timeout', () => {
    expect(bridge).toContain("'history', bridgeParams, { timeoutMs: 30000, noFallback: true }")
    expect(bridge).toContain("'chart_data', chartParams, { timeoutMs: 30000, noFallback: true }")
  })

  it('keeps full MT5 history out of the real-time risk path', () => {
    const start = config.indexOf('loadRiskContext: async')
    const end = config.indexOf('enrichRequest:', start)
    const block = config.slice(start, end)
    expect(migrations).toContain("id: '078_incremental_risk_snapshot'")
    expect(migrations).toContain("id: '079_incremental_risk_snapshot_baseline'")
    expect(migrations).toContain('SET last_risk_snapshot_at = updated_at')
    expect(block).toContain("bridge(actorId, 'risk_snapshot'")
    expect(block).toContain('last_deal_time_msc')
    expect(block).toContain('COALESCE(ras.last_risk_snapshot_at, ras.updated_at, ta.first_verified_at)')
    expect(block).not.toContain("bridge(actorId, 'history'")
    expect(block).not.toContain("bridge(actorId, 'positions'")
    expect(block).not.toContain("bridge(actorId, 'pending_list'")
  })

  it('does not query review bodies or memory lesson text in administrator health metrics', () => {
    const health = rollout.slice(rollout.indexOf('export async function getAiRolloutHealth'))
    expect(health).not.toMatch(/content_json|evidence_json|lesson_text|api_key_encrypted/)
  })

  it('enforces one active model default and one executing subscription per user', () => {
    expect(migrations).toContain("id: '098_ai_runtime_active_uniqueness'")
    expect(migrations).toContain('uk_model_active_default_owner')
    expect(migrations).toContain('uk_subscription_active_execution_user')
    expect(migrations).toContain('STORED INVISIBLE')
    expect(strategyOwnership).toContain('FROM users WHERE id = ? FOR UPDATE')
  })

  it('tracks one current platform owner for each MT5 server and login identity', () => {
    expect(migrations).toContain("id: '115_mt5_account_current_owner'")
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS mt5_account_bindings')
    expect(migrations).toContain('PRIMARY KEY (broker_server_key, login_account)')
    expect(migrations).toContain('current_trading_account_id')
  })
})
