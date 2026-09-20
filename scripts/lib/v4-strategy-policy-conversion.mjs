import { hash } from './v4-backfill-contract.mjs'
import { parseEma34Plan } from '../../server/dist-v4/modules/strategies/domain/ema34-evidence.js'

// This converter covers the legacy managed EMA data provider only. Any workflow,
// feature, constraint or alternate indicator remains an explicit migration gap.
export function convertStrategyPolicy(raw, emaEnabled) {
  if ((raw !== null && typeof raw !== 'string') || !['0', '1'].includes(emaEnabled)) throw new Error('strategy_policy_source_shape')
  if (raw === null) return { status: 'converted', analysisConfig: {}, problems: [] }
  const unsupported = () => ({ status: 'partial', analysisConfig: {}, problems: [{ field: 'strategy_policy_json', code: 'structured_policy_runtime_mapping_required' }] })
  try {
    const policy = JSON.parse(raw)
    const indicator = policy?.indicators?.[0]
    const plan = parseEma34Plan({ version: 1, timeframe: indicator?.source?.timeframe })
    if (!['off', 'shadow'].includes(policy.mode) || typeof indicator.enabled !== 'boolean') return unsupported()
    const expected = {
      constraints: [], engine_version: 'strategy-policy-engine-v2', features: [],
      indicators: [{ enabled: indicator.enabled, id: 'ema34', kind: 'ema',
        params: { evidence_window: 5, minimum_bars: 34, period: 34, warmup_target_bars: 60 },
        source: { bar_scope: 'closed_only', field: 'close', timeframe: plan.timeframe } }],
      mode: policy.mode, prompt_rules: [], schema_version: 'strategy-policy-v1',
      ui: { groups: [], simple_data_capabilities: { managed_indicator_ids: ['ema34'], version: 'strategy-data-capabilities-v1' } },
      workflow: { default_decision: 'allow', selectors: [], stages: [] },
    }
    if (hash(policy) !== hash(expected)) return unsupported()
    const enabled = policy.mode !== 'off' && indicator.enabled && emaEnabled === '1'
    return { status: 'converted', analysisConfig: enabled ? { ema34_evidence: plan } : {}, problems: [] }
  } catch { return unsupported() }
}
