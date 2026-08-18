import { describe, expect, it } from 'vitest'
import { buildExecutionClockContext, validateExecutionClockContext } from '../../server/routes/ai/terminal-clock.js'

const now = Date.parse('2026-08-18T12:00:00.000Z')

function context(overrides = {}) {
  return buildExecutionClockContext({
    userId:28,
    tradingAccountId:3,
    terminalInstanceId:'terminal-user-28',
    brokerServer:'UltimaMarkets-Demo',
    login:'18192234189',
    capturedAtUtcMsc:now - 1000,
    clock:{ timezone_offset_minutes:180, clock_status:'mt4_current_offset' },
    ...overrides,
  })
}

describe('execution clock context', () => {
  it('accepts the same account-bound terminal clock captured by risk snapshot', () => {
    expect(validateExecutionClockContext(context(), {
      userId:28, tradingAccountId:3, terminalInstanceId:'terminal-user-28',
      brokerServer:'UltimaMarkets-Demo', login:'18192234189',
    }, now)).toMatchObject({ valid:true, context:{ terminal_instance_id:'terminal-user-28' } })
  })

  it('rejects an observer/bootstrap source even when the offset is otherwise valid', () => {
    const result = validateExecutionClockContext(context({
      clock:{ timezone_offset_minutes:180, clock_status:'observer_bootstrap', clock_source:'default_observer_source' },
    }), {
      userId:28, tradingAccountId:3, terminalInstanceId:'terminal-user-28',
      brokerServer:'UltimaMarkets-Demo', login:'18192234189',
    }, now)
    expect(result).toMatchObject({ valid:false, reason:'execution_clock_untrusted_source' })
  })

  it('rejects stale or cross-account contexts before weekly lock evaluation', () => {
    const stale = validateExecutionClockContext(context({ capturedAtUtcMsc:now - 31_000 }), {
      userId:28, tradingAccountId:3, terminalInstanceId:'terminal-user-28',
      brokerServer:'UltimaMarkets-Demo', login:'18192234189',
    }, now)
    expect(stale).toMatchObject({ valid:false, reason:'execution_clock_stale' })

    const switched = validateExecutionClockContext(context({ userId:99 }), {
      userId:28, tradingAccountId:3, terminalInstanceId:'terminal-user-28',
      brokerServer:'UltimaMarkets-Demo', login:'18192234189',
    }, now)
    expect(switched).toMatchObject({ valid:false, reason:'execution_clock_identity_mismatch' })
  })
})
