import crypto from 'node:crypto'

export const STRATEGY_PROMPT_RENDERER_VERSION = 'strategy-prompt-renderer-v2'

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

export function renderStrategyPolicyPrompt(compiledPolicy, runtime = {}) {
  if (!compiledPolicy || compiledPolicy.mode === 'off') return null
  const hasWorkflowStages = Array.isArray(compiledPolicy.workflow?.stages)
    && compiledPolicy.workflow.stages.length > 0
  const payload = {
    schema_version:compiledPolicy.schema_version,
    engine_version:compiledPolicy.engine_version,
    policy_hash:compiledPolicy.policy_hash,
    workflow:compiledPolicy.workflow,
    constraints:compiledPolicy.constraints,
    prompt_rules:compiledPolicy.prompt_rules,
    workflow_state:runtime.workflow_state || null,
    indicators:runtime.indicators || {},
  }
  const workflowInstruction = hasWorkflowStages
    ? '你必须在输出中提供 strategy_policy_trace.stages，并逐项返回已激活阶段的结构化结果；未激活阶段只能标记为 skipped。'
    : '当前政策只包含指标与约束，不要求输出 strategy_policy_trace，也不得凭空编造工作流阶段。'
  const text = `## 当前策略运行政策
以下编译政策与证据属于当前策略；存在 stage 时按 stage 顺序执行，并始终执行 constraint 和 action。
不得执行未激活阶段，不得把 counts_as_trigger=false 的约束计作触发证据。
${workflowInstruction}

${JSON.stringify(payload)}`
  return {
    renderer_version:STRATEGY_PROMPT_RENDERER_VERSION,
    text,
    payload,
    rendered_hash:sha256(text),
  }
}
