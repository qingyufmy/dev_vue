import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  normalizeModelThinkingEnabled,
  resolveModelConnectionTestConfig,
  resolveModelConnectionTestMaxTokens,
} from '../../server/routes/ai/index.js'

const aiApp = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const adminApp = readFileSync(new URL('../../public/admin/app.js', import.meta.url), 'utf8')

describe('model connection-test request budget', () => {
  it.each([
    ['deepseek', true, 8000, 4096, 'high', 'chat_completions'],
    ['deepseek', false, 8000, 256, 'low', 'chat_completions'],
    ['deepseek', true, 120, 120, 'high', 'chat_completions'],
    ['deepseek', false, 200, 200, 'low', 'chat_completions'],
    ['volcengine_agent_plan', true, 8000, 4096, 'high', 'responses'],
    ['volcengine_agent_plan', false, 8000, 256, 'low', 'responses'],
    ['volcengine_agent_plan', true, 120, 120, 'high', 'responses'],
    ['volcengine_agent_plan', false, 200, 200, 'low', 'responses'],
  ])('preserves %s thinking=%s, low caps, and provider protocol', (provider, thinkingEnabled, configuredMaxTokens, maxTokens, reasoningEffort, protocol) => {
    expect(resolveModelConnectionTestConfig({
      provider,
      model_name: provider === 'deepseek' ? 'deepseek-chat' : 'doubao-seed',
      max_tokens: configuredMaxTokens,
      thinking_enabled: thinkingEnabled,
      reasoning_effort: reasoningEffort,
    })).toMatchObject({
      provider,
      protocol,
      maxTokens,
      thinkingEnabled,
      reasoningEffort,
      allowFollowupRequests: false,
    })
  })

  it.each([
    [100, true, 100],
    [100, false, 100],
    [120, true, 120],
    [200, false, 200],
    [9000, true, 4096],
    [9000, false, 256],
  ])('honors configured max_tokens=%s with thinking=%s without exceeding the probe budget', (configured, thinkingEnabled, expected) => {
    expect(resolveModelConnectionTestMaxTokens({ max_tokens: configured, thinking_enabled: thinkingEnabled })).toBe(expected)
  })

  it('normalizes missing and below-minimum caps safely', () => {
    expect(resolveModelConnectionTestMaxTokens({ thinking_enabled: true })).toBe(4096)
    expect(resolveModelConnectionTestMaxTokens({ max_tokens: 50, thinking_enabled: false })).toBe(100)
    expect(resolveModelConnectionTestMaxTokens({ max_tokens: 0, thinking_enabled: false })).toBe(256)
  })

  it.each([
    [true, true], [1, true], ['1', true], ['true', true],
    [false, false], [0, false], ['0', false], ['false', false], [null, false],
  ])('normalizes persisted thinking_enabled=%j to %s', (value, expected) => {
    expect(normalizeModelThinkingEnabled(value)).toBe(expected)
  })

  it.each([
    ['deepseek', 1, true, 4096], ['deepseek', '1', true, 4096],
    ['deepseek', 0, false, 256], ['deepseek', '0', false, 256],
    ['volcengine_agent_plan', 1, true, 4096], ['volcengine_agent_plan', '1', true, 4096],
    ['volcengine_agent_plan', 0, false, 256], ['volcengine_agent_plan', '0', false, 256],
  ])('uses persisted %s thinking=%j for %s connection probes', (provider, value, expectedThinking, expectedMaxTokens) => {
    expect(resolveModelConnectionTestConfig({
      provider, model_name:'probe-model', max_tokens:8000, thinking_enabled:value,
    })).toMatchObject({ thinkingEnabled:expectedThinking, maxTokens:expectedMaxTokens })
  })

  it('localizes probe truncation and missing-JSON errors in both model UIs', () => {
    for (const source of [aiApp, adminApp]) {
      expect(source).toContain('output_truncated')
      expect(source).toContain('ai_response_missing_json_object')
      expect(source).toMatch(/模型连接已建立，但测试输出被截断/)
      expect(source).toMatch(/模型连接已建立，但未返回有效的结构化结果/)
    }
  })
})
