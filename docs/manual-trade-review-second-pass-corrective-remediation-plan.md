# 手动交易复盘第二轮纠正修复方案

## 1. 文档状态

- 文档类型：第二轮全面审计后的正式纠正方案
- 方案状态：已完成本地实施与专项验证，待提交发布及公网验收
- 本地基线：`dev_codex` / `7081a5dac6914d08e741de7319025e6692900dad`
- 目标分支：先实施于 `dev_codex`，通过验收后再按授权合并 `main`
- 编写日期：2026-08-17
- 当前授权边界：已授权本地实施；不部署、不重试公网任务、不修改生产数据库

本方案承接：

- `docs/manual-trade-review-comprehensive-remediation-plan.md`
- `docs/manual-trade-review-v2-contract.md`
- `docs/manual-trade-review-history-params-invalid-fix-plan.md`

上述文档中已经完成且仍正确的权限、单笔选择、两阶段盲测、无记忆写入、无策略修改和无交易副作用边界继续保留。本方案只纠正第二轮审计确认仍未闭环的证据、冻结、恢复和状态机问题。

## 2. 结论摘要

当前手动交易复盘不是单一错误码问题，而是五个相互关联的合同缺口：

1. 缠论“结构尚未形成”和“数据证据不完整”没有分层，正常的 `insufficient_bis` 会被误判为 `chan_evidence_incomplete`。
2. 候选列表已经冻结历史范围和快照，但创建请求没有携带受保护的选择上下文，创建时又按当前时间生成新范围，导致 `manual_trade_review_source_changed`。
3. 两阶段任务只保存进度，没有保存阶段 A 的规范化结果；进程中断后无法在同一 generation 安全恢复。
4. 同一 generation 自动恢复时会重新读取当前模型配置和当前策略记忆，模型任务的既有冻结信封也没有做输入一致性校验。
5. 重试生成保留旧版本，但确认接口和前端仍允许操作旧版本，worker 最终提交可能覆盖用户刚设置的 `deferred/needs_revision` 状态。

修复必须按“冻结身份 → 证据语义 → 两阶段持久化 → 状态机围栏 → 可观测性”的顺序完成，不能继续通过放宽证据或模型输出校验让任务表面成功。

## 3. 目标

修复后必须满足：

1. 候选展示与创建复验使用同一个服务器签名的账户、范围和历史快照身份。
2. 数据完整但没有形成缠论结构时，模型可以看到“结构不足”这一真实证据，不得显示为行情缺失。
3. 每个业务 generation 冻结一次策略、记忆库、模型执行配置、业务截止时间和证据哈希。
4. 阶段 A、阶段 B 分别拥有独立、可审计的模型任务身份和持久化规范结果。
5. 任一阶段响应后进程中断，能够在同一 generation 恢复，且不会重复安全状态未知的供应商请求。
6. 人工重试创建新 generation；旧 generation、旧模型任务和旧阶段输出均保留审计记录。
7. worker 只能在 generation、任务租约、case 状态和父版本均符合预期时提交新版本。
8. 前端显示具体中文证据状态、周期和阶段，不再只显示通用 `market_evidence_unavailable`。
9. 保持不写策略记忆、不创建经验候选、不修改或发布策略、不发送交易命令。

## 4. 非目标与保留行为

本次不改变：

- 每次只选择一笔交易。
- 只允许平台内容管理员和观摩源账号使用。
- 只使用当前操作者的权威活动交易账户和唯一 Bridge 路由。
- 只复盘最近 7 天、完整平仓、净利润大于 0、未绑定平台信号的交易。
- “未绑定平台信号”不等于“已证明人工点击”。
- MT4 只承诺终端“账户历史”当前可见范围。
- 证据不足可以生成受约束的 `insufficient_evidence` 结论；真正的数据缺失不能伪装为完整。
- 批准复盘不写入策略记忆、经验、策略、回测或交易执行链。
- 已执行的迁移 `178_manual_trade_strategy_review` 和 `191_manual_trade_review_generation_recovery` 不修改正文。
- 不清洗、删除、补写或自动重试现有公网失败记录。

截图中的“AI 分析中 + 证据不足”本身不是生成失败。允许部分证据生成受限结论是当前 v2 合同的保留行为；需要修复的是证据状态是否被正确分类。

## 5. 问题到修复批次映射

| 编号 | 等级 | 已确认问题 | 修复批次 |
|---|---|---|---|
| MTR-C01 | 高 | 缠论结构状态被误当成数据完整性状态 | A |
| MTR-C02 | 高 | 选择页与创建请求没有共享冻结历史上下文 | A |
| MTR-C03 | 高 | 阶段 A 结果未持久化，同 generation 无法恢复 | B |
| MTR-C04 | 高 | 自动恢复可能重新读取变化后的模型和记忆上下文 | B |
| MTR-C05 | 中高 | 重试期间旧版本操作与 worker 提交存在竞态 | C |
| MTR-C06 | 中 | 精确证据原因被折叠为通用错误 | D |
| MTR-C07 | 低 | `retry_wait` 等进度在前端被显示为“准备证据” | D |
| MTR-C08 | 测试 | 现有测试缺少跨请求、时间推进、重启和并发纵向场景 | E |

## 6. 批次 A：冻结选择上下文与纠正缠论证据语义

### 6.1 服务器签名的选择上下文

候选接口除交易字段外，返回一个服务器签名的 `selection_context_token`。令牌使用现有服务端签名基础设施和域隔离字符串生成，不引入客户端可伪造字段，也不包含凭据、订单详情或用户隐私正文。

签名载荷至少包含：

```json
{
  "contract": "manual-trade-selection-v1",
  "user_id": 7,
  "trading_account_id": 12,
  "platform": "mt5",
  "range_start_utc_msc": 0,
  "range_end_utc_msc": 0,
  "history_snapshot_id": "opaque-bridge-snapshot",
  "issued_at_utc_msc": 0,
  "expires_at_utc_msc": 0
}
```

约束：

- 使用基于 `JWT_SECRET` 的域隔离 HMAC，例如前缀 `manual-trade-selection-v1\0`，不得直接复用普通登录 JWT 语义。
- 使用 `timingSafeEqual` 校验签名。
- 令牌只绑定当前用户和当前权威交易账户；账户切换后必须失效。
- 建议有效期 15 分钟。过期返回新的领域错误 `manual_trade_review_selection_context_expired`，要求刷新候选，而不是重新计算范围后继续。
- 创建请求提交同一个令牌；后端不接受独立的客户端范围或快照字段作为权威值。
- 服务端从令牌恢复原始范围和 `history_snapshot_id`，传给 Bridge 的精确证据读取。
- Bridge 返回的实际快照、交易身份和来源哈希仍需与候选值逐项匹配。
- 创建时仍核验交易在令牌冻结范围内，并满足最近 7 天业务规则；不允许用旧令牌扩大历史读取范围。

这样既避免前端篡改，也消除选择后创建时因 `Date.now()` 变化而生成另一个历史范围的问题。

### 6.2 删除无效的关闭时间检查

当前 `readManualTradeEvidence()` 检查选择对象的 `close_time_utc_msc`，但白名单校验已丢弃该字段。修复时不得重新信任客户端关闭时间：

1. 删除基于选择对象 `close_time_utc_msc` 的无效检查。
2. 从 Bridge 二次读取并规范化后的权威交易对象读取关闭时间。
3. 用签名令牌中的冻结范围核验关闭时间。
4. 交易已经离开当前允许的最近 7 天业务窗口时返回精确错误，不得静默换范围。

### 6.3 缠论状态拆分

抽取新的公共评估器，例如 `server/routes/ai/chan-evidence-assessment.js`，返回两个正交维度：

```text
data_status:
  complete | incomplete | unavailable | unsupported | unknown

structure_status:
  formed | partial | insufficient_structure | unavailable | not_applicable
```

判断原则：

- `evidence_capabilities.data_complete=true`，时钟、连续性、闭合历史和时间定位均可信时，`data_status=complete`。
- `insufficient_bis`、没有线段或没有中枢属于 `structure_status=insufficient_structure`，不自动把 `data_status` 改成 incomplete。
- K 线缺口、窗口不稳定、时钟未知、连续性可疑、时间定位不可靠才属于数据不完整。
- 不支持的周期和策略要求未知必须单独返回 `unsupported/unknown`。
- 手动复盘的整体证据完整性由 `data_status` 决定；结构状态作为模型可见的真实观察值进入证据和引用目录。
- 周期复盘可以继续按自己的业务合同展示 `chan_evidence_partial`，但必须复用同一个底层数据完整性判断，避免两个模块再次分叉。

禁止简单把允许状态扩大为 `['complete','ok','insufficient_bis']`；这种字符串白名单仍会遗漏其他数据完整但结构不足的合法状态。

### 6.4 批次 A 预计文件

- `server/routes/ai/manual-trade-evidence.js`
- `server/routes/ai/manual-trade-review.js`
- `server/routes/ai/review-workflow.js`
- 新增 `server/routes/ai/chan-evidence-assessment.js`
- `public/ai/app.js`
- `tests/ai/manual-trade-review-history.test.js`
- `tests/ai/manual-trade-review.test.js`
- `tests/ai/review-market-path.test.js`
- 新增选择上下文签名测试

### 6.5 批次 A 验收门

- 候选和创建使用完全相同的范围与快照。
- 时间推进但令牌未过期时，同一候选可以稳定创建。
- 令牌篡改、跨用户、跨账户、过期和快照变化均 fail closed。
- `data_complete=true + insufficient_bis` 不再显示“缠论证据缺失”。
- 真实 K 线缺口仍返回 `chan_evidence_incomplete` 或更精确的数据缺失码。
- 创建接口不再依赖客户端 `close_time_utc_msc`。

## 7. 批次 B：建立可恢复的 generation 与两阶段账本

### 7.1 新增纠正迁移

新增迁移 `192_manual_trade_review_durable_stage_runs`，不得修改迁移 178 或 191。

建议新增表 `manual_trade_review_stage_runs`：

```text
id BIGINT UNSIGNED PK
case_id BIGINT UNSIGNED NOT NULL
job_id BIGINT UNSIGNED NOT NULL
generation_no INT UNSIGNED NOT NULL
stage VARCHAR(24) NOT NULL
status VARCHAR(24) NOT NULL
model_task_id VARCHAR(128) NULL
frozen_runtime_json MEDIUMTEXT NOT NULL
frozen_runtime_hash CHAR(64) NOT NULL
input_hash CHAR(64) NULL
normalized_output_json MEDIUMTEXT NULL
normalized_output_hash CHAR(64) NULL
last_error_code VARCHAR(128) NULL
created_at DATETIME NOT NULL
updated_at DATETIME NOT NULL
completed_at DATETIME NULL
```

必要约束：

- 唯一键 `(job_id, generation_no, stage)`。
- `stage` 只允许服务层白名单 `counterfactual|outcome_review`，不依赖数据库 enum，便于兼容部署。
- `model_task_id` 非空时唯一。
- 索引 `(status, updated_at)` 和 `(case_id, generation_no)`。
- 表只保存服务器校验后的规范结果，不保存原始供应商流式内容或 API Key。

新增表而不是继续给当前单行 job 增加覆盖式字段，原因是人工重试必须保留旧 generation 的阶段身份、输入哈希、结果哈希和失败记录。

### 7.2 generation 冻结运行时

第一次认领某 generation 时，在一个事务中创建两个 stage row，并冻结同一个 `frozen_runtime_json/hash`。内容至少包括：

- case ID、job ID、generation number、业务 deadline；
- 策略快照哈希和冻结证据哈希；
- 记忆库版本、修订 ID、内容哈希，以及生成提示所需的完整冻结正文；
- 模型 profile ID、provider、model、protocol、credential source 和非密钥配置指纹；
- 两阶段输出合同版本；
- 选择上下文合同版本。

两个阶段必须引用相同的运行时哈希。恢复时禁止重新读取“当前记忆库正文”替代冻结正文。

凭据本身不写入 stage 表。恢复时按冻结 profile ID 获取当前加密凭据，但必须校验 provider/model/protocol/config fingerprint 未变化：

- 仅凭据轮换且模型配置指纹未变化，可以继续同 generation。
- provider、model、protocol、token 限制或关键配置变化时，当前 generation 失败并提示人工重试创建新 generation。

### 7.3 每阶段独立模型任务

阶段 A 和阶段 B 分别使用模型任务身份：

```text
manual_trade_review:{job_id}:{generation_no}:counterfactual
manual_trade_review:{job_id}:{generation_no}:outcome_review
```

每个任务的 `input_hash` 必须覆盖完整模型消息、冻结运行时哈希、输出合同哈希和阶段名。阶段 B 的输入哈希还必须覆盖持久化的阶段 A 输出哈希。

旧 `manual_trade_review_jobs.model_task_id` 暂时保留兼容，可镜像当前活动阶段任务；新逻辑以 stage row 为权威。待生产稳定且所有调用点迁移后，再单独评估是否废弃旧列，本次不删除。

### 7.4 阶段检查点

阶段 A 流程：

1. 读取或创建 `counterfactual` stage row。
2. 若已有合法规范输出，校验哈希后直接复用，不再请求供应商。
3. 若模型任务处于 active/status_unknown，走通用模型任务对账，不发送第二个请求。
4. 只有可安全认领的同一模型任务才能继续。
5. 模型响应通过合同校验后，先事务性写入 `normalized_output_json/hash` 并把 stage 标为 succeeded。
6. 提交成功后才进入阶段 B。

阶段 B 同理。阶段 B 规范输出持久化后，再进入最终版本应用事务。若进程在“阶段 B 保存成功、版本尚未提交”之间重启，恢复时只执行版本应用，不再次调用模型。

### 7.5 通用模型任务冻结信封校验

收紧 `createModelTask()` / `createModelTaskTracker()` 的既有幂等任务处理：

- 同一 `task_kind + idempotency_key` 已存在时，比较非空的 `input_hash`、冻结 provider、model、profile、protocol 和冻结上下文哈希。
- 任一不一致返回 `model_task_idempotency_conflict`，不得认领旧任务并使用新输入。
- 对历史任务的空字段保持兼容；只有新调用方提供且既有任务也具有对应冻结字段时执行严格比较。
- 增加跨调用方回归测试，防止通用收紧影响自动分析、周期复盘或模型比较。

### 7.6 恢复矩阵

| 中断位置 | 恢复行为 |
|---|---|
| generation 冻结前 | 同 generation 重新执行原子冻结初始化 |
| 阶段 A 请求前 | 认领同一阶段任务 |
| 阶段 A 供应商状态未知 | 对账，禁止盲目重复请求 |
| 阶段 A 规范输出已保存 | 跳过阶段 A，进入阶段 B |
| 阶段 B 供应商状态未知 | 对账，禁止重复请求 |
| 阶段 B 规范输出已保存 | 只执行版本应用事务 |
| 最终版本已提交但 job 未完成 | 根据版本内容哈希恢复 job 为 succeeded |
| 业务 deadline 已过且无可应用结果 | 当前 generation 失败，等待人工重试 |
| 冻结模型配置已变化 | 当前 generation 失败，人工重试创建新冻结上下文 |

### 7.7 批次 B 验收门

- 进程在阶段 A、阶段 B和最终应用事务的每个边界被强制终止后，都能得到确定结果。
- 已持久化阶段不重复调用供应商。
- 同 generation 的两个阶段使用相同记忆库和模型配置哈希。
- 人工重试生成新的 generation 和两条新 stage row，旧记录保持不变。
- 同一模型任务幂等键不能被不同输入、不同模型或不同冻结上下文复用。
- 总业务 deadline 不因自动恢复而延长。

## 8. 批次 C：收紧 case/job/version 状态机

### 8.1 权威状态转换

建议状态转换：

```text
queued -> generating -> draft
queued/generating -> failed
draft/edited/needs_revision -> approved
draft/edited/needs_revision -> deferred
draft/edited -> needs_revision
failed/deferred -> queued（仅人工 retry，新 generation）
approved -> approved（仅同版本幂等确认）
```

其他转换默认拒绝。

### 8.2 确认和编辑接口

- `approve/defer/mark_problem` 只允许当前 case 处于可人工处理状态。
- case 为 `queued/generating` 时，即使保留旧 `current_version_id` 供历史查看，也禁止确认、延后、标记问题和编辑。
- 已批准仍只允许相同批准版本的幂等 approve。
- 接口错误使用 `manual_trade_review_action_not_allowed_in_generation`，前端提示等待当前生成结束或失败。

### 8.3 worker 最终提交 CAS

最终应用事务同时锁定 case、job 和当前 generation 的 outcome stage，要求：

- job ID、generation number、lease token 和 leased 状态一致；
- case 状态属于 `queued|generating`；
- case 的当前版本仍等于 generation 冻结时记录的父版本；
- outcome stage 为 succeeded，输出哈希与待保存内容一致；
- 尚不存在相同 `(case_id, generation_no, output_hash)` 的模型版本。

任一条件不满足时不得覆盖用户状态，任务进入可审计的 stale/conflict 结果。

### 8.4 前端动作门控

- queued/generating/retry_wait 只显示进度和只读旧版本。
- 仅 `draft/edited/needs_revision` 显示编辑、确认、稍后处理和标记问题。
- failed 显示人工重试。
- deferred 显示人工重试或继续查看，不显示批准旧版本。
- 事件处理器执行前再次检查当前详情状态，不能只依赖按钮是否可见。

### 8.5 批次 C 验收门

- 重试期间对旧版本调用 confirm/edit 全部被后端拒绝。
- 用户状态变化与 worker 最终提交并发时，只有符合 CAS 的一方成功。
- 两个 worker 同时运行时只有有效 business lease 和 generation 可以写版本。
- approved case 不可重新打开、重试或切换版本。

## 9. 批次 D：精确证据原因与前端语义

### 9.1 结构化证据问题

保留 case 的稳定主错误码，同时从冻结证据派生 `evidence_issues`：

```json
[
  {
    "scope": "pre_entry",
    "timeframe": "H4",
    "category": "chan_structure",
    "data_status": "complete",
    "structure_status": "insufficient_structure",
    "code": "chan_structure_insufficient"
  }
]
```

稳定分类至少包括：

- `history_snapshot_changed`
- `terminal_clock_untrusted`
- `market_candle_gap`
- `market_candle_boundary_insufficient`
- `chan_data_incomplete`
- `chan_structure_insufficient`
- `chan_timeframe_unsupported`
- `market_data_plan_invalid`

API 不返回任意供应商文本、SQL 文本、堆栈或敏感数据。

### 9.2 前端展示

- “证据不足”下显示中文主原因。
- 展开项显示阶段、周期和数据/结构状态。
- `retry_wait` 显示“等待安全重试”，不能落到第一步“准备证据”。
- `status_unknown` 显示“正在确认模型服务状态，避免重复请求”。
- 结构不足但数据完整时显示“行情完整，当前窗口未形成足够缠论结构”，不得提示刷新 Bridge。

### 9.3 可观测性

增加不含交易敏感详情的结构化日志：

- case/job/generation/stage ID；
- frozen runtime hash、input hash、output hash；
- stage 状态转换和恢复分支；
- evidence issue code 与 timeframe；
- CAS 失败原因。

日志不得包含策略正文、记忆正文、模型完整输入输出、API Key、券商凭据或完整成交数据。

## 10. 批次 E：测试矩阵

### 10.1 选择上下文

- 正常签名令牌创建成功。
- 令牌签名篡改、用户不匹配、账户不匹配、过期被拒绝。
- 选择后推进时间但令牌仍有效，Bridge 请求继续使用原范围。
- Bridge 快照变化返回精确错误。
- 订单位于范围边界内外的测试。

### 10.2 缠论证据

- `data_complete=true + insufficient_bis`：数据完整、结构不足。
- K 线缺口或 continuity 可疑：数据不完整。
- 不支持周期、要求未知和缠论关闭。
- pre-entry 与 outcome 分别缺失，不能互相掩盖。

### 10.3 两阶段恢复

- 阶段 A 请求前、响应后、持久化后强制中断。
- 阶段 B 请求前、响应后、持久化后强制中断。
- 最终版本插入前后强制中断。
- 供应商状态未知时不重复请求。
- 同 generation 期间当前策略记忆更新，仍使用冻结版本。
- 同 generation 期间模型配置变化，安全失败而不是换模型继续。
- 人工重试创建新 generation，旧 stage/task 可追溯。

### 10.4 状态并发

- queued/generating 下 confirm/edit 被拒绝。
- retry 与 confirm 并发。
- worker apply 与 defer/mark_problem 并发。
- 双 worker 认领和双 apply。
- approved 幂等确认与非法重试。

### 10.5 测试层级

1. 纯函数和合同单元测试。
2. 真实 MySQL 事务与唯一键/CAS 集成测试。
3. 模拟进程中断的 worker 恢复测试。
4. 前端 DOM/状态机测试，不只搜索源码字符串。
5. 全量 `npm test`。
6. 公网只读版本、迁移、进程、静态资源和日志核验。
7. 经单独授权后，新 case 与旧失败 case 各一次端到端验收。

现有静态测试可以继续作为缓存键和关键接线保护，但不得再把 `toContain()` 视为状态机或恢复语义已经成立的证明。

## 11. 实施顺序与提交边界

建议拆为五个独立、可回滚提交：

1. `fix(ai): freeze manual review selection context and chan evidence semantics`
2. `feat(ai): persist manual review generation stage runs`
3. `fix(ai): fence manual review case and version transitions`
4. `fix(ai): expose precise manual review evidence states`
5. `test(ai): cover manual review time drift recovery and concurrency`

依赖关系：A → B → C → D → E。批次 B 的迁移和服务代码必须同一发布批次部署；不得先上线依赖新表的 worker。

每个批次完成后先运行聚焦测试。全部完成后再运行：

```powershell
npm test
git diff --check
```

提交、推送、合并 `main` 和公网部署仍是独立授权动作。

## 12. 发布与迁移策略

### 12.1 发布前

- 新迁移只增表、增索引，不修改旧迁移和现有业务行。
- 在接近生产数据规模的 MySQL 验证建表和索引耗时。
- 新代码读取旧 job 时，如果没有 stage row，只能按明确兼容规则初始化；处于旧 generation 中途的任务不得猜测阶段 A 结果。
- 部署前记录 queued/leased/failed 手动复盘任务数量，但不修改它们。

### 12.2 旧任务兼容

- 已成功且已有版本的旧 case 保持只读和可确认，不回填 stage 输出。
- 旧 failed/deferred case 只有用户人工重试后才创建新 generation stage rows。
- 部署时仍在 leased 且没有持久化阶段结果的旧任务，按旧安全策略进入失败并要求人工重试，不自动重发供应商请求。
- 不从历史日志或模型响应猜造阶段 A 规范结果。

### 12.3 公网验收

只读验收：

- `main`、运行目录和目标 commit 一致，工作树干净。
- `/health`、MySQL、Redis、Node 进程正常。
- 迁移 192 已记录，stage 表和唯一索引存在。
- `/ai/` 加载新 build 键，旧缓存不再引用旧逻辑。
- 启动日志无迁移、worker 或状态机错误。

写入型验收需要单独授权：

1. 新建一条手动复盘，验证签名选择上下文和缠论状态。
2. 对一条旧 failed case 人工重试，验证新 generation 和 stage rows。
3. 在测试环境模拟阶段中断；不在真实公网故意杀死生产模型请求。
4. 核对没有策略记忆、经验、策略、回测或交易副作用。

## 13. 回滚策略

- 代码回滚到上一稳定提交时保留迁移 192 和 stage 表，不删除数据。
- 旧代码忽略新表，不应影响现有 case/version/job 读取。
- 不执行 down migration，不删除 stage 记录或模型任务审计记录。
- 若批次 B 发布后出现阻断，停止领取新的手动复盘 job，再回滚应用代码；不得终止状态未知的供应商请求后直接重发。
- 已经由新逻辑完成的版本继续保留，回滚不得重写其 `current_version_id`。

## 14. 第一轮方案复审：安全与证据完整性

### 14.1 发现

初步方案准备让前端直接提交 `history_snapshot_id` 和范围。虽然 Bridge 最终仍会校验快照，但客户端可以篡改范围，无法证明这些字段确实来自服务器刚返回的候选上下文。

初步阶段恢复方案还准备在现有 job 单行上增加 `counterfactual_json`。人工重试会覆盖同一行，无法完整保留每个 generation 的阶段审计链。

### 14.2 调整

- 改为服务器签名的选择上下文令牌，客户端只负责原样回传。
- 改为新增 generation + stage 账本表，每个 generation 两条独立阶段记录。
- 规范输出先持久化，再推进下一阶段或最终应用。
- 冻结运行时不保存凭据，只保存非密钥配置和内容哈希。

### 14.3 复审结论

选择稳定性不能通过信任前端解决；恢复稳定性不能通过覆盖式 job 字段解决。签名上下文和追加式 stage 账本是满足安全、幂等和审计要求的必要设计。

## 15. 第二轮方案复审：兼容、发布与回归范围

### 15.1 发现

直接全局收紧模型任务幂等信封可能影响其他 AI 调用方；直接要求所有旧任务都有 stage row 也会让发布瞬间的历史任务不可读。只做 mock 测试仍无法证明 MySQL CAS 和唯一键行为。

### 15.2 调整

- 通用模型任务只在新旧双方均存在对应冻结字段时严格比较，历史空字段保持兼容。
- 旧成功 case 不回填；旧失败任务仅在人工重试后进入新 stage 合同。
- 迁移只新增表和索引，回滚保留数据。
- 增加真实 MySQL 并发/CAS 集成测试、worker 中断恢复测试和跨调用方模型任务回归。
- 将公网写入型验收与部署授权分离。

### 15.3 复审结论

方案能够渐进上线，不要求破坏或伪造历史数据；同时把通用模型任务收紧的影响限定在可验证范围内。

## 16. 剩余风险

1. **供应商状态未知。** 即使阶段账本完整，供应商不支持请求状态查询时仍不能证明未知请求是否完成；必须保持 fail closed，等待人工新 generation。
2. **模型配置删除。** 冻结 profile 被删除后无法恢复原 generation；只能失败并由人工重试使用新配置。
3. **记忆修订兼容。** 默认空记忆或早期没有 revision ID 的策略必须把完整冻结正文放入运行时上下文，不能只保存版本号。
4. **迁移表增长。** 每个 generation 固定两条 stage row，增长可控，但需要后续纳入保留期和审计归档评估；本次不删除历史。
5. **真实 Bridge 差异。** MT4、MT5 对 snapshot 和准备状态的能力不同，必须分别验收，不能只用 MT5 mock 推断 MT4。
6. **公网当前 case。** 截图只能证明前端显示 `chan_evidence_incomplete`；没有经认证读取该 case 的逐周期证据前，不能断言它具体属于 `insufficient_bis` 还是实际数据缺口。
7. **前端旧缓存。** 发布后已打开的旧页面仍可能短暂运行旧代码；需要新 build 键并提示硬刷新。

## 17. 完成定义

只有同时满足以下条件，才可以宣称手动交易复盘本轮修复完成：

- MTR-C01 至 MTR-C08 均有代码、测试和 finding-to-fix 映射。
- 聚焦测试、真实 MySQL 集成测试和全量测试通过。
- 迁移历史无重复、无已发布正文修改。
- dev_codex 与 main 的目标提交关系清晰，发布提交范围纯净。
- 公网运行 commit、迁移、进程、健康、静态资源和日志验证通过。
- 经明确授权的新 case 完成两阶段生成，旧失败 case 新 generation 能恢复。
- 未产生策略记忆、经验、策略、回测、发布或交易副作用。
- 对仍无法确认的供应商状态和真实终端能力明确标记验证限制，不用测试替代生产证据。

## 18. 本地实施记录（2026-08-17）

- 已实现签名选择上下文、权威范围/快照复验，以及缠论数据状态与结构状态分离。
- 已新增迁移 192 和按 generation 追加的两阶段账本；阶段输入、冻结运行时和规范输出均带哈希并受业务租约围栏保护。
- 已改为两个独立模型任务，支持复用已持久化阶段结果；状态未知只等待对账且不消耗业务重试次数。
- 已收紧确认、编辑和最终版本应用的状态/CAS 条件；旧版本在新 generation 期间只读。
- 已输出结构化 `evidence_issues`、精确中文原因和安全等待进度，并刷新 JS/CSS 静态缓存键。
- 已补选择令牌、证据维度、阶段账本、模型任务幂等、状态门控和前端接线测试。
- 尚未执行真实 MySQL 并发测试、公网迁移/部署或写入型端到端验收，因此本节不替代第 17 节的完整完成定义。
