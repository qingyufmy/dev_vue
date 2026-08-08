import crypto from 'node:crypto'

export const STRATEGY_PROMPT_RENDERER_VERSION = 'ema34-prompt-renderer-v1'

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

export function renderStrategyPolicyPrompt(compiledPolicy, runtime = {}) {
  if (!compiledPolicy || compiledPolicy.mode === 'off') return null
  const payload = {
    enabled:true,
    source:{ timeframe:'M5', field:'close', bar_scope:'closed_only' },
    period:34,
    evidence:runtime.indicators?.entry_ema34 || null,
  }
  const text = `## EMA34 短线证据与新开仓过滤
本策略已开启固定的 M5 EMA34 过滤。只使用以下服务端计算结果，不得自行重算或使用未收盘 K 线。
EMA34 可用于说明价格位置、均线斜率、偏离、持续性和最近穿越，但不计作 M15 确认或 M5 入场触发。
做多新开仓要求最新 M5 已收盘价严格高于 EMA34；做空要求严格低于 EMA34；指标不可用、价格等于均线或方向不符时必须 HOLD。
该规则只过滤新开仓，不得据此退出已有持仓或撤销已有挂单。

${JSON.stringify(payload)}`
  return {
    renderer_version:STRATEGY_PROMPT_RENDERER_VERSION,
    text,
    payload,
    rendered_hash:sha256(text),
  }
}
