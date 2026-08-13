import crypto from 'node:crypto'

export const STRATEGY_PROMPT_RENDERER_VERSION = 'generic-strategy-policy-prompt-v1'

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

/**
 * Render only data and rules explicitly declared by the strategy policy.
 * This renderer must remain indicator-, timeframe-, and direction-neutral.
 */
export function renderStrategyPolicyPrompt(compiledPolicy, runtime = {}) {
  if (!compiledPolicy || compiledPolicy.mode === 'off') return null
  const payload = {
    policy_hash:compiledPolicy.policy_hash || null,
    indicators:runtime.indicators || {},
    workflow_state:runtime.workflow_state || {},
    prompt_rules:(compiledPolicy.prompt_rules || []).map(rule => ({ id:rule.id, text:rule.text })),
  }
  const text = `## 策略显式声明的结构化数据
以下内容仅来自当前策略的显式声明。它不是服务端补充的交易方法，也不得覆盖策略正文。
请只按策略正文解释这些数据，不要自行增加周期职责、指标权重、方向门槛或交易条件。

${JSON.stringify(payload)}`
  return {
    renderer_version:STRATEGY_PROMPT_RENDERER_VERSION,
    text,
    payload,
    rendered_hash:sha256(text),
  }
}
