import { describe, expect, it } from 'vitest'

import { deriveAdminAiHealth } from '../../server/admin/ai-operations.js'

const successfulUsage = (usage, requestCount = 1) => ({
  usage,
  request_count:requestCount,
  failure_count:0,
  last_request_at:'2026-08-06T04:00:00.000Z',
  last_success_at:'2026-08-06T04:00:00.000Z',
})

describe('administrator AI health derivation', () => {
  it('reports insufficient data instead of healthy when there is no sample or runtime expectation', () => {
    const result = deriveAdminAiHealth({ nowMs:Date.parse('2026-08-06T05:00:00.000Z') })
    expect(result).toMatchObject({ state:'insufficient_data', sample_count:0, window:'24h' })
    expect(result.components.manual.state).toBe('insufficient_data')
  })

  it('does not let successful manual or compare requests hide an expected automatic scheduler outage', () => {
    const result = deriveAdminAiHealth({
      usageRows:[successfulUsage('manual', 4), successfulUsage('model_compare', 2)],
      schedulerConfiguredCount:1,
      schedulerRuntimeAvailable:false,
    })
    expect(result.state).toBe('critical')
    expect(result.components.auto_inference).toMatchObject({ expected:true, state:'critical', sample_count:0 })
    expect(result.reasons).toContainEqual(expect.objectContaining({ code:'scheduler_runtime_unavailable', component:'auto_inference' }))
  })

  it('keeps independent usage components and aggregates expected healthy chains', () => {
    const result = deriveAdminAiHealth({
      usageRows:[successfulUsage('auto_platform', 3), successfulUsage('review', 2)],
      schedulerConfiguredCount:1,
      schedulerRuntimeAvailable:true,
      schedulerRuntime:[{ state_updated_at_utc:'2026-08-06T04:59:00.000Z' }],
      reviewHealth:{ jobs:[{ status:'queued', job_count:1 }], cases:[] },
    })
    expect(result.state).toBe('healthy')
    expect(result.components.auto_inference).toMatchObject({ expected:true, state:'healthy', sample_count:3 })
    expect(result.components.review).toMatchObject({ expected:true, state:'healthy', sample_count:2 })
  })

  it('promotes signal failures even when model calls succeeded', () => {
    const result = deriveAdminAiHealth({
      usageRows:[successfulUsage('auto_private', 3)],
      schedulerConfiguredCount:1,
      schedulerRuntimeAvailable:true,
      signalErrors24h:2,
    })
    expect(result.state).toBe('attention')
    expect(result.components.auto_inference.state).toBe('attention')
    expect(result.reasons).toContainEqual(expect.objectContaining({ code:'signal_errors_24h', value:2 }))
  })

  it('marks an active observer channel critical only when its authoritative source is unavailable', () => {
    const base = {
      observer:{
        channels:[{ id:1, source_id:8, status:'active' }],
        sources:[{ id:8, status:'active', bridge_online:false }],
      },
    }
    expect(deriveAdminAiHealth(base).components.observer_delivery.state).toBe('critical')
    expect(deriveAdminAiHealth({ observer:{ channels:[], sources:[] } }).components.observer_delivery.state).toBe('insufficient_data')
  })

  it('degrades recent on-demand failures without using successful idle components to paint the system green', () => {
    const result = deriveAdminAiHealth({
      usageRows:[{ ...successfulUsage('manual', 2), failure_count:1 }],
    })
    expect(result.state).toBe('attention')
    expect(result.components.manual).toMatchObject({ expected:false, state:'attention' })
  })
})
