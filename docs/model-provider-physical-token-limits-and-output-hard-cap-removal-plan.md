# 模型提供商物理 Token 能力与平台输出硬上限取消方案

> 状态：待实施方案；本文不代表功能已经上线
>
> 审查基线：`dev_codex` @ `2520c6fcd6ad8050c5d95004c68746ff182f8902`
>
> 日期：2026-08-12
>
> 适用范围：平台与个人模型资料、人工模型能力配置、自动推理、手动分析、模型比较、日/月复盘、记忆库整理、连接测试及统一模型任务运行时

## 1. 最终目标

取消 AURUM 自己定义的最大输出 token 硬上限。模型请求只服从模型提供商对具体端点和具体模型规定的物理边界：

- 最大输入 token；
- 上下文窗口；
- 最大输出 token；
- 提供商对“输入 + 输出共享上下文”或“输入、输出分别限制”的真实语义。

模型物理能力全部由模型资料所有者人工填写：

- 个人模型由该用户填写；
- 平台模型由管理员填写；
- 不提供自动获取按钮、发现接口或后台刷新任务；
- 不根据模型名称猜测，不抓取网页，不通过制造超长请求探测上限。

新建模型资料采用用户提供的 DeepSeek 能力面板数值作为通用初始值：

- 上下文窗口：`1024K`，保存为 `1048576` tokens；
- 最大输入：`1024K`，保存为 `1048576` tokens；
- 最大回答：`384K`，保存为 `393216` tokens；
- 最大思维链：`128K`，保存为 `131072` tokens。

这里按 `1K = 1024 tokens` 换算。四项值只是减少初次填写成本的 AURUM 通用初始值；它们适用于截图所示 DeepSeek 模型，但不表示其他服务商或其他模型也具备相同能力。界面必须明确提示用户按当前服务商和模型文档核对、修改并确认。保存后的人工确认值才是该模型资料的运行时物理能力合同。

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

所以不能假设“兼容 `/models`”就能自动获取限制。为了保持各服务商和自定义兼容网关行为一致，本方案不再建设任何自动获取能力，统一采用人工填写。

火山方舟 Responses 文档还明确规定：`max_output_tokens` 包含模型回答和思维链内容。因此不能把截图中的“最大回答 384K”直接等同于 Responses 请求字段；开启深度思考时，该字段的候选物理上限应由“最大回答 + 最大思维链”推导，即 `512K`，再受本次输入占用后的上下文剩余量约束：

- [火山方舟 Responses API](https://www.volcengine.com/docs/6492/2241840?lang=zh)

### 2.4 当前本地火山方舟实测

2026-08-12 对本地项目已配置的 3 个火山方舟 Agent Plan 模型资料进行了只读元数据测试，没有触发分析、复盘、交易或数据写入：

| profile | 模型 | 测试结果 |
| --- | --- | --- |
| 1 | `deepseek-v4-pro` | `/api/plan/v3/models` 和 `/models/{model}` 均为 404 |
| 3 | `ark-code-latest` | `/api/plan/v3/models` 和 `/models/{model}` 均为 404 |
| 13 | `deepseek-v4-pro` | `/api/plan/v3/models` 和 `/models/{model}` 均为 404 |

另用同一 Agent Plan Bearer 凭据访问标准方舟 `/api/v3/models` 返回 401，说明它不是可复用同一订阅凭据的模型元数据接口。所有响应均未返回最大输入、上下文窗口或最大输出字段；数据库中也没有这三个资料的既有能力记录。

结论：当前实际使用的火山方舟 Agent Plan 无法通过已配置 API 自动获取 token 能力，采用纯手动配置更简单、可解释，也避免为少数可能支持元数据的服务商维护另一套行为。

### 2.5 用户提供的 DeepSeek 初始能力

用户提供的 `deepseek-v4-flash-qa-260731` 能力面板显示：上下文窗口 1024K、最大输入 1024K、最大回答 384K、最大思维链 128K。本文将这四个原始数值作为所有新建模型资料的表单初始值，并保留 `default_unconfirmed` 状态；DeepSeek 以外的模型不能因采用了相同初始值就被标记为“官方已确认”。

## 3. 需求与非目标

### 3.1 必须实现

1. 删除模型资料中的 AURUM 输出硬上限语义。
2. 增加人工维护的上下文窗口、最大输入、最大回答和最大思维链能力记录。
3. 新建模型资料默认填入 1024K/1024K/384K/128K，并明确标记为通用初始值、尚未确认。
4. 个人模型由所有者确认，平台模型由管理员确认。
5. 具体请求的输出参数只按人工保存的物理能力和协议语义推导，不再由任务类型调低。
6. 输入超过人工保存的最大输入时显式失败或采用该业务已批准的分块机制，禁止静默删减证据。
7. 推理、复盘、比较、记忆整理和连接测试使用同一个人工能力解析器。
8. 保留真实 token、请求参数、人工配置版本和完成原因审计。

### 3.2 不在本方案内

- 不取消提供商或模型自身的物理限制。
- 不取消任务超时、业务期限、租约、取消和重试边界。
- 不因取消输出硬上限而改变策略、风控、仓位或订单合同。
- 不调用模型元数据接口，不自动抓取服务商网页或第三方模型排行榜。
- 不用二分探测、超长空请求或故意触发费用的方式猜上限。
- 不把价格、TPM/RPM 配额和上下文能力混成同一个字段。

## 4. 统一能力模型

### 4.1 数据字段

扩展现有 `ai_model_provider_capabilities`，不另建第二套能力表：

| 字段 | 语义 |
| --- | --- |
| `context_window_tokens` | 人工保存的上下文窗口；初始 1048576 |
| `max_input_tokens` | 人工保存的最大输入；初始 1048576 |
| `max_answer_tokens` | 人工保存的可见回答上限；初始 393216 |
| `max_reasoning_tokens` | 人工保存的思维链上限；不支持思考的模型可为 0；初始 131072 |
| `context_limit_semantics` | `shared_context` 或 `separate`；初始为较保守的 `shared_context` |
| `output_limit_semantics` | `answer_only` 或 `answer_plus_reasoning` |
| `token_limits_source` | `manual_confirmed`、`generic_default`、`legacy_unverified` |
| `token_limits_status` | `confirmed`、`default_unconfirmed`、`stale` |
| `token_limits_note` | 人工填写的服务商文档说明或内部备注；禁止凭据 |
| `token_limits_updated_by` | 最近确认或修改者 |
| `token_limits_updated_at_utc_msc` | 最近确认或修改时间 |

现有流式、轮询、取消等能力继续使用原字段。token 限制的人工确认状态与其他能力是否已验证分开表达，避免一个布尔状态混淆两类能力。

### 4.2 能力记录的唯一身份

能力继续绑定 `model_profile_id`，因为同一模型名称经过不同 base URL、代理或兼容网关后，限制可能不同。以下任一字段变化时，现有 token 能力必须标记为 `stale`：

- provider；
- model name；
- normalized base URL；
- endpoint protocol。

只更换 API Key 且端点、模型、协议都不变时，不自动失效人工能力。模型资料的 provider、model 或 base URL 变化后，界面恢复通用初始值并要求重新确认。

## 5. 人工填写

### 5.1 API 与权限

直接扩展现有模型资料创建和更新 API，不新增发现接口：

- `POST /api/ai/model-profiles`
- `PUT /api/ai/model-profiles/:id`
- 平台模型继续通过统一管理后台调用同一服务层，owner 为 0；普通用户只能操作自己的资料。

请求增加 `context_window_tokens`、`max_input_tokens`、`max_answer_tokens`、`max_reasoning_tokens`、`context_limit_semantics` 和 `output_limit_semantics`。除明确允许为 0 的思维链上限外，token 字段都必须是数据库可表示的正整数；校验只防止空值、非整数、负数、语义冲突和溢出，不设置比人工值更小的 AURUM 隐藏上限。

### 5.2 默认值与确认

- 新建模型资料时，依次默认上下文 `1048576`、最大输入 `1048576`、最大回答 `393216`、最大思维链 `131072`。
- 旧模型资料迁移时，不沿用现有 `max_tokens` 作为服务商最大输出；统一先填通用初始值并标记 `default_unconfirmed`。
- 用户第一次保存新字段后，`token_limits_source` 变为 `manual_confirmed`，`token_limits_status` 变为 `confirmed`。
- 修改 provider、model name 或 base URL 后恢复 `default_unconfirmed`，必须重新核对并保存。
- 已是默认模型或已绑定策略的资料，在未确认前继续按迁移前行为运行；权威切换前必须全部确认，避免切换过程造成服务中断。

### 5.3 界面

移除“最大输出令牌/最大输出硬上限”配置，改为“模型物理能力”：

- 上下文窗口；
- 最大输入；
- 最大回答；
- 最大思维链；
- 上下文限制语义；
- 输出请求字段语义；
- 状态：通用初始值/已人工确认/模型资料变化后待重新确认；
- 最近确认人和时间；
- 固定提示：“默认值不是服务商官方规格，请按当前模型文档核对。”

不显示自动获取按钮。不得把通用初始值或人工值描述为“官方已验证”。

## 6. 请求时的最终限制解析

新增单一入口 `resolveEffectiveModelTokenLimits(profile, capabilities, requestInput)`，所有调用点必须使用。

### 6.1 输入边界

优先使用服务商计数接口或对应 tokenizer；没有可靠计数能力时保留输入估算用于预检，但估算不能伪装成服务商确认值。

```text
input <= max_input_tokens
input < context_window_tokens
```

输入物理容量不足时：

- 月复盘、模型比较等已有合法分块业务可以减小证据分块；公共策略和总记忆等公共上下文不得被静默删减。
- 单次自动推理、手动分析等没有批准分块语义的任务显式失败，记录 `model_input_limit_exceeded`。
- 不把输入裁短后伪装成完整推理。

### 6.2 输出请求值

先按模型与协议语义计算可生成总量：

```text
thinking enabled and output field includes reasoning:
  model_generation_cap = max_answer_tokens + max_reasoning_tokens
otherwise:
  model_generation_cap = max_answer_tokens

shared context:
  request_max_output = min(
    model_generation_cap,
    context_window_tokens - actual_input_tokens
  )

separate input/output limits:
  request_max_output = model_generation_cap
```

以本方案初始值为例，开启思考且协议的输出字段合计回答与思维链时，`model_generation_cap = 393216 + 131072 = 524288` tokens，即 `512K`。这不是新增的 AURUM 业务上限，而是从提供商原始能力推导出的请求字段上限。

`request_max_output` 不是 AURUM 业务硬上限，而是当前请求在提供商物理合同下能申请的最大值。

删除以下影响请求上限的输入：

- profile `max_tokens`；
- task floor/defaultCap；
- historical p95；
- truncation high watermark；
- schemaNeed 对最大输出的裁剪。

这些统计可以继续用于容量预警和诊断，但不能再降低请求的最大输出参数。

### 6.3 提供商参数差异

- 火山方舟 Responses API 使用 `max_output_tokens`，且该字段包含回答与思维链。
- Chat Completions 使用该服务商实际支持的输出字段。
- 提供商明确允许省略且省略即使用模型最大值时，适配器可以省略；日志仍记录解析到的物理上限。
- 自定义 OpenAI 兼容网关必须人工声明字段语义，不能因为协议名相同而继承官方值。

## 7. 统一运行时改造范围

### 7.1 核心模块

- `server/routes/ai/model-provider-capabilities.js`：人工值、确认状态、失效规则和最终能力解析。
- `server/routes/ai/model-provider-adapters.js`：继续负责协议能力，不新增 token 元数据发现。
- `server/routes/ai/model-profiles.js`：去除 `max_tokens` 业务配置与验证。
- `server/routes/ai/model-task-budget.js`：改为物理容量规划与观测，不再选择较小输出预算。
- `server/routes/ai/llm.js`：只接收解析后的物理请求上限。
- `server/routes/ai/model-task-runtime.js`：保存最大输入、上下文、最大回答、最大思维链、限制语义、来源和本次派生请求值。

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

1. 增加人工能力字段和填写界面。
2. 将现有 `ai_model_profiles.max_tokens` 保留为 `legacy_unverified` 审计值，绝不能自动标记为服务商最大输出。
3. 扫描所有被策略、默认用途和后台任务使用的 active profile。
4. 所有资料写入 1024K/1024K/384K/128K 通用初始值并显示“需要人工确认”。

### 8.2 阶段二：切换前置检查

切换前必须满足：

- 所有正在使用的 active profile 都有完整、非 stale 的物理能力；
- provider/model/base URL 与人工能力记录身份一致；
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

- 人工保存能力使用 `expected_profile_updated_at` compare-and-set；资料已变化时旧表单不得覆盖新值。
- 手工修改能力后创建审计事件，记录旧值、新值、操作者和原因，但不记录密钥。
- 运行时冻结每个模型任务使用的能力快照；任务重试必须沿用同一能力和输入合同，除非创建明确的新任务 revision。
- 如果配置值高于模型真实参数范围，提供商可能在生成前返回 400/参数非法；如果真实输入或“输入 + 请求输出”超过上下文，通常返回上下文超限；少数兼容网关可能静默钳制或忽略参数。系统不能依赖后两种非标准行为。
- 提供商因达到已接受的输出值返回 `length`、`incomplete` 或同类状态时记录 `output_truncated`；不盲目扩大上限或自动重试。
- 只有在脱敏后的提供商错误码或错误类型明确指向 token 参数范围或上下文超限时，才把能力标记为 `token_limits_status=stale`，并在模型资料页显示“模型限制配置过高，请修正最大输入、回答或思维链”；普通鉴权、限流或网络错误不得误标 stale。不得把一次错误响应自动写回为新能力。

## 10. 安全与成本边界

- 取消输出硬上限可能增加单次最坏费用和响应时间；成本只做预警、配额和审计，不得重新变成隐藏输出上限。
- 继续保留请求超时、任务总期限、租约续期、取消能力和状态未知处理。
- 响应体保留远高于正常 JSON 的字节级进程保护，防止恶意或失控端点耗尽内存；它属于服务安全边界，不按任务缩短正常模型输出。
- 人工 token 能力字段不是提示词，不得进入模型消息。
- 不记录 API Key、Authorization header 或完整服务商错误响应中的敏感信息。

## 11. 测试与验收

### 11.1 人工配置

- 新建资料正确填入 1048576/1048576/393216/131072 且状态为 `default_unconfirmed`。
- 用户保存后状态为 `confirmed` 并记录操作者、时间和审计事件。
- 旧 `max_tokens` 不会成为新的最大输出能力。
- provider/model/base URL 改变后能力变 stale。
- 页面和后端不存在自动发现接口或按钮。
- 普通用户不能修改平台模型，用户之间不能互改资料。

### 11.2 运行时

- 所有任务请求使用人工物理能力推导出的提供商请求上限，而不是 task floor/defaultCap/profile cap。
- 输入预检使用人工最大输入和上下文窗口，输出请求按最大回答、最大思维链、协议语义和上下文剩余量推导。
- 初始 DeepSeek 值在思考开启的 Responses 请求中推导出 524288；实际输入占用上下文后会按物理剩余量降低。
- 配置高于模型真实限制时，400 参数错误和上下文错误会映射成可操作的 stale 提示，不静默缩小后重试。
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
- 通用初始值被错误展示为官方规格；
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
2. 扩展模型资料 API，支持上下文、最大输入、最大回答、最大思维链、上下文语义和输出字段语义的人工配置。
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
- 已根据当前火山方舟实测删除自动获取，只保留人工填写。
- 复用了现有 `ai_model_provider_capabilities`、模型任务和 provider 适配层，没有另建第二套模型管理系统。
- 没有扩大到策略、风控、交易或价格配额改造。
- 初稿若在发现失败时直接使用旧 `max_tokens`，会把历史业务上限误认为提供商能力，违反需求。

### 14.2 根据第一轮作出的调整

1. 将旧 `max_tokens` 明确定义为 `legacy_unverified`，只作迁移提示，不直接生效。
2. 增加 active profile 切换前置检查，避免未知能力下直接上线。
3. 明确连接测试不能证明 token 上限，禁止探测式大请求。
4. 增加 1024K/1024K/384K/128K 通用初始值及 `default_unconfirmed` 状态，防止 DeepSeek 初始值被误认为所有模型的官方规格。

### 14.3 第一轮剩余风险

- 私有模型资料数量较多时，能力确认会增加用户操作。
- provider 文档和实际端点可能漂移，需要人工重新确认机制。

## 15. 第二轮方案复审：兼容、数据、并发与连带风险

### 15.1 检查结论

- 数据迁移不删除旧上限，回滚可恢复旧版本行为；新运行时不会同时受两套上限控制。
- profile revision compare-and-set 防止旧表单覆盖已经修改的模型资料。
- 模型任务冻结能力快照，重试不会因管理员中途修改能力而改变同一任务合同。
- 输入超限明确失败或使用已有合法分块，不会为容纳完整输出而静默删除交易证据。
- 取消输出硬上限不会取消业务期限、租约、服务商状态判断和结构化结果校验。
- OpenAI `/models` 与当前火山方舟 Agent Plan 都不能返回所需限制，因此统一人工填写，不维护服务商例外路径。
- 旧连接测试、手动交易复盘和兼容配置被列为强制清理范围，避免只迁移主要任务后的遗漏。

### 15.2 第二轮调整

1. 增加人工 token 能力与其他 provider 能力分离的状态字段，避免一个 `verified` 掩盖人工值未确认。
2. 增加 provider/model/base URL 变化后的 stale 规则。
3. 增加服务商拒绝与已存能力不一致时的 stale 和人工修正路径。
4. 明确保留字节级进程保护，但禁止它伪装成任务输出 token 上限。
5. 将本地火山方舟元数据实测结果写入方案，并删除自动发现接口、按钮和后台任务。
6. 将回答与思维链拆成独立原始能力字段，并按协议推导请求总输出，避免把 384K 错当成含思维链的总输出。

### 15.3 最终剩余风险

- 使用提供商最大输出会提高最坏成本和耗时，需要在上线后持续观察，但不能用隐藏上限回避。
- 缺少精确 tokenizer 的服务商仍可能在边界附近拒绝输入；此时应修正能力或增加官方计数适配，而不是恢复任务硬上限。
- 通用初始值可能高于某些模型的真实限制：输出参数过高通常会立即被拒绝，输入配置过高则可能要到真实请求越界时才暴露；首次使用前必须人工确认，服务商拒绝时需要修正配置。
- 截图分别给出最大回答和最大思维链，但没有声明二者能否在同一请求中同时达到各自峰值；`512K` 是依据 Responses 参数语义作出的推导，真实业务验证仍应纳入上线前检查。
- 服务商可能改变模型别名所指向的真实快照，别名模型需要更频繁的能力刷新。

经过两轮复审，本方案可进入实施拆分；实施前仍需逐个确认当前启用模型资料及其服务商能力来源。
