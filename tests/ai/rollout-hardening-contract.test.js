import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const admin = readFileSync(new URL('../../server/routes/admin.js', import.meta.url), 'utf8')
const auth = readFileSync(new URL('../../server/middleware/auth.js', import.meta.url), 'utf8')
const migrations = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
const config = readFileSync(new URL('../../server/routes/ai/config.js', import.meta.url), 'utf8')
const rollout = readFileSync(new URL('../../server/routes/ai/rollout-governance.js', import.meta.url), 'utf8')
const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
const strategy = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')
const preferences = readFileSync(new URL('../../server/routes/ai/inference-preferences.js', import.meta.url), 'utf8')

describe('rollout hardening contract', () => {
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

  it('anonymizes deleted accounts, destroys credentials and preserves trading evidence', () => {
    const deleteRoute = admin.slice(admin.indexOf("router.delete('/admin-users/:id'"), admin.indexOf("router.get('/admin-audit'"))
    expect(deleteRoute).toContain("deletion_status = 'anonymized'")
    expect(deleteRoute).toContain('api_key_encrypted = NULL')
    expect(deleteRoute).not.toContain('DELETE FROM users')
    expect(deleteRoute).not.toContain('DELETE FROM trade_audit_logs')
    expect(deleteRoute).not.toContain('DELETE FROM orders')
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

  it('shares only market data from the administrator Bridge', () => {
    expect(bridge).toContain("_source: 'admin_market_fallback'")
    expect(bridge).toContain("const readActions = ['rates', 'symbols', 'quote']")
    expect(bridge).not.toContain("ai.mt5Bridge(adminUserId, 'account'")
    expect(bridge).not.toContain("ai.mt5Bridge(adminUserId, 'positions'")
    expect(bridge).not.toContain("ai.mt5Bridge(adminId, 'pending_list'")
    expect(bridge).toContain('const sigUserId = userId')
    expect(bridge).toContain('getCloseSignalTickets(userId)')
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
})
