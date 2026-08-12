# 模型提供商物理 Token 能力与平台输出硬上限取消方案

> 状态：待实施方案；本文不代表功能已经上线
>
> 审查基线：`dev_codex` @ `00936149cb5b7b0eedf2f477c86322831098be22`
>
> 日期：2026-08-12
>
> 适用范围：平台与个人模型资料、服务商能力发现、自动推理、手动分析、模型比较、日/月复盘、记忆库整理、连接测试及统一模型任务运行时

## 1. 最终目标

取消 AURUM 自己定义的最大输出 token 硬上限。模型请求只服从模型提供商对具体端点和具体模型规定的物理边界：

- 最大输入 token；
- 上下文窗口；
- 最大输出 token；
- 提供商对“输入 + 输出共享上下文”或“输入、输出分别限制”的真实语义。

能力值的取得顺序固定为：

1. 服务商存在可信、已认证的模型元数据接口，并且响应明确返回限制时，自动读取并保存；
2. 服务商接口不返回限制、返回字段不完整或使用自定义兼容网关时，由模型资料所有者人工填写；
3. 未取得完整能力前，不猜测、不根据模型名称推断、不通过制造超长请求探测上限。

取消的不是提供商物理限制，也不是模型任务的超时、租约、幂等、成本记录或结果校验。取消的是 AURUM 目前的 `ai_model_profiles.max_tokens` 业务硬上限、任务级默认输出上限，以及调用点内零散的 `Math.min(...)` 输出上限。

## 2. 已核实的当前基线

### 2.1 已有可复用能力

- `ai_model_provider_capabilities` 已保存 `context_window_tokens`、`max_output_tokens` 和能力验证状态。
- `server/routes/ai/model-provider-capabilities.js` 已按模型资料读取已验证能力，并拒绝把自定义代理冒充成官方端点。
- `server/routes/ai/model-task-budget.js` 已能根据输入估算、上下文窗口和提供商输出上限计算请求预算。
- `ai_model_tasks`、尝试、事件和使用日志已经记录选择预算、输入/输出 token、完成原因和截断错误。
- `llm.js` 已区分 Chat Completions 的 `max_tokens` 与 Responses 的 `max_output_tokens`。
- 模型调用运行时已有租约、截止时间、状态未知、重试和结果应用保护；这些可靠性能力继续保留。

### 2.2 当前需要取消的限制来源

当前限制不是一个字段，而是多层叠加：

1. `ai_model_profiles.max_tokens` 是模型资料级人工硬上限，创建时默认 8000。
2. `model-task-budget.js` 为不同任务设置 floor 和 defaultCap，再选择 `selectedMaxOutputTokens`。
3. `period-review.js`、`memory-system.js` 和 `llm.js` 在预算不足时提前抛出 `output_budget_insufficient`。
4. `manual-trade-review.js`、`review-workflow.js`、连接测试等调用点还存在局部固定值或 `Math.min(...)`。
5. 用户端和管理端仍把 `max_tokens` 显示为“最大输出硬上限”，并要求保存正整数。

因此最终实现必须统一切换所有模型任务，不能只删除前端表单。

### 2.3 外部能力事实边界

以 OpenAI 为例，官方 `GET /models/{model}` 的模型对象目前只有 `id`、`created`、`object`、`owned_by`，不返回上下文和最大输出字段；官方模型目录会展示这些限制，但不应由生产服务抓取网页作为运行时能力来源：

- [OpenAI Models API](https://developers.openai.com/api/reference/resources/models)
- [OpenAI model catalog](https://developers.openai.com/api/docs/models)

所以不能假设“兼容 `/models`”就能自动获取限制。每个服务商适配器必须根据真实响应决定是否支持发现；OpenAI 及不返回限制的兼容端点走人工填写回退。

## 3. 需求与非目标

### 3.1 必须实现

1. 删除模型资料中的 AURUM 输出硬上限语义。
2. 增加最大输入、上下文窗口、最大输出及限制语义的统一能力记录。
3. 提供“自动获取能力”操作，并显示获取来源、时间和失败原因。
4. 自动获取失败时允许人工填写；个人模型由所有者填写，平台模型由管理员填写。
5. 具体请求的输出参数使用提供商最大输出值，若共享上下文，则使用“提供商最大输出”和“当前剩余上下文”中的较小值。
6. 输入超过提供商物理能力时显式失败或采用该业务已批准的分块机制，禁止静默删减证据。
7. 推理、复盘、比较、记忆整理和连接测试使用同一个能力解析器。
8. 保留真实 token、请求参数、来源和完成原因审计。

### 3.2 不在本方案内

- 不取消提供商或模型自身的物理限制。
- 不取消任务超时、业务期限、租约、取消和重试边界。
- 不因取消输出硬上限而改变策略、风控、仓位或订单合同。
- 不自动抓取服务商网页或第三方模型排行榜。
- 不用二分探测、超长空请求或故意触发费用的方式猜上限。
- 不把价格、TPM/RPM 配额和上下文能力混成同一个字段。

## 4. 统一能力模型

### 4.1 数据字段

扩展现有 `ai_model_provider_capabilities`，不另建第二套能力表：

| 字段 | 语义 |
| --- | --- |
| `max_input_tokens` | 服务商明确给出的最大输入；未知时为 NULL |
| `context_window_tokens` | 输入与输出共享的总上下文；不适用或未知时为 NULL |
| `max_output_tokens` | 服务商允许的单次最大输出 |
| `token_limit_semantics` | `separate`、`shared_context`、`unknown` |
| `token_limits_source` | `provider_api`、`manual`、`legacy_unverified` |
| `token_limits_status` | `verified`、`needs_confirmation`、`stale`、`error` |
| `token_limits_source_detail` | 使用的接口、人工说明或错误摘要；禁止凭据 |
| `token_limits_checked_at_utc_msc` | 最近发现或人工确认时间 |
| `provider_model_revision` | 服务商返回的模型版本或快照标识；没有则为 NULL |

现有流式、轮询、取消等能力继续使用原字段。token 限制是否完整与其他能力是否已验证分开表达，避免一个布尔状态混淆两类能力。

### 4.2 能力记录的唯一身份

能力继续绑定 `model_profile_id`，因为同一模型名称经过不同 base URL、代理或兼容网关后，限制可能不同。以下任一字段变化时，现有 token 能力必须标记为 `stale`：

- provider；
- model name；
- normalized base URL；
- endpoint protocol；
- 服务商返回的模型 revision。

只更换 API Key 且端点、模型、协议都不变时，不自动失效能力，但重新测试可以刷新能力时间。

## 5. 能力发现与人工填写

### 5.1 适配器合同

在 provider 适配层增加：

```js
discoverTokenLimits({ provider, protocol, baseUrl, modelName, credential, signal })
```

标准返回：

```json
{
  "status": "complete|partial|unsupported",
  "max_input_tokens": null,
  "context_window_tokens": 128000,
  "max_output_tokens": 16384,
  "token_limit_semantics": "shared_context",
  "provider_model_revision": null,
  "source_detail": "GET /models/{model}"
}
```

规则：

- 只有响应文档和字段语义明确时才接受数值。
- `/models` 只返回模型 ID 时必须返回 `unsupported`，不能补默认值。
- 自动发现请求使用现有端点安全校验、凭据解析、超时和脱敏日志。
- 连接测试与能力发现是两个动作；成功生成 `{"ok":true}` 不能证明模型上限。
- 自动发现不发生成任务，不产生交易、复盘或记忆副作用。

### 5.2 API 与权限

新增或扩展：

- `POST /api/ai/model-profiles/:id/discover-token-limits`
- `PUT /api/ai/model-profiles/:id/token-limits`
- 平台模型继续通过统一管理后台调用同一服务层，owner 为 0；普通用户只能操作自己的资料。

人工填写至少要求最大输出以及以下两种输入表达之一：

- `max_input_tokens`；或
- `context_window_tokens` + `shared_context`。

全部数值必须是数据库可表示的正整数。校验只防止无效或溢出数据，不设置 AURUM 自己的较小上限。

### 5.3 界面

移除“最大输出令牌/最大输出硬上限”配置，改为“模型物理能力”：

- 最大输入；
- 上下文窗口；
- 最大输出；
- 限制语义；
- 来源：服务商自动返回/人工确认；
- 最近确认时间；
- “自动获取”按钮；
- 自动获取不支持时显示人工输入区。

不得把人工值描述为“官方已验证”。UI 必须明确显示“人工确认”。

## 6. 请求时的最终限制解析

新增单一入口 `resolveEffectiveModelTokenLimits(profile, capabilities, requestInput)`，所有调用点必须使用。

### 6.1 输入边界

优先使用服务商计数接口或对应 tokenizer；没有可靠计数能力时保留输入估算用于预检，但估算不能伪装成服务商确认值。

```text
若有 max_input_tokens：input <= max_input_tokens
若为 shared_context：input + requested_output <= context_window_tokens
```

输入物理容量不足时：

- 月复盘、模型比较等已有合法分块业务可以减小证据分块；公共策略和总记忆等公共上下文不得被静默删减。
- 单次自动推理、手动分析等没有批准分块语义的任务显式失败，记录 `model_input_limit_exceeded`。
- 不把输入裁短后伪装成完整推理。

### 6.2 输出请求值

```text
provider_output = max_output_tokens
context_room = context_window_tokens - actual_or_estimated_input

separate:
  request_max_output = provider_output

shared_context:
  request_max_output = min(provider_output, context_room)
```

`request_max_output` 不是 AURUM 业务硬上限，而是当前请求在提供商物理合同下能申请的最大值。

删除以下影响请求上限的输入：

- profile `max_tokens`；
- task floor/defaultCap；
- historical p95；
- truncation high watermark；
- schemaNeed 对最大输出的裁剪。

这些统计可以继续用于容量预警和诊断，但不能再降低请求的最大输出参数。

### 6.3 提供商参数差异

- Responses API 使用 `max_output_tokens`。
- Chat Completions 使用该服务商实际支持的输出字段。
- 提供商明确允许省略且省略即使用模型最大值时，适配器可以省略；日志仍记录解析到的物理上限。
- 自定义 OpenAI 兼容网关必须人工声明字段语义，不能因为协议名相同而继承官方值。

## 7. 统一运行时改造范围

### 7.1 核心模块

- `server/routes/ai/model-provider-capabilities.js`：发现、人工来源、失效规则、最终能力解析。
- `server/routes/ai/model-provider-adapters.js`：服务商元数据适配器。
- `server/routes/ai/model-profiles.js`：去除 `max_tokens` 业务配置与验证。
- `server/routes/ai/model-task-budget.js`：改为物理容量规划与观测，不再选择较小输出预算。
- `server/routes/ai/llm.js`：只接收解析后的物理请求上限。
- `server/routes/ai/model-task-runtime.js`：保存最大输入、上下文、最大输出、来源和本次请求值。

### 7.2 必须逐项清理的调用点

- 自动推理和手动分析；
- 日复盘、月复盘分块与合并；
- 模型比较；
- 记忆库整理；
- 手动交易复盘；
- 旧交易复盘兼容路径；
- 模型连接测试；
- `config.js` 中仍可能映射旧 `max_tokens` 的兼容配置。

任何调用点不得自行写固定 `maxTokens` 或再次 `Math.min`。

## 8. 数据迁移与切换

### 8.1 阶段一：能力补齐，不改变运行时

1. 增加能力字段、发现接口和人工填写界面。
2. 将现有 `ai_model_profiles.max_tokens` 复制为 `legacy_unverified` 提示值，绝不能自动标记为提供商最大输出。
3. 扫描所有被策略、默认用途和后台任务使用的 active profile。
4. 自动发现能返回完整能力的资料直接保存；其余资料显示“需要人工确认”。

### 8.2 阶段二：切换前置检查

切换前必须满足：

- 所有正在使用的 active profile 都有完整、非 stale 的物理能力；
- provider/model/base URL 与能力记录身份一致；
- 关键服务商各完成一次真实连接测试和一项真实业务测试；
- 没有调用点仍依赖 profile `max_tokens`。

未使用的历史模型资料可以保留 `needs_confirmation`，但不能被设为默认或绑定新策略。

### 8.3 阶段三：一次性权威切换

1. 所有模型调用改用统一物理能力解析器。
2. 前端不再提交 `max_tokens`。
3. `ai_model_profiles.max_tokens` 暂时保留为只读 legacy 列，运行时完全忽略。
4. 验证稳定一个发布周期后再单独决定是否删除 legacy 列和旧配置映射。

不长期保留两套可同时生效的输出上限逻辑。

## 9. 并发、失败恢复与状态语义

- 同一资料的能力发现使用幂等键，并以 profile revision 做 compare-and-set；资料已变化时旧发现结果不得写入。
- 自动发现失败不覆盖最后一份已验证能力；记录失败并显示能力可能过期。
- 手工修改能力后创建审计事件，记录旧值、新值、操作者和原因，但不记录密钥。
- 运行时冻结每个模型任务使用的能力快照；任务重试必须沿用同一能力和输入合同，除非创建明确的新任务 revision。
- 提供商因物理上限返回 `length` 或 `max_output_tokens` 时仍记录 `output_truncated`，但不再通过扩大 AURUM 上限重试；应判断是提供商上限、上下文不足还是输出合同异常。
- 能力值与服务商实际拒绝不一致时标记 `token_limits_status=stale`，要求重新发现或人工修正。

## 10. 安全与成本边界

- 取消输出硬上限可能增加单次最坏费用和响应时间；成本只做预警、配额和审计，不得重新变成隐藏输出上限。
- 继续保留请求超时、任务总期限、租约续期、取消能力和状态未知处理。
- 响应体保留远高于正常 JSON 的字节级进程保护，防止恶意或失控端点耗尽内存；它属于服务安全边界，不按任务缩短正常模型输出。
- 人工 token 能力字段不是提示词，不得进入模型消息。
- 不记录 API Key、Authorization header 或完整服务商错误响应中的敏感信息。

## 11. 测试与验收

### 11.1 能力发现

- 元数据返回完整限制时保存为 `provider_api`。
- `/models` 只返回 ID 时返回 `unsupported`，不生成默认限制。
- partial 响应不覆盖完整已验证记录。
- provider/model/base URL 改变后能力变 stale。
- 自定义代理不能继承官方能力。
- 普通用户不能修改平台模型，用户之间不能互改资料。

### 11.2 运行时

- 所有任务请求使用提供商最大输出，而不是 task floor/defaultCap/profile cap。
- shared context 正确扣除输入；separate 不错误扣除独立输出能力。
- 输入超限不会删除策略、行情、持仓、总记忆或复盘证据。
- Responses 与 Chat Completions 发送正确字段。
- 没有完整物理能力的 active profile 被阻止新绑定或权威切换。
- reasoning token、文本输出 token、finish reason 和本次请求最大值正确记录。
- provider 截断不会触发盲目重复请求。

### 11.3 回归范围

至少覆盖：

- `tests/ai/model-provider-capabilities.test.js`
- `tests/ai/model-task-provider-adapters.test.js`
- `tests/ai/model-task-budget.test.js`
- `tests/ai/model-task-runtime.test.js`
- `tests/ai/llm.test.js`
- `tests/ai/model-connection-test.test.js`
- 日/月复盘、模型比较、记忆整理和手动交易复盘相关测试
- 用户端和管理端模型资料表单测试

定向测试通过后运行完整 `npm test`，并对修改的 JavaScript 执行 `node --check`。真实服务商测试必须明确授权并记录请求次数、模型、能力来源和结果。

## 12. 发布与回滚

### 12.1 发布阻断条件

- 任一正在使用的模型资料缺少完整能力；
- 仍有正式调用点读取 `model.max_tokens` 作为输出上限；
- 输入超限时存在静默裁剪；
- 能力发现可能把代理误识别为官方端点；
- 日/月复盘或自动推理无法保存冻结的能力快照；
- 完整测试或指定真实服务商验证失败。

### 12.2 回滚

首个切换版本保留 legacy 列和旧值，但旧逻辑不并行运行。若必须回滚：

1. 回退代码版本；
2. 旧版本重新读取 legacy `max_tokens`；
3. 新增能力字段和审计记录保留，不逆向删除；
4. 不重放已经完成的模型任务，不修改已生成信号、复盘或记忆结果。

## 13. 实施顺序

1. 扩展能力表与能力服务。
2. 实现 provider 自动发现适配器和人工回退 API。
3. 改造个人与平台模型界面。
4. 补齐所有 active profile 的物理能力。
5. 将预算模块改为物理容量解析器。
6. 顺序迁移连接测试、手动分析、自动推理、比较、日复盘、月复盘、记忆整理和手动交易复盘。
7. 审查全仓，确认不存在正式路径硬编码输出上限。
8. 完成定向、全量及已授权真实服务商验证。
9. 单次权威切换并保留可回退的 legacy 数据。

## 14. 第一轮方案复审：需求覆盖与最小改动

### 14.1 检查结论

- 已覆盖“取消 AURUM 输出 token 硬上限”，没有把 `max_tokens` 改名后继续作为人工上限。
- 已覆盖“能直接获取就获取、不能则人工填写”，并明确自动获取只接受真实元数据字段。
- 复用了现有 `ai_model_provider_capabilities`、模型任务和 provider 适配层，没有另建第二套模型管理系统。
- 没有扩大到策略、风控、交易或价格配额改造。
- 初稿若在发现失败时直接使用旧 `max_tokens`，会把历史业务上限误认为提供商能力，违反需求。

### 14.2 根据第一轮作出的调整

1. 将旧 `max_tokens` 明确定义为 `legacy_unverified`，只作迁移提示，不直接生效。
2. 增加 active profile 切换前置检查，避免未知能力下直接上线。
3. 明确连接测试不能证明 token 上限，禁止探测式大请求。
4. 把最大输入、共享上下文和独立最大输出拆开，避免用一个 `context_window_tokens` 错代全部语义。

### 14.3 第一轮剩余风险

- 部分服务商可能没有稳定元数据接口，人工维护比例可能较高。
- 私有模型资料数量较多时，能力确认会增加用户操作。
- provider 文档和实际端点可能漂移，需要 stale 和重新确认机制。

## 15. 第二轮方案复审：兼容、数据、并发与连带风险

### 15.1 检查结论

- 数据迁移不删除旧上限，回滚可恢复旧版本行为；新运行时不会同时受两套上限控制。
- profile revision compare-and-set 防止慢发现结果覆盖已经修改的模型资料。
- 模型任务冻结能力快照，重试不会因管理员中途修改能力而改变同一任务合同。
- 输入超限明确失败或使用已有合法分块，不会为容纳完整输出而静默删除交易证据。
- 取消输出硬上限不会取消业务期限、租约、服务商状态判断和结构化结果校验。
- OpenAI `/models` 不返回限制的现实已纳入人工回退；没有把网页抓取设计为生产依赖。
- 旧连接测试、手动交易复盘和兼容配置被列为强制清理范围，避免只迁移主要任务后的遗漏。

### 15.2 第二轮调整

1. 增加物理能力与其他 provider 能力分离的状态字段，避免一个 `verified` 掩盖 token 数据不完整。
2. 增加 provider/model/base URL 变化后的 stale 规则。
3. 增加服务商拒绝与已存能力不一致时的自动失效和人工修正路径。
4. 明确保留字节级进程保护，但禁止它伪装成任务输出 token 上限。
5. 把真实服务商验证列为发布前置条件，但仍要求单独授权，方案本身不制造外部请求。

### 15.3 最终剩余风险

- 使用提供商最大输出会提高最坏成本和耗时，需要在上线后持续观察，但不能用隐藏上限回避。
- 缺少精确 tokenizer 的服务商仍可能在边界附近拒绝输入；此时应修正能力或增加官方计数适配，而不是恢复任务硬上限。
- 某些兼容网关可能声称与实际限制不一致，人工确认仍需承担配置责任。
- 服务商可能改变模型别名所指向的真实快照，别名模型需要更频繁的能力刷新。

经过两轮复审，本方案可进入实施拆分；实施前仍需逐个确认当前启用模型资料及其服务商能力来源。
