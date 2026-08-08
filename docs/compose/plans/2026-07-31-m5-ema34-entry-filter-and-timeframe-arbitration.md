# 通用策略规则引擎与目标策略配置实施方案

> 状态：已按“系统代码必须策略无关”原则完成架构修订，待确认后实施
>
> 审查基线：`dev_codex` @ `71657a979a78c250dd637cd432bee0ce92578846`
>
> 目标策略实例：M15 主判、M15 不明确时 H1 回退、M15 确认、M5 触发、可选 EMA34 入场过滤
>
> 本文是实施方案，不代表功能已经上线。

## 1. 本次架构纠正

系统代码是所有策略共用的运行平台，不能出现只属于某一份策略的周期、指标参数或方向判断。上一版方案提出的专用字段：

```text
use_m5_ema34_entry_filter
trend_timeframe_policy_json
```

不再采用。也禁止在公共代码中出现以下实现方式：

```js
if (timeframe === 'M15') { ... }
if (m15Unclear) useH1()
if (side === 'buy' && m5Close <= ema34) hold()
if (strategyId === 1) { ... }
```

正确设计是：

1. 系统提供通用的策略政策模型、指标注册表、工作流执行器、条件表达式执行器、提示规则渲染器和审计能力。
2. M15、H1、M5、EMA、34、Buy 在均线上方和 Sell 在均线下方，全部只存在于目标策略自己的结构化配置中。
3. 公共代码只解释经过白名单验证的通用定义，不知道当前运行的是哪套交易思想。
4. 没有新政策配置的旧策略继续走原有路径，行为保持不变。
5. 目标策略只是通用引擎中的一份配置实例，不是系统代码中的特殊分支。

## 2. 当前代码事实

### 2.1 没有正在运行的“1H 主判、4H 回退”专用判别

`server/routes/ai/strategy.js:531-550` 的 `buildStrategyContext()` 在 547 行包含：

```text
1H trend primary, 4H fallback only if 1H unclear, M15 signal confirmation, M5 precise entry trigger
```

仓库静态引用检查只找到该函数定义本身，没有生产调用方，也没有从 `server/routes/ai/index.js` re-export。它目前属于无调用的遗留 helper/描述字符串，不会限制现有策略运行。

这项只能列为清理候选；在没有生产动态调用证据前，不把它直接定义为可安全删除文件。

### 2.2 活动路径按每个策略自己的配置取数

实际运行的是 `buildStrategyContextFromTags()`：

- `strategy.js:553-561`：读取当前策略的 `marketDataPlan.timeframes`。
- `strategy.js:566-614`：只对该策略配置的周期取数和计算。
- `strategy.js:616`：把实际周期拼成 `strategy_sequence`。
- 手动分析调用：`strategy.js:657-695`。
- 自动分析调用：`config.js:255-292` → `scheduler.js:1382-1401`。
- 实时模型比较调用：`strategy.js:955-977`。

现有 `fallbackTimeframe` 参数名容易误导；三个活动调用实际传入的是 `primaryTf`，它不是“趋势回退周期”。应在后续安全重构中改名为 `primaryTimeframe`，但不得与本次规则变更混成未经验证的行为修改。

### 2.3 当前活动行为是通用 Chan 多周期 alignment

`buildChanTimeframeAlignment()` 位于 `strategy.js:442-493`。它会：

- 把当前策略所有可靠的 Chan 周期按大小排序。
- 选择最大可靠周期作为 higher timeframe。
- 汇总所有可靠周期方向。
- 将买卖点与 higher timeframe 对齐。

`strategy.js:621` 只在当前策略 `use_chan_analysis=true` 时构造该对象。`llm.js:108-112` 会要求 mixed/conflict/partial 时降低强度或观望，`llm.js:1218-1225` 还会把 mixed/insufficient 的仓位证据上限压到 probe。

因此当前真正共享的是“通用全周期共振”，不是“1H 主判/4H 回退”。如果把这个公共函数直接改成固定 M15/H1，H1/H4、M30、单周期及其他自定义策略都会发生语义变化。

### 2.4 与趋势仲裁无关的 H1/H4 代码

`strategy.js:25` 的 `ATR_ANCHOR_PRIORITY=['H1','H4']` 和 `strategy.js:498-528` 的 H1 ATR 回退属于统一风险波动率锚，不是趋势主判/回退规则。本批不把它误判为旧策略逻辑，也不顺带修改其业务合同。

## 3. 不可违反的系统边界

| 系统代码可以做 | 系统代码不能做 |
|---|---|
| 根据策略配置请求任意合法周期 | 固定 M15、H1、M5 为某种角色 |
| 根据通用指标定义计算 EMA、SMA、MACD 等 | 固定 EMA34 是所有策略的入场条件 |
| 执行白名单条件表达式 `gt/lt/eq/in/all/any` | 写死 Buy 必须在 EMA34 上方 |
| 执行通用阶段依赖和状态转移 | 写死 M15 unclear 才启用 H1 |
| 根据通用 policy 渲染提示规则 | 在 `llm.js` 常量中写目标策略专用正文 |
| 冻结当前策略的编译政策和证据 | 从策略标题、ID 或提示词关键词猜规则 |
| 只阻断当前无效策略实例 | 因一个策略配置错误让全局调度器退出 |

目标策略相关常量只能出现在：

- 该策略的 `strategy_policy_json`。
- 该策略的提示词正文。
- 目标策略测试 fixture 和验收数据。
- 用户界面读取配置后生成的展示内容。

## 4. 通用数据模型

### 4.1 新增两个通用字段

| 表 | 字段 | 作用 |
|---|---|---|
| `auto_prompt_types` | `strategy_policy_json TEXT NULL` | 保存当前策略声明式运行政策 |
| `inference_snapshots` | `strategy_runtime_json TEXT NULL` | 冻结本次推理实际编译和执行的政策、证据与哈希 |

不新增 EMA、M5、M15、H1 或主备周期专用列。

`market_data_plan_json` 继续描述行情数据计划；`strategy_policy_json` 描述如何使用这些数据。两者职责分离：

```text
market_data_plan_json = 取什么数据
strategy_policy_json  = 当前策略如何组织阶段、指标和约束
```

### 4.2 顶层模式

每份通用 policy 支持：

- `off`：不编译、不注入、不执行新政策，走 legacy 路径。
- `shadow`：编译和计算，但只记录假设结果，不注入模型、不改变信号、不影响执行。
- `enforce`：把编译政策注入模型，并在推理后和提交前执行通用约束。

空值、NULL 或空 policy 必须等价于 `off`。

### 4.3 目标策略的配置实例

下面只是当前策略数据示例，不是要复制进系统源码的常量：

```json
{
  "schema_version": "strategy-policy-v1",
  "mode": "shadow",
  "features": [
    {
      "id": "structure",
      "kind": "chan_structure",
      "enabled": true
    }
  ],
  "indicators": [
    {
      "id": "entry_ema",
      "kind": "ema",
      "enabled": true,
      "source": {
        "timeframe": "M5",
        "field": "close",
        "bar_scope": "closed_only"
      },
      "params": {
        "period": 34,
        "minimum_bars": 34,
        "warmup_target_bars": 170
      }
    }
  ],
  "workflow": {
    "stages": [
      {
        "id": "primary_trend",
        "kind": "model_assessment",
        "source": { "timeframe": "M15" },
        "output_states": ["up", "down", "unclear", "unavailable"]
      },
      {
        "id": "fallback_trend",
        "kind": "model_assessment",
        "source": { "timeframe": "H1" },
        "run_if": {
          "left": { "ref": "stages.primary_trend.state" },
          "op": "eq",
          "right": "unclear"
        },
        "on_skipped": "primary_resolved"
      },
      {
        "id": "opportunity_confirmation",
        "kind": "model_confirmation",
        "source": { "timeframe": "M15" },
        "minimum_evidence_count": 2,
        "run_if": {
          "left": { "ref": "decision.final_direction" },
          "op": "in",
          "right": ["up", "down"]
        }
      },
      {
        "id": "entry_trigger",
        "kind": "model_trigger",
        "source": { "timeframe": "M5" },
        "minimum_evidence_count": 1,
        "run_if": {
          "left": { "ref": "stages.opportunity_confirmation.passed" },
          "op": "eq",
          "right": true
        }
      }
    ],
    "selectors": [
      {
        "when": {
          "left": { "ref": "stages.primary_trend.state" },
          "op": "in",
          "right": ["up", "down"]
        },
        "select_direction_from": "stages.primary_trend.state",
        "select_timeframe_from": "stages.primary_trend.source.timeframe"
      },
      {
        "when": {
          "all": [
            {
              "left": { "ref": "stages.primary_trend.state" },
              "op": "eq",
              "right": "unclear"
            },
            {
              "left": { "ref": "stages.fallback_trend.state" },
              "op": "in",
              "right": ["up", "down"]
            }
          ]
        },
        "select_direction_from": "stages.fallback_trend.state",
        "select_timeframe_from": "stages.fallback_trend.source.timeframe"
      }
    ],
    "default_decision": "hold_new_entry"
  },
  "constraints": [
    {
      "id": "entry_indicator_ready",
      "scope": "new_entry",
      "phases": ["post_inference", "pre_submit"],
      "require": {
        "left": { "ref": "indicators.entry_ema.ready" },
        "op": "eq",
        "right": true
      },
      "on_fail": "hold_new_entry",
      "counts_as_trigger": false
    },
    {
      "id": "buy_indicator_relation",
      "scope": "new_entry",
      "phases": ["post_inference", "pre_submit"],
      "when": {
        "left": { "ref": "signal.side" },
        "op": "eq",
        "right": "buy"
      },
      "require": {
        "left": { "ref": "indicators.entry_ema.bar.close" },
        "op": "gt",
        "right": { "ref": "indicators.entry_ema.value" }
      },
      "on_fail": "hold_new_entry",
      "counts_as_trigger": false
    },
    {
      "id": "sell_indicator_relation",
      "scope": "new_entry",
      "phases": ["post_inference", "pre_submit"],
      "when": {
        "left": { "ref": "signal.side" },
        "op": "eq",
        "right": "sell"
      },
      "require": {
        "left": { "ref": "indicators.entry_ema.bar.close" },
        "op": "lt",
        "right": { "ref": "indicators.entry_ema.value" }
      },
      "on_fail": "hold_new_entry",
      "counts_as_trigger": false
    }
  ],
  "prompt_rules": [
    {
      "id": "exclusive_trend_source",
      "text": "只执行 workflow 给出的主周期与回退周期顺序；未被激活的回退阶段不得参与确认、共振或评分。"
    },
    {
      "id": "entry_indicator_filter",
      "text": "constraints 中的指标关系只过滤新入场，不计作入场触发，也不构成退出或撤单理由。"
    }
  ],
  "ui": {
    "groups": [
      {
        "id": "entry_indicator",
        "label": "入场指标过滤",
        "control": "rule_switch",
        "rule_ref": "entry_ema"
      }
    ]
  }
}
```

实际 schema 可以在实现前进一步压缩，但必须保留三个原则：参数在策略数据中、公共引擎只解释白名单节点、所有节点可被快照复现。

## 5. 通用引擎设计

### 5.1 Policy 编译器

建议新增 `strategy-policy-compiler.js`，职责仅包括：

- 校验 `schema_version` 和 mode。
- 校验 ID 唯一性和引用存在。
- 校验指标 kind、参数范围、周期是否合法且已包含在行情计划中。
- 校验工作流无循环、阶段引用有效、默认决策存在。
- 校验条件表达式只使用白名单字段和操作符。
- 输出 canonical compiled policy 和 SHA-256 hash。

禁止使用 `eval`、`Function`、动态 SQL、任意模块名或用户提供的代码。

保存时发现 unknown schema/kind/operator，应拒绝保存该策略。运行时遇到历史脏配置，只阻断该策略实例并记录审计，不能让其他调度任务退出。

### 5.2 指标注册表

建议新增 `indicator-registry.js`：

```text
registry[kind] -> validate(definition), requiredHistory(definition), calculate(bars, definition)
```

首批实现通用 `ema` capability。计算器接收策略给出的 timeframe、field、period 和 bar_scope；代码中不出现 M5 或 34。

通用 closed-only 要求：

- 只使用定义指定范围内的已收盘 K 线。
- 时间升序、有限数值、无未解决内部缺口。
- EMA 初始化与递推算法版本化。
- 内部预热与模型可见窗口解耦。
- 输出 `ready/value/bar/source/reason/evidence_hash`。

目标策略仍可向模型展示当前 60 根 M5；通用引擎根据 period=34 计算所需内部历史，不改变可见窗口。

### 5.3 工作流执行器

建议新增 `strategy-workflow-engine.js`：

- 根据 stage 的 `run_if` 决定执行或跳过。
- 检查模型结构化输出是否包含本轮必需 stage。
- 拒绝模型为未激活 stage 提供决策权。
- 按 selectors 产生 final direction/effective source。
- default decision 只执行配置给出的动作。

引擎不认识 M15/H1，也不判断“什么叫趋势明确”。清晰/不清晰的业务定义继续由当前策略提示词和该策略 stage output contract 决定；系统只保证阶段顺序和结构一致。

若未来需要把明确/不明确也改成确定性服务端判断，应扩展通用 evidence-expression DSL，让规则存在策略 JSON 中，不能把当前策略的 Chan/MACD 条件写进引擎。

### 5.4 条件与动作执行器

建议新增 `strategy-constraint-engine.js`，支持最小白名单：

```text
操作符: eq, neq, gt, gte, lt, lte, in, all, any, not
动作: allow, hold_new_entry, reject_submission, skip_stage
阶段: pre_inference, post_inference, pre_submit
```

引擎只比较引用和值，不知道某个比较代表“多头在 EMA 上方”。目标策略用配置组合出该含义。

`hold_new_entry` 必须只清除新建仓字段，保留：

- 独立 pending keep/cancel 评估。
- 冻结的持仓 hold/exit 评估。
- 与新入场无关的管理说明和证据。

### 5.5 通用提示规则渲染器

`llm.js` 只追加一段周期中性的系统说明，例如：

```text
## 当前策略运行政策
以下编译政策与证据属于当前策略，必须按 stage、constraint 和 action 顺序执行。
不得执行未激活阶段，不得把 counts_as_trigger=false 的约束计作触发证据。
```

具体 M15/H1/EMA34 文本来自当前策略的 compiled policy/prompt_rules。禁止在 `llm.js` 常量中新增目标策略专用规则。

模型输入新增：

```text
strategy_context.compiled_policy
strategy_context.workflow_state
strategy_context.indicators
```

off/NULL 策略不注入这些字段。

## 6. 目标策略语义仍保持不变

系统架构通用，不代表当前策略要求被弱化。当前策略配置仍应表达：

1. M15 为趋势主判。
2. M15 数据有效但输出 unclear 时才激活 H1。
3. M15 unavailable 时新入场 HOLD，不借 H1 绕过数据故障。
4. M15 确定方向后，H1 stage 为 skipped，不参与确认、共振、评分或记忆。
5. H1 接管后，M15 只负责同向机会定位和至少两项确认。
6. M5 只负责至少一项最终触发，不参加趋势投票。
7. EMA34 关系只过滤新入场，`counts_as_trigger=false`。
8. EMA 证据缺失、相等或不可靠时，通用约束结果为 `hold_new_entry`。

这些内容必须存在于目标策略 policy/prompt 中，而不是公共函数的条件分支中。

## 7. 旧策略隔离与双轨运行

### 7.1 三种路径

| 当前策略 policy | 行情/提示/信号/执行行为 |
|---|---|
| NULL、空或 mode=off | 完全走现有 legacy plan、Chan alignment、提示和执行路径 |
| mode=shadow | 同时计算 compiled policy 假设结果，但 legacy 结果仍是唯一运行依据 |
| mode=enforce | 只对该策略使用 compiled workflow/constraints；legacy alignment 可作为诊断证据，但不覆盖该策略 policy |

上一版方案中“旧 `chan_timeframe_alignment` 不再驱动任何规则”的表述过于宽泛，必须改成：

> 只有当前策略的通用 policy 处于 enforce 时，运行决策才由 compiled policy 驱动；没有 policy 的旧策略继续保持原有 Chan alignment 语义。

### 7.2 旧字段兼容

现有 `use_chan_analysis` 是 legacy 策略能力列。本批不再复制这种 feature-specific schema。

过渡期 parser 可以把 `use_chan_analysis=1` 映射为只读 legacy feature，让新引擎读取，但必须满足：

- 不回写 `strategy_policy_json`。
- 不自动增加策略版本。
- 不改变旧策略 prompt、market context 或运行 hash。
- 不要求旧策略配置新 policy。

### 7.3 不允许自动回填

- 不按策略 ID、标题、说明或提示词关键词识别目标策略。
- migration 不把现有策略批量写入新 policy。
- 目标策略由管理员显式保存配置后才进入 shadow/enforce。
- 其他策略的周期和指标没有任何新强制要求。

## 8. 推理、快照和执行一致性

### 8.1 推理后通用校验

模型返回结构化结果后执行：

```text
compilePolicy(strategyPolicy)
validateWorkflowTrace(compiledPolicy, modelOutput)
evaluateConstraints(compiledPolicy, evidence, 'post_inference')
```

没有 policy 时不调用新门禁。违反当前策略约束时使用通用 action，不在代码中判断具体 EMA 或周期。

### 8.2 提交前通用校验

所有 AI 下单入口继续汇入 `executeOrderCore()`，根据 signal_id 读取该信号冻结的 compiled policy，再执行：

```text
refreshEvidenceForPhase(compiledPolicy, 'pre_submit')
evaluateConstraints(compiledPolicy, refreshedEvidence, 'pre_submit')
```

约束必须在 Bridge 发送前、`cancel_replace` 撤旧挂单前执行。用户直接填写方向和手数的普通手工订单继续豁免策略 policy。

平台共享信号使用同一份平台策略证据；不能为每个订阅者重新选择趋势方向。用户层仍独立复核报价、合约规格和风险。

### 8.3 快照

`strategy_runtime_json` 至少保存：

- 原始 strategy policy。
- canonical compiled policy。
- policy schema/engine/indicator algorithm version。
- workflow state、indicator evidence、constraint results。
- 行情源、bar identity 和 evidence hash。
- rendered system/user prompt hash。
- runtime config hash。

旧快照没有该字段时走 `legacy_implicit`，只使用已冻结 system/user prompt 和旧行情证据，不得套当前 policy。

### 8.4 历史比较

手动、自动、实时模型比较和历史比较必须调用同一个通用 builder/compiler/evaluator。历史入口传 `decision_cutoff_utc_msc`，所有指标只读取截止点及以前已收盘 K 线。

模型比较拆分：

- raw model direction。
- policy-compliant direction。
- workflow compliance rate。
- constraint pass rate。
- execution-eligible account simulation。

无 policy 的旧策略保持原统计合同。

## 9. UI 与 API

### 9.1 UI 仍可提供易懂控件

“系统通用”不要求管理员手写 JSON。两套策略编辑器应提供通用策略规则编辑器：

- 指标 kind：EMA 等注册表能力。
- 时间周期：从当前行情计划选择。
- period、price field、bar scope。
- Buy/Sell 或其他 signal side 的通用比较表达式。
- 工作流 stage、source timeframe、run_if、minimum evidence count。
- off/shadow/enforce。

目标策略在 UI 上可以显示“启用 M5 EMA34 入场过滤”和“M15 主判/H1 回退”的易懂摘要，但这些文字由当前 policy 值渲染，不对应专用数据库列或核心代码分支。

### 9.2 两套编辑器必须完整 round-trip

涉及：

- `public/ai/index.html`
- `public/ai/app.js`
- `public/admin/app.js`

保存其他字段时不得清空或重建未知 policy 内容。API 规则：

- create 省略 policy → NULL/off。
- update 省略 policy → 保留旧值。
- 显式更新 policy → 严格校验并令策略版本 +1。
- UI 必须显示编译错误位置，不能静默降级成旧逻辑。

## 10. 文件级实施范围

### 新增通用模块

| 文件 | 职责 |
|---|---|
| `server/routes/ai/strategy-policy-compiler.js` | schema 校验、canonical 编译、hash |
| `server/routes/ai/indicator-registry.js` | 通用指标 capability 注册与计算 |
| `server/routes/ai/strategy-workflow-engine.js` | stage、run_if、selector、workflow trace |
| `server/routes/ai/strategy-constraint-engine.js` | 条件表达式和通用 action |
| `server/routes/ai/strategy-prompt-renderer.js` | 将当前策略 compiled policy 渲染给模型 |

### 修改现有模块

| 文件 | 修改 |
|---|---|
| `server/db.js` | 新建库增加两个通用 JSON 字段 |
| `server/migrations.js` | 追加通用 policy/runtime snapshot 迁移，不改旧迁移 |
| `server/routes/ai/strategy-policy.js` | 解析 legacy plan/Chan 和通用 policy，保持隔离 |
| `server/routes/ai/strategy-ownership.js` | CRUD、版本递增、字段省略保留 |
| `server/routes/ai/strategy.js` | 调用通用 compiler/builder；按 off/shadow/enforce 路由 |
| `server/routes/ai/scheduler.js` | 使用当前策略编译结果；主周期显式读取 `primary_timeframe` |
| `server/routes/ai/llm.js` | 只加入周期中性的 policy 说明和通用 trace 校验 |
| `server/routes/ai/config.js` | AI 订单执行前调用通用约束引擎 |
| `server/routes/ai/inference-snapshots.js` | 冻结 compiled policy、证据和版本 |
| `server/routes/ai/model-backtest.js` | 根据冻结 policy 的 phase 语义决定是否纳入回放 |
| `server/routes/ai/memory-system.js` | policy 策略使用 workflow final direction；legacy 不变 |
| `server/routes/ai/platform-experience.js` | 同上 |
| `public/ai/*`、`public/admin/app.js` | 通用规则编辑、摘要和 round-trip |

### 独立卫生任务

- 核实后移除或改写无调用 `buildStrategyContext()` 旧 helper。
- 将活动 builder 的 `fallbackTimeframe` 参数改名为 `primaryTimeframe`。
- 将 `llm.js` 中仅作为示例的 H1/H4 用户可见文案改为周期中性表达。

这些清理应独立提交，避免与新政策引擎行为混淆。

## 11. 分阶段实施

### 阶段 0：冻结通用 DSL

- [ ] 固定 schema version、节点类型、操作符、动作和可引用字段。
- [ ] 明确禁止 eval/任意代码/任意模块加载。
- [ ] 固定 unknown schema/type 的单策略 fail-closed 行为。
- [ ] 用至少三种完全不同策略验证 DSL 能表达，而不是只验证目标策略。

验收门：在不修改引擎源码的前提下，JSON 能表达目标策略、旧 H1/H4 共振策略和另一套非 EMA/非 Chan 策略。

### 阶段 1：迁移与兼容 parser

- [ ] 追加 `strategy_policy_json` 与 `strategy_runtime_json`。
- [ ] NULL/off 默认路径与当前基线 hash 一致。
- [ ] create/update/版本递增符合省略保留规则。
- [ ] 不自动回填任何策略。

验收门：fresh/upgrade/rerun migration 通过，旧策略查询和运行无变化。

### 阶段 2：compiler、indicator、workflow、constraint

- [ ] 先写通用参数化测试，再实现五个通用模块。
- [ ] indicator history 根据配置计算，不绑定模型可见数量。
- [ ] workflow 不认识任何具体 timeframe。
- [ ] constraint 不认识 EMA34 或 Buy above 语义。
- [ ] 所有输出带 schema/algorithm version 和 hash。

验收门：同一引擎通过 EMA20、EMA34、SMA50、任意 A/B 周期主备和单周期策略测试。

### 阶段 3：运行时双轨接入

- [ ] manual、auto、live compare、history compare 共用编译器和 builder。
- [ ] off 走 legacy；shadow 双算但 legacy 驱动；enforce 只约束当前策略。
- [ ] legacy `buildChanTimeframeAlignment` 行为和测试不变。
- [ ] 一个策略编译失败不影响其他 scheduler。

验收门：同进程同时运行 legacy 策略和目标策略，前者 prompt/context/decision hash 不变。

### 阶段 4：快照与中央执行门

- [ ] 冻结原始/编译 policy、证据和 hash。
- [ ] post_inference 和 pre_submit 调用同一个通用 constraint evaluator。
- [ ] 门禁先于 replacement cancel 和 Bridge send。
- [ ] 手工直接订单豁免。
- [ ] 旧快照按 legacy 回放。

验收门：策略后来修改后，旧信号和旧快照仍按冻结 policy 复现。

### 阶段 5：通用 UI

- [ ] 用户策略编辑器和统一管理后台使用同一 schema。
- [ ] 规则开关、指标、周期、参数和表达式可编辑。
- [ ] 未触碰 policy 时保存其他字段不改变 policy hash。
- [ ] unknown 节点有明确错误，不静默丢字段。

验收门：桌面和移动端保存、重开、复制策略后 policy 完整一致。

### 阶段 6：目标策略配置与提示词 v2.0

- [ ] 通过 UI/API 给目标策略写入当前配置实例。
- [ ] 基础提示词继续定义 M15 clear/unclear 的业务含义。
- [ ] 修复“任一明确/任一不明确可同时成立”的歧义。
- [ ] 修复无条件 M15/H1 共振、S 级可绕过上游门槛等歧义。
- [ ] EMA 只由 policy constraint 表达，不在系统 prompt 常量中硬编码。
- [ ] 先 shadow，再 enforce。

验收门：目标策略 policy、基础 prompt、模型 trace 和快照 runtime 完全一致。

## 12. 兼容与参数化测试矩阵

### 12.1 必须同进程测试的策略

| Fixture | 配置 | 期望 |
|---|---|---|
| A | NULL policy，原 H1/H4 Chan 多周期策略 | 与当前 baseline 完全一致 |
| B | 当前 M15/H1 + M5 EMA34 策略 | 只该策略获得新 workflow/constraint |
| C | M30/D1 主备 + M15 EMA20 | 无需修改引擎即可运行 |
| D | 单周期、非 Chan、无指标约束 | 不创建 alignment 或额外门禁 |
| E | 含 unknown indicator/operator | 只阻断该策略，其他策略继续运行 |

### 12.2 通用引擎

- policy NULL/off/shadow/enforce。
- schema/type/operator/reference 非法。
- workflow 循环、缺 stage、未激活 stage 被模型引用。
- 任意 timeframe 组合，不依赖 M15/H1。
- EMA 5/20/34/200、不同 field 和 closed/live policy。
- 33/34 根只是目标 fixture 边界；通用测试按 definition.minimum_bars 参数化。
- indicator 缺口、时间乱序、source 变化、数据过旧。
- hold_new_entry 保留持仓和挂单管理字段。

### 12.3 路径隔离

- manual、auto、live compare、history compare 同 policy/cutoff 同 hash。
- legacy A 在 B 开启前后 rendered prompt、market context、decision、execution gate 不变。
- UI 更新描述、模型或周期时不丢 policy。
- 策略版本 +1 后旧 snapshot 仍复现。
- 一个策略错误不停止其他自动任务。
- 普通手工订单不进入策略 constraint engine。

### 12.4 目标策略 fixture

- primary up/down 时 fallback skipped。
- primary unclear 时 fallback 才运行。
- primary unavailable 时 default hold。
- primary/fallback 都 unresolved 时 hold。
- entry indicator ready/unready/equal/above/below。
- buy/sell/limit/stop/stop_limit 和拟提交价格。
- `counts_as_trigger=false` 不增加 M5 触发数量。
- 推理后通过、提交前新闭合 bar 翻转时拒绝发送。

### 12.5 防硬编码检查

新增通用模块不得出现目标策略常量：

```text
M15
H1
M5
34
use_m5_ema34
target strategy id/title
```

合法例外仅限目标 policy fixture、提示词 fixture 和通用周期枚举。检查不能误报现有 ATR 风控 H1/H4 或合法 timeframe registry。

## 13. 挂单边界

当前策略实例可以通过通用 constraint 把 EMA 关系配置为 `post_inference + pre_submit` 两阶段执行。

v1 只保证：

- 信号生成时满足当前策略约束。
- 提交订单时使用同源最新已收盘证据再次满足约束。
- 拟执行价格按策略配置的通用表达式复核。

不保证券商原生挂单未来成交瞬间仍满足指标条件。若策略需要 fill-time 约束，应新增通用 phase：

```text
pre_fill
```

并由合成挂单或 Bridge 条件执行器实现，不能为 EMA34 单独写特殊路径。

## 14. 灰度与回滚

### 上线顺序

1. 通用字段、compiler 和空 policy 兼容代码上线。
2. 所有现有策略保持 NULL/off，核对 baseline hash。
3. 用测试策略验证任意周期/任意 EMA period，证明引擎参数化。
4. 目标策略写入 policy 并切 shadow。
5. 对比 legacy 与 compiled workflow 的方向、stage、HOLD 和 constraint 结果。
6. 目标策略单独切 enforce。
7. 观察稳定后再更新目标策略基础提示词版本。

### 回滚

- 只把目标策略 mode 改回 off 或恢复上一版本 policy。
- 不删除通用列，不改旧快照，不回写其他策略。
- 已冻结的新策略信号按其 snapshot policy 处理，必要时要求重新分析。
- 一个策略回滚不得重启或改写其他策略配置。

立即回滚条件：legacy 策略 hash 变化、同一策略不同入口编译结果不一致、共享信号按订阅者分叉、一个策略配置错误影响其他 scheduler、或普通手工订单被 policy 拦截。

## 15. 明确不在本批内

- 不为目标策略新增专用数据库列或核心代码分支。
- 不在系统代码中写 M15/H1/M5/EMA34 业务判定。
- 不把现有 Chan alignment 全局替换成目标策略仲裁。
- 不顺带修改 ATR_ANCHOR_PRIORITY 风控合同。
- 不实现原生挂单成交瞬间条件单。
- 不自动迁移、猜测或开启任何旧策略。
- 不部署、不提交、不推送，除非后续明确授权。

## 16. 完成定义

只有同时满足以下条件才可宣称完成：

- 新增模块是参数化通用能力，不含目标策略常量。
- 当前策略只通过 `strategy_policy_json` 表达 M15/H1/M5/EMA34 规则。
- NULL/off 旧策略的 prompt、context、decision、execution 和 snapshot 基线不变。
- shadow/enforce 只影响当前保存了 policy 的策略。
- manual、auto、实时比较、历史比较和执行使用同一 compiled policy。
- 推理和提交阶段使用同一通用 constraint engine。
- 两套 UI 完整 round-trip 任意合法 policy。
- 旧快照不读取当前 policy，新快照可完整复现。
- 参数化多策略、全量测试、浏览器、真实 Bridge/MT5 非执行验证均有证据。

## 17. 当前验证边界

已完成：

- 当前 checkout 静态调用链审查。
- 全仓旧 `1H 主判/4H 回退` 字面量与调用核对。
- 当前活动 builder、Chan alignment、手动/自动/比较策略隔离核对。
- 相关既有测试基线核对。
- 本方案按“系统通用、策略配置化”原则重写。

尚未完成：

- 通用 policy schema 的正式评审和实现。
- migration、业务代码、UI 和测试改动。
- 浏览器验收、真实模型、Bridge/MT5 和生产验证。

当前状态是“通用架构方案已修订，实施尚未开始”。
# 状态说明

本方案中的通用运行政策 JSON 已被简化实现取代：当前产品只保存 `use_ema34_filter` 开关，M5 EMA34 的计算、证据生成和新开仓方向过滤均由服务端固定代码执行。本文保留为设计过程记录，不再作为现行配置合同。
