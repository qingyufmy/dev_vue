import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  MarketSessionPolicyValidationError,
  canonicalPolicyJson,
  getMarketSessionPolicyMode,
  hashMarketSessionPolicy,
  resetMarketSessionPolicyConfigForTests,
  resolveMarketSessionPolicy,
} from '../../server/routes/ai/market-session-policy.js'
import { classifyMarketClosure } from '../../server/routes/ai/market-session-calendar.js'

const policy = {
  policy_id:'demo-metals',
  version:1,
  platform:'mt5',
  broker_server:'Broker-Demo',
  symbols:['XAUUSD'],
  clock_basis:'broker_time',
  daily_closures:[{ weekdays:[1, 2, 3, 4, 5], from:'00:00', to:'01:00', reason:'daily_maintenance' }],
  weekly_closures:[],
  holiday_closures:[],
  dst_transitions:[],
}

const envFor = (overrides = {}) => ({
  AI_MARKET_SESSION_POLICY_MODE:'enforce',
  AI_MARKET_SESSION_POLICIES_JSON:JSON.stringify([policy]),
  ...overrides,
})

const optionsFor = (overrides = {}) => ({
  intervalMs:5 * 60 * 1000,
  standardSymbol:'XAUUSD',
  platform:'mt5',
  brokerServer:'Broker-Demo',
  clockStatus:'verified',
  startBrokerTime:'2026-07-16 23:55:00',
  endBrokerTime:'2026-07-17 01:00:00',
  env:envFor(),
  ...overrides,
})

describe('market session policy engine', () => {
  beforeEach(() => resetMarketSessionPolicyConfigForTests())

  it('canonicalizes and hashes the normalized policy deterministically', () => {
    const left = { a:1, nested:{ z:true, a:'x' }, list:[{ b:2, a:1 }] }
    const right = { list:[{ a:1, b:2 }], nested:{ a:'x', z:true }, a:1 }
    expect(canonicalPolicyJson(left)).toBe(canonicalPolicyJson(right))
    expect(hashMarketSessionPolicy(left)).toBe(hashMarketSessionPolicy(right))
  })

  it('requires a valid mode and rejects malformed policy JSON', () => {
    expect(() => getMarketSessionPolicyMode({
      AI_MARKET_SESSION_POLICY_MODE:'shadow', AI_MARKET_SESSION_POLICIES_JSON:'[]',
    })).toThrow(MarketSessionPolicyValidationError)
    expect(() => getMarketSessionPolicyMode({
      AI_MARKET_SESSION_POLICY_MODE:'enforce', AI_MARKET_SESSION_POLICIES_JSON:'{',
    })).toThrow(MarketSessionPolicyValidationError)
    expect(() => getMarketSessionPolicyMode({
      AI_MARKET_SESSION_POLICY_MODE:'enforce',
      AI_MARKET_SESSION_POLICIES_JSON:JSON.stringify([{ ...policy, broker_server:'*' }]),
    })).toThrow(MarketSessionPolicyValidationError)
    expect(getMarketSessionPolicyMode({
      AI_MARKET_SESSION_POLICY_MODE:'off', AI_MARKET_SESSION_POLICIES_JSON:'{',
    })).toBe('off')
  })

  it('validates configured policies before database startup', () => {
    const source = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8')
    const validateIndex = source.indexOf('readMarketSessionPolicyConfig()')
    const databaseIndex = source.indexOf('await initDB()')
    expect(validateIndex).toBeGreaterThan(0)
    expect(databaseIndex).toBeGreaterThan(validateIndex)
  })

  it('freezes the process configuration until restart', () => {
    const previousMode = process.env.AI_MARKET_SESSION_POLICY_MODE
    const previousPolicies = process.env.AI_MARKET_SESSION_POLICIES_JSON
    try {
      process.env.AI_MARKET_SESSION_POLICY_MODE = 'off'
      process.env.AI_MARKET_SESSION_POLICIES_JSON = ''
      expect(getMarketSessionPolicyMode()).toBe('off')
      process.env.AI_MARKET_SESSION_POLICY_MODE = 'enforce'
      process.env.AI_MARKET_SESSION_POLICIES_JSON = JSON.stringify([policy])
      expect(getMarketSessionPolicyMode()).toBe('off')
    } finally {
      if (previousMode === undefined) delete process.env.AI_MARKET_SESSION_POLICY_MODE
      else process.env.AI_MARKET_SESSION_POLICY_MODE = previousMode
      if (previousPolicies === undefined) delete process.env.AI_MARKET_SESSION_POLICIES_JSON
      else process.env.AI_MARKET_SESSION_POLICIES_JSON = previousPolicies
      resetMarketSessionPolicyConfigForTests()
    }
  })

  it('matches only the exact platform, broker server and symbol identity', () => {
    const env = envFor()
    const matched = resolveMarketSessionPolicy({ platform:'mt5', broker_server:'Broker-Demo', standard_symbol:'XAUUSD' }, { env })
    expect(matched).toMatchObject({
      matched:true, policy_id:'demo-metals', policy_version:1,
    })
    expect(hashMarketSessionPolicy(matched.policy)).toBe(matched.policy_hash)
    expect(() => { matched.policy.daily_closures.push({}) }).toThrow()
    expect(resolveMarketSessionPolicy({ platform:'mt4', broker_server:'Broker-Demo', standard_symbol:'XAUUSD' }, { env }).matched).toBe(false)
    expect(resolveMarketSessionPolicy({ platform:'mt5', broker_server:'broker-demo', standard_symbol:'XAUUSD' }, { env }).matched).toBe(false)
    expect(resolveMarketSessionPolicy({ platform:'mt5', broker_server:'Broker-Demo', standard_symbol:'EURUSD' }, { env }).matched).toBe(false)
  })

  it('classifies a daily maintenance gap using each bar historical broker offset', () => {
    const result = classifyMarketClosure(
      Date.parse('2026-07-16T20:55:00Z'), Date.parse('2026-07-16T22:00:00Z'), 'M5', optionsFor())
    expect(result).toMatchObject({
      classification:'daily_maintenance', reason:'daily_maintenance', known:true, expected:true,
      missing_bar_count:12, policy_enforced:true, offset_source:'broker_time',
      policy:{ matched:true, policy_id:'demo-metals', policy_version:1 },
    })
    expect(result.components).toEqual([expect.objectContaining({ kind:'daily_maintenance', count:12 })])
    expect(result.uncovered_ranges).toEqual([])
  })

  it('returns the stable real-market-gap reason outside the configured closure', () => {
    const result = classifyMarketClosure(
      Date.parse('2026-07-16T22:00:00Z'), Date.parse('2026-07-16T23:00:00Z'), 'M5', optionsFor({
        startBrokerTime:'2026-07-17 01:00:00', endBrokerTime:'2026-07-17 02:00:00',
      }))
    expect(result).toMatchObject({ classification:'suspicious_gap', reason:'market_open_bars_missing', expected:false })
    expect(result.uncovered_ranges).toHaveLength(1)
    expect(result.uncovered_ranges[0].missing_bar_count).toBe(11)
  })

  it('does not accept a gap whose endpoints are not aligned to the bar interval', () => {
    const result = classifyMarketClosure(
      Date.parse('2026-07-16T20:55:00Z'), Date.parse('2026-07-16T22:01:00Z'), 'M5', optionsFor({
        endBrokerTime:'2026-07-17 01:01:00',
      }))
    expect(result).toMatchObject({ classification:'suspicious_gap', reason:'market_open_bars_missing', expected:false })
  })

  it('requires complete coverage for a composite daily and holiday closure', () => {
    const compositeEnv = envFor({ AI_MARKET_SESSION_POLICIES_JSON:JSON.stringify([{
      ...policy,
      holiday_closures:[{ date:'2026-07-17', from:'01:00', to:'02:00', reason:'holiday_closure' }],
    }]) })
    const result = classifyMarketClosure(
      Date.parse('2026-07-16T20:55:00Z'), Date.parse('2026-07-16T23:00:00Z'), 'M5', optionsFor({
        endBrokerTime:'2026-07-17 02:00:00', env:compositeEnv,
      }))
    expect(result).toMatchObject({ classification:'composite_closure', reason:'composite_closure', expected:true })
    expect(result.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind:'daily_maintenance' }),
      expect.objectContaining({ kind:'holiday_closure' }),
    ]))

    const partial = classifyMarketClosure(
      Date.parse('2026-07-16T20:55:00Z'), Date.parse('2026-07-16T23:05:00Z'), 'M5', optionsFor({
        endBrokerTime:'2026-07-17 02:05:00', env:compositeEnv,
      }))
    expect(partial).toMatchObject({ classification:'suspicious_gap', reason:'market_open_bars_missing', expected:false })
  })

  it('fails closed when enforce mode has no exact matching policy', () => {
    const result = classifyMarketClosure(
      Date.parse('2026-07-16T20:55:00Z'), Date.parse('2026-07-16T22:00:00Z'), 'M5', optionsFor({
        brokerServer:'Other-Broker',
      }))
    expect(result).toMatchObject({ classification:'unknown_session', known:false, reason:'market_session_policy_unavailable' })
  })

  it('audit mode computes policy evidence without enforcing it', () => {
    const result = classifyMarketClosure(
      Date.parse('2026-07-16T20:55:00Z'), Date.parse('2026-07-16T22:00:00Z'), 'M5', optionsFor({
        env:envFor({ AI_MARKET_SESSION_POLICY_MODE:'audit' }),
      }))
    expect(result).toMatchObject({ expected:true, policy_enforced:false, audit_only:true, policy_match:true })
  })
})
