import { describe, expect, it } from 'vitest'
import {
  normalizeModelThinkingEnabled,
  modelConnectionValidationError,
  resolveModelConnectionTestConfig,
  resolveModelConnectionTestMaxTokens,
} from '../../server/routes/ai/index.js'

describe('model connection-test request contract', () => {
  it('does not mislabel every provider HTTP 400 as a token-limit rejection', () => {
    expect(modelConnectionValidationError({ providerStatus:400 })).toBe('model_connection_request_rejected')
    expect(modelConnectionValidationError({ providerStatus:401 })).toBe('model_connection_auth_failed')
    expect(modelConnectionValidationError({ providerStatus:429 })).toBe('model_connection_rate_limited')
  })

  it.each([
    ['deepseek', true, 393216, 'high', 'chat_completions'],
    ['deepseek', false, 393216, 'low', 'chat_completions'],
    ['deepseek', true, 120, 'high', 'chat_completions'],
    ['deepseek', false, 200, 'low', 'chat_completions'],
    ['volcengine_agent_plan', true, 393216, 'high', 'responses'],
    ['volcengine_agent_plan', false, 393216, 'low', 'responses'],
    ['volcengine_agent_plan', true, 120, 'high', 'responses'],
    ['volcengine_agent_plan', false, 200, 'low', 'responses'],
  ])('preserves %s thinking=%s, pending max output, and provider protocol', (provider, thinkingEnabled, configuredMaxTokens, reasoningEffort, protocol) => {
    expect(resolveModelConnectionTestConfig({
      provider,
      model_name: provider === 'deepseek' ? 'deepseek-chat' : 'doubao-seed',
      max_output_tokens: configuredMaxTokens,
      thinking_enabled: thinkingEnabled,
      reasoning_effort: reasoningEffort,
    })).toMatchObject({
      provider,
      protocol,
      maxTokens:configuredMaxTokens,
      thinkingEnabled,
      reasoningEffort,
      allowFollowupRequests: false,
    })
  })

  it.each([
    [100, 100], [120, 120], [393216, 393216], [900000, 900000],
  ])('uses configured max_output_tokens=%s without a thinking cap', (configured, expected) => {
    expect(resolveModelConnectionTestMaxTokens({ max_output_tokens: configured, thinking_enabled: true })).toBe(expected)
  })

  it('uses the generic default and ignores legacy max_tokens', () => {
    expect(resolveModelConnectionTestMaxTokens({ thinking_enabled: true })).toBe(393216)
    expect(resolveModelConnectionTestMaxTokens({ max_tokens: 50, thinking_enabled: false })).toBe(393216)
    expect(resolveModelConnectionTestMaxTokens({ max_tokens: 8000, thinking_enabled: false })).toBe(393216)
  })

  it.each([
    [true, true], [1, true], ['1', true], ['true', true],
    [false, false], [0, false], ['0', false], ['false', false], [null, false],
  ])('normalizes persisted thinking_enabled=%j to %s', (value, expected) => {
    expect(normalizeModelThinkingEnabled(value)).toBe(expected)
  })

  it.each([
    ['deepseek', 1, true], ['deepseek', '1', true],
    ['deepseek', 0, false], ['deepseek', '0', false],
    ['volcengine_agent_plan', 1, true], ['volcengine_agent_plan', '1', true],
    ['volcengine_agent_plan', 0, false], ['volcengine_agent_plan', '0', false],
  ])('uses persisted %s thinking=%j without changing max output', (provider, value, expectedThinking) => {
    expect(resolveModelConnectionTestConfig({
      provider, model_name:'probe-model', max_output_tokens:8000, thinking_enabled:value,
    })).toMatchObject({ thinkingEnabled:expectedThinking, maxTokens:8000 })
  })
})
