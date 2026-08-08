import { describe, expect, it } from 'vitest'
import { createAutoInferenceRecoveryLogDeduper } from '../../server/ai-recovery-log.js'

describe('auto-inference recovery warning dedupe', () => {
  it('logs first/changed unknown states and terminal recovery, suppressing steady polls', () => {
    const deduper = createAutoInferenceRecoveryLogDeduper()

    expect(deduper.shouldLog({ statusUnknown:1, succeeded:0, stale:0 })).toBe(true)
    expect(deduper.shouldLog({ statusUnknown:1, succeeded:0, stale:0 })).toBe(false)
    expect(deduper.shouldLog({ statusUnknown:2, succeeded:0, stale:0 })).toBe(true)
    expect(deduper.shouldLog({ statusUnknown:2, succeeded:0, stale:0 })).toBe(false)
    expect(deduper.shouldLog({ statusUnknown:1, succeeded:0, stale:1 })).toBe(true)
    expect(deduper.shouldLog({ statusUnknown:0, succeeded:0, stale:0 })).toBe(true)
    expect(deduper.shouldLog({ statusUnknown:0, succeeded:0, stale:0 })).toBe(false)
    expect(deduper.shouldLog({ statusUnknown:0, succeeded:1, stale:0 })).toBe(true)
    expect(deduper.shouldLog({ statusUnknown:0, succeeded:0, stale:0 })).toBe(false)
  })
})
