import { describe, expect, it } from 'vitest'
import {
  buildPolicySource,
  buildReplaySourceIdentity,
  dataQuality,
} from '../experiments/deepseek-v4-pro-0813-bilingual-week-backtest/scripts/build_market_context.mjs'
import { prepareStrategyDataRuntime } from '../../server/routes/ai/strategy-policy.js'

describe('historical replay source identity', () => {
  const marketData = {
    schema_version:'market-data-v1',
    symbol:'XAUUSD.s',
    standard_symbol:'XAUUSD',
    market_data_sha256:'a'.repeat(64),
    clock:{ broker_offset_seconds:10_800 },
  }

  it('is stable for one frozen dataset, distinct for another, and remains a safe positive integer', () => {
    const first = buildReplaySourceIdentity(marketData)
    const same = buildReplaySourceIdentity(structuredClone(marketData))
    const different = buildReplaySourceIdentity({
      ...marketData,
      market_data_sha256:'b'.repeat(64),
    })

    expect(first).toEqual(same)
    expect(first.source_identity_mode).toBe('historical_replay_synthetic')
    expect(Number.isSafeInteger(first.source_id)).toBe(true)
    expect(first.source_id).toBeGreaterThan(0)
    expect(first.source_key).toContain('historical_replay_synthetic|market_data_sha256:')
    expect(different.source_key).not.toBe(first.source_key)
    expect(different.source_id).not.toBe(first.source_id)
  })

  it('hashes stable bar data when the frozen dataset hash is absent', () => {
    const fallback = {
      schema_version:'market-data-v1',
      symbol:'XAUUSD.s',
      timeframes:{ M15:{ timeframe:'M15', minutes:15, bars:[{
        time_utc_msc:1_800_000_000_000, open:100, high:102, low:99, close:101,
      }] } },
    }
    const same = buildReplaySourceIdentity(structuredClone(fallback))
    const changed = buildReplaySourceIdentity({
      ...fallback,
      timeframes:{ M15:{ ...fallback.timeframes.M15, bars:[{ ...fallback.timeframes.M15.bars[0], close:101.1 }] } },
    })

    expect(same).toEqual(buildReplaySourceIdentity(fallback))
    expect(same.dataset_hash_source).toBe('stable_dataset_identity')
    expect(changed.source_key).not.toBe(same.source_key)
  })

  it('uses the synthetic identity in Chan data quality and declared policy sources', () => {
    const identity = buildReplaySourceIdentity(marketData)
    const quality = dataQuality(marketData, 1_800_000_000_000, 'M15', { bars:[{}] }, identity)
    const policySource = buildPolicySource('M15', [
      { time_utc_msc:1_799_999_100_000, close:100 },
      { time_utc_msc:1_799_999_700_000, close:101 },
    ], 1_800_000_000_000, identity, 1_800_000)

    expect(quality).toMatchObject({
      source_id:identity.source_id,
      source_key:identity.source_key,
      source_identity_mode:'historical_replay_synthetic',
    })
    expect(policySource).toMatchObject({
      sourceId:identity.source_id,
      sourceKey:identity.source_key,
      sourceIdentityMode:'historical_replay_synthetic',
      source_id:identity.source_id,
      source_key:identity.source_key,
      source_identity_mode:'historical_replay_synthetic',
    })

    const runtime = prepareStrategyDataRuntime({
      compiledPolicy:{
        mode:'enforce', schema_version:'strategy-policy-v1', policy_hash:'policy-hash',
        engine_version:'strategy-policy-engine-v2', constraints:[], features:[],
        prompt_rules:[], workflow:{ default_decision:'allow', selectors:[], stages:[] },
        indicators:[{
          id:'entry_ema34', kind:'ema', enabled:true,
          source:{ timeframe:'M15', field:'close', bar_scope:'closed_only' },
          params:{ period:2, minimum_bars:2, warmup_target_bars:2, evidence_window:2 },
        }],
      },
    }, { policyIndicatorSources:{ M15:policySource } })
    expect(runtime.input_sources.M15).toMatchObject({
      source_id:identity.source_id,
      bar_count:2,
      last_bar_closed:true,
    })
  })
})
