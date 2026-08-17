# 手动交易复盘全面修复方案

## 1. 文档状态

- 文档类型：修复方案与本地实施记录
- 方案状态：已完成本地实现与相关回归；尚未提交、推送、部署或生产验收
- 审计基线：`dev_codex` / `b4aa45477dc8cb3d65c51920185d168144a9c39c`
- 公网基线：`main` / `b4aa45477dc8cb3d65c51920185d168144a9c39c`
- 公网目录：`/www1/wwwroot/aurum-ai`
- 编写日期：2026-08-17
- 当前授权边界：已授权修改业务代码；未授权提交、推送、部署、重试公网任务或修改生产数据库

## 2. 目标

把当前手动交易复盘从“基本链路存在，但证据和恢复不稳定”修复为满足以下条件的生产功能：

1. 只复盘当前账号最近 7 天内完整平仓、净利润大于 0、未绑定平台信号的单笔交易。
2. 创建任务时重新核验账户、终端路由、成交链、活动持仓、平台信号绑定和来源哈希。
3. 严格执行两阶段冻结：先做开仓前盲测，再读取成交结果做盈利归因。
4. 行情证据按真实 K 线闭合边界判断，不把正常的最后已闭合 K 线误判为截断。
5. 冻结策略要求什么证据，复盘就读取和验证什么证据，包括缠论要求。
6. 模型输出必须满足严格合同，所有策略路径和证据引用必须能够闭环验证。
7. 自动重试、人工重试、进程重启和页面长时间隐藏后均能恢复，不重复创建业务 case 或终态模型任务。
8. 用户可以在选择页和复盘历史页之间双向导航，并看到中文、可操作、与真实状态一致的提示。
9. 复盘确认不写入经验、记忆或策略，不自动回测、不自动发布策略。
10. MT4 只承诺终端“账户历史”当前可见范围，不宣称券商全量历史。

## 3. 非目标与必须保留的业务边界

本次不得顺带引入以下变化：

- 不恢复旧方案中的 1–10 笔批量复盘；当前合同保持每次一笔。
- 不创建平台经验候选，不写入统一策略记忆库。
- 不自动修改策略，不把模型假设标记为已验证规则。
- 不把“未绑定平台信号”伪装成“已证明人工点击”。外部 EA 未绑定平台信号时仍可能进入候选。
- 不放宽管理员和观摩源账号的权限边界。
- 不允许管理员选择其他用户或非当前权威绑定账户进行复盘。
- 不修改已执行的 `178_manual_trade_strategy_review` 迁移正文。
- 不对公网失败任务或历史数据执行 SQL 清洗、删除、补写或自动重试。
- 不用单元测试代替真实 MySQL、Redis、Bridge、浏览器和公网验证。

## 4. 已确认问题与修复映射

| 编号 | 等级 | 问题 | 主要位置 | 修复阶段 |
|---|---|---|---|---|
| MTR-01 | 高 | 正常已闭合 K 线被误判为 `truncated_before_exit` | `server/routes/ai/review-market-path.js` | 阶段 A |
| MTR-02 | 高 | 外层任务重试早于通用模型租约到期，耗尽重试 | `manual-trade-review.js`、`model-task-runtime.js` | 阶段 B |
| MTR-03 | 高 | 人工重试可能复用终态模型任务的幂等键 | `manual-trade-review.js` | 阶段 B |
| MTR-04 | 高 | 所谓固定 30 分钟业务截止时间会在外层重试时重算 | `manual-trade-review.js` | 阶段 B |
| MTR-05 | 高 | 开启缠论的冻结策略没有获得缠论证据 | `manual-trade-evidence.js` | 阶段 A |
| MTR-06 | 高 | 模型允许的策略路径与冻结快照字段不一致 | `manual-trade-review.js` | 阶段 C |
| MTR-07 | 中高 | 必填模型字段可以被空值默认化后保存 | `manual-trade-review.js` | 阶段 C |
| MTR-08 | 中 | 模型 `evidence_refs` 没有与冻结证据闭环 | `manual-trade-review.js` | 阶段 C |
| MTR-09 | 中 | MFE/MAE、SL/TP 触达包含入场前或平仓后的整根 K 线 | `review-market-path.js` | 阶段 A |
| MTR-10 | 中 | 点击“新建复盘”后没有返回历史入口 | `public/ai/index.html`、`app.js` | 阶段 D |
| MTR-11 | 中 | 页面隐藏或一次轮询失败后不会恢复轮询 | `public/ai/app.js` | 阶段 D |
| MTR-12 | 中 | 快速切换复盘详情存在旧响应覆盖新选择的竞态 | `public/ai/app.js` | 阶段 D |
| MTR-13 | 中 | 创建请求超时后重新点击会更换幂等令牌 | `public/ai/app.js` | 阶段 D |
| MTR-14 | 中 | 已批准版本仍可通过接口重新指向旧版本或改变状态 | `manual-trade-review.js` | 阶段 C |
| MTR-15 | 中 | 内部证据错误码直接显示，case/job 状态语义不一致 | 后端详情接口、`public/ai/app.js` | 阶段 D |
| MTR-16 | 文档 | 原方案仍描述多笔复盘和平台经验候选 | 旧实施方案 | 阶段 E |

## 5. 总体实施顺序

```mermaid
flowchart LR
  A[阶段 A<br/>证据正确性] --> B[阶段 B<br/>任务恢复与幂等]
  B --> C[阶段 C<br/>输出与版本合同]
  C --> D[阶段 D<br/>前端状态机]
  D --> E[阶段 E<br/>文档与全链路验收]
  E --> F[提交 dev_codex]
  F --> G[合并 main 并部署]
  G --> H[公网只读核验]
  H --> I[经明确授权的新任务验收]
```

不得跳过阶段 A 直接通过放宽模型校验让任务“成功”。证据状态错误必须先被修正，模型输出校验仍应保持 fail-closed。

## 6. 阶段 A：修复证据正确性

### 6.1 K 线闭合边界

#### 现状

当前逻辑用 `cutoff - timeframeMs` 作为最后一根已闭合 K 线的最早开盘时间。交易时间位于 K 线内部时，这个值不是周期边界，会误判正常行情缺失。

#### 方案

新增单一、可测试的周期对齐函数，例如：

```text
expectedLatestClosedOpen(cutoff, timeframeMs)
  = floor(cutoff / timeframeMs) * timeframeMs - timeframeMs
```

语义必须覆盖：

- 截止时间恰好位于周期边界：上一根 K 线才是已闭合 K 线。
- 截止时间位于周期内部：当前正在形成的 K 线不能作为已闭合证据。
- 最后已闭合开盘时间等于期望值：证据完整。
- 最后已闭合开盘时间早于期望值：才标记末端截断。
- 时间戳无效、周期未知或行情为空：fail-closed，不生成伪完整状态。

`truncated_before_entry` 和 `truncated_before_exit` 应分别记录精确原因，不能只返回通用 `market_evidence_unavailable`。

#### 预计文件

- `server/routes/ai/review-market-path.js`
- `tests/ai/review-market-path.test.js`
- `tests/ai/manual-trade-review-history.test.js`

#### 验收

- M5/M15/H1/H4 都覆盖“边界时刻、周期内部、确实缺一根、未来 K 线”四类测试。
- 使用公网 case #1 已冻结时间戳构造无敏感数据的回归夹具，证明正常最后闭合 K 线不再被误判。
- 真实缺口仍返回 partial/unavailable，不能为了通过 case #1 而整体放宽。

### 6.2 缠论证据透传

#### 方案

从冻结策略快照解析与现有策略推理相同的 `chanRequirement`，显式传给开仓前路径和事后路径构建器。

- `use_chan_analysis=false`：明确传递 disabled，不读取缠论证据。
- `use_chan_analysis=true` 且要求合法：按冻结参数读取，结果进入冻结证据和哈希。
- 开启但要求缺失或格式无效：证据状态不得静默变成 complete，应返回可定位的 partial/unavailable 原因。
- 禁止在手动复盘模块硬编码某套缠论周期或参数。

#### 预计文件

- `server/routes/ai/manual-trade-evidence.js`
- 复用现有策略/缠论要求解析器；若不存在稳定公共函数，再抽取最小公共函数
- `tests/ai/manual-trade-review-history.test.js`
- `tests/ai/review-market-path.test.js`

#### 验收

- 开启/关闭/无效缠论配置各有测试。
- 测试不仅断言调用次数，还断言 `chanRequirement` 的实际内容和冻结哈希变化。

### 6.3 持仓路径指标精度

#### 方案

不得把整根入场 K 线和整根平仓 K 线的高低点表述为精确持仓内指标。

建议采用以下保守合同：

1. 仅完整位于入场与平仓之间的 K 线用于严格 MFE/MAE、SL/TP 触达。
2. 入场和平仓所在的边界 K 线单独标记为 `boundary_candle_partial`。
3. 没有 tick 或更低周期证据时，边界 K 线只能形成“可能触达”，不能形成“已触达”。
4. 输出增加 `metric_precision: exact|bar_bounded|insufficient` 和说明字段。

如果现有输出合同不适合新增字段，可先将边界 K 线排除并明确 `bar_bounded`，不得伪装为 tick 级精确结论。

#### 验收

- 入场前高点、平仓后低点不会进入严格持仓区间。
- 做多/做空、同一根 K 线内开平仓、跨多根 K 线均有测试。

## 7. 阶段 B：修复任务恢复、租约和幂等

### 7.1 状态机原则

手动复盘业务 job 是业务编排者，`ai_model_tasks` 是模型调用账本。二者必须遵守：

- 一个业务 job 在一次 generation epoch 内只绑定一个模型任务身份。
- 外层重试不能在模型任务仍有有效租约时消耗业务重试次数。
- 自动恢复继续同一 generation epoch；人工重试创建新的 generation epoch。
- 业务 deadline 持久化一次，自动恢复不得延长。
- 终态模型任务不得被新的人工重试当作可继续任务。

### 7.2 推荐数据设计

优先增加新的纠正迁移，而不是修改迁移 178。建议字段：

- `generation_no INT NOT NULL DEFAULT 1`
- `task_deadline_at DATETIME NULL`
- 可选：`last_model_task_id CHAR(36) NULL`，仅当现有 `model_task_id` 无法同时表达当前与历史引用时增加

唯一身份建议：

```text
manual_trade_review:{job_id}:generation:{generation_no}
```

不再把 `attempt_count` 放入模型任务幂等键。`attempt_count` 是业务执行次数，不是业务身份。

若经实现验证可以不增加字段，并能从已持久化模型任务 deadline 稳定恢复，也可采用无迁移方案；但必须用真实 MySQL 测试证明进程重启后不会重新获得 30 分钟窗口。

### 7.3 自动恢复

#### 规则

- 当前模型任务为 `queued/retry_wait` 且租约有效：业务 job 延后到模型租约可认领时间，不增加失败次数。
- 当前模型任务为可重试且租约已过期：认领同一任务继续执行。
- 当前模型任务为 `succeeded`：按持久化结果引用恢复业务提交；不能再次调用供应商。
- 当前模型任务为终态失败：业务 job 按明确分类进入失败或等待人工重试，不能生成相同终态幂等键。
- 业务 deadline 已过：进入 `failed`，提示人工重试；自动恢复不得刷新 deadline。

### 7.4 人工重试

人工重试事务中必须：

1. 锁定 case 和 job，并再次确认操作者归属与允许状态。
2. `generation_no + 1`。
3. 清理当前 `model_task_id` 绑定或移动为历史引用。
4. 生成新的 generation 幂等身份。
5. 写入新的固定 `task_deadline_at`。
6. 重置业务 attempt/lease/error 状态。
7. 写审计日志。
8. 事务提交成功后唤醒 worker。

不得删除旧模型任务；旧任务是审计账本。

### 7.5 两阶段供应商调用

当前开仓前盲测和事后归因共用一个模型任务账本。修复时必须明确二选一：

- 推荐：仍保留一个业务模型任务，但在冻结上下文和 provider attempt 中明确 stage；同一总 deadline 下顺序执行。
- 如果拆成两个模型任务：必须增加父子关系、阶段幂等键、预算合计和原子提交设计，不能在本次修复中临时拆分。

本方案推荐保持一个任务，减少迁移和恢复复杂度。

### 7.6 预计文件

- `server/routes/ai/manual-trade-review.js`
- `server/routes/ai/model-task-runtime.js`（仅在通用租约语义确实需要调整时修改）
- `server/routes/ai/model-task-tracker.js`
- `server/migrations.js`（如采用持久化 generation/deadline）
- `tests/ai/manual-trade-review.test.js`
- `tests/ai/model-task-runtime.test.js`
- 新增针对自动/人工恢复的集成测试文件

### 7.7 验收矩阵

至少覆盖：

| 场景 | 期望 |
|---|---|
| 模型租约仍有效，外层 worker 被唤醒 | 不消耗 attempt，延后认领 |
| 模型租约过期 | 同 generation 恢复 |
| 模型任务 HTTP 200、内容校验失败 | 分类为输出校验失败，可按政策重试 |
| 模型任务终态失败后人工重试 | 新 generation、新幂等键 |
| 进程在阶段 A 后重启 | 不泄漏真实结果到盲测，不重复阶段 A |
| 进程在阶段 B 响应后、版本提交前重启 | 恢复提交或安全重做，不重复版本 |
| deadline 已过 | 自动失败，等待人工重试 |
| 两个 worker 并发 | 只有一个持有业务租约并提交版本 |

## 8. 阶段 C：收紧模型输出、策略引用和版本治理

### 8.1 统一策略快照路径

定义唯一的模型可见路径空间，建议以实际冻结快照为准：

- `strategy_policy`
- `market_data_plan`
- `entry_methods`
- `symbols`
- `use_chan_analysis`

实现一个公共 `validateFrozenStrategyPath(path, snapshot)`：

1. 路径根必须在允许列表内。
2. 路径必须能够在冻结快照中解析到真实节点；不存在的路径拒绝。
3. 禁止原型链、`__proto__`、`constructor` 等危险片段。
4. 空路径只允许表示“仅观察，不指向具体规则”，并必须使用明确状态。

不要同时长期支持 `_json` 和非 `_json` 两套模型路径。若为了兼容历史 v1 内容需要读取旧路径，只在展示层转换，不让新模型继续产生旧路径。

### 8.2 严格输出合同

把“提示词说必须包含”变成服务器实际强制：

- `review_summary`、`why_profitable`、`outcome_independence_note` 必须是非空、长度受限字符串。
- 枚举字段必须显式存在，不允许用默认值掩盖缺失。
- `profit_attribution` 必须是对象，规定的子字段必须存在。
- 数组字段必须存在；允许为空时也要显式为空数组。
- `counterfactual_analysis.reasoning` 在 `insufficient_evidence` 时仍需说明缺失证据。
- 完整证据不能返回 `evidence_quality=insufficient` 而没有明确原因；部分证据只能返回 insufficient。
- 所有字符串、数组数量和整体 JSON 大小继续受限。

### 8.3 证据引用闭环

建立冻结证据引用目录，例如：

```text
trade:{source_identity_hash}
market:{source_identity_hash}:pre_entry:{timeframe}
market:{source_identity_hash}:outcome:{timeframe}
chan:{source_identity_hash}:{timeframe}
strategy:{validated_path}
```

- 模型只能引用目录中存在的 ID。
- `counterfactual.evidence_refs` 只能引用开仓前允许集合，不能引用 outcome、方向、利润和用户陈述。
- 事后规则对照可以引用完整集合。
- 保存版本前再次验证引用闭环。

### 8.4 批准版本锁定

推荐合同：

- `approve` 只能批准当前版本，客户端必须提交 `expected_version_id`。
- case 已 approved 后，重复批准同一版本可幂等返回成功。
- 已 approved 后不能直接改成 needs_revision/deferred；需要先执行单独、带审计的“重新打开复盘”动作。该动作本次默认不实现。
- 编辑仍创建新版本，不覆盖冻结证据和盲测结论。

### 8.5 提示词一致性

提示词必须显式说明：

- 输出 `evidence_quality` 必须等于服务器提供的允许状态。
- 策略路径使用实际冻结快照字段。
- 证据引用只能从给定引用目录选取。
- 部分证据不得输出可直接应用的策略建议。

提示词只能帮助模型，最终仍以服务器验证为准。

### 8.6 验收

- 空对象、缺字段、空必填文本、错误枚举、虚构 evidence ref、旧 `_json` 路径均被拒绝。
- 正确的 `strategy_policy...` 等实际路径被接受。
- 盲测引用 outcome 证据被拒绝。
- 历史 v1 版本若存在仍可只读展示，但不能绕过 v2 写入合同。

## 9. 阶段 D：修复前端状态机和可恢复交互

### 9.1 页面导航

将手动复盘明确为三个可逆视图：

```text
selection <-> strategy
selection <-> result/history
strategy  -> result（创建成功）
```

- 选择阶段标题区增加“查看复盘历史”。
- 策略阶段保留“返回选择订单”，同时增加“查看复盘历史”。
- 结果阶段“新建复盘”只清理当前草稿选择，不清空历史缓存和当前历史可达性。
- 刷新页面后默认视图可以保持 selection，但必须始终能进入 history。
- URL/hash 是否保存子视图可作为增强项，不是本轮必要条件。

### 9.2 创建幂等令牌

- 用户第一次进入一次创建草稿时生成 `client_request_id`，保存于前端 state。
- 网络超时、5xx 或未知结果后，重试使用同一个令牌。
- 明确收到创建成功、恢复已有任务，或用户主动放弃/重新选择来源后才轮换令牌。
- 后端继续使用 `(user_id, client_request_id)` 唯一约束，并捕获并发唯一键冲突后查询返回已有 case。

### 9.3 轮询恢复

- 页面 hidden 时暂停定时器，但保留“需要轮询”状态。
- `visibilitychange` 回到 visible 后立即刷新一次详情，再恢复轮询。
- 临时网络错误采用有上限退避并继续轮询；401/403、not found 和终态错误停止。
- 所有轮询响应必须校验 generation 和 case ID。
- 组件离开、选择其他 case、退出登录时必须停止旧轮询。

### 9.4 详情竞态

为 `openManualTradeReviewDetail` 增加请求 generation 或 AbortController：

- 请求完成时只有 case ID 和 generation 都等于当前选择才允许写入 state。
- 旧请求的 catch/finally 也不能覆盖当前详情的 loading/error/polling 状态。

### 9.5 状态和错误文案

- 详情状态优先展示 job 的实际进度；case 状态表示业务结果，二者不要混为一个字段。
- worker 开始后 case 可更新为 `generating`，或前端明确组合成“生成中 · 开仓前盲测”。
- 后端保存精确证据原因，前端通过稳定错误码翻译中文。
- `market_evidence_unavailable` 只作为总类，不直接展示给用户。
- 对用户至少区分：行情尚未闭合、指定周期缺 K 线、缠论证据缺失、模型输出格式错误、等待模型任务租约、达到重试上限。

### 9.6 旧 v1 展示代码

`public/ai/app.js` 仍含平台经验候选的旧版渲染分支。本轮先做引用和生产数据检查：

- 若存在历史 v1 版本，保留只读兼容并补注释/测试。
- 若确认数据库、API 和公网都不存在可达 v1 数据，再单独删除。
- 不把删除旧渲染与生产故障修复混在同一提交。

### 9.7 静态缓存

前端变更后：

- 更新 `/ai/app.js` 的统一 `v=` 缓存键。
- 在现有 `build=` 中追加本次手动复盘修复标识。
- 更新静态缓存回归测试，确认所有入口引用同一版本。

## 10. 阶段 E：文档、测试和验收

### 10.1 文档权威化

将当前 v2 合同明确标为权威：

- 单笔盈利、完整平仓、未绑定平台信号。
- 两阶段冻结。
- 只生成待验证假设。
- 不写经验、记忆或策略。
- MT4 仅终端可见历史。

旧文档不得继续把 1–10 笔和平台经验候选描述为当前行为。处理方式二选一：

1. 在旧方案顶部增加“已被 v2 合同取代”的醒目标记，并链接本文档；或
2. 新建 `manual-trade-review-v2-contract.md`，旧方案只作为历史设计保留。

推荐第二种，避免把修复步骤和长期业务合同混在一起。

### 10.2 定向测试

至少运行：

```powershell
npx vitest run `
  tests/ai/manual-trade-review.test.js `
  tests/ai/manual-trade-review-history.test.js `
  tests/ai/manual-trade-review-output.test.js `
  tests/ai/manual-trade-review-static.test.js `
  tests/ai/manual-trade-review-frontend.test.js `
  tests/ai/review-market-path.test.js `
  tests/ai/model-task-tracker.test.js `
  tests/ai/model-task-runtime.test.js `
  tests/ai/strategy-memory-runtime-wiring.test.js
```

同时执行相关文件 `node --check`。

### 10.3 必须新增的回归测试

- 周期内部截止时间不会误判行情截断。
- 真实缺 K 线仍 fail-closed。
- 缠论要求透传并进入证据哈希。
- 部分证据下模型错误声称 complete 会得到稳定、可重试的分类。
- 自动恢复不会在有效模型租约内消耗 attempt。
- 人工重试会轮换 generation 和幂等键。
- 业务 deadline 跨进程恢复不延长。
- 创建超时后相同 client ID 返回同一 case。
- 返回历史按钮始终可达。
- hidden/visible 和一次网络失败后恢复轮询。
- 快速切换 A/B 详情时 A 不覆盖 B。
- 批准只能针对当前版本，重复批准同一版本幂等。

### 10.4 全仓和依赖验证

- 运行 `npm test`，把 Bridge 发布工具的环境型失败与本次回归分开记录。
- 运行 `npm audit --omit=dev`；`nanoid` 间接依赖升级独立成批，不与手动复盘修复混提交。
- 如果修改 Rust/MT4/Bridge 合同，再运行对应 Rust/MT4 测试；若未修改，不把真实 MT4 标成已验收。

### 10.5 本地浏览器验收

使用管理员现有登录态验证：

1. 进入选择页，再进入历史页，再返回选择页。
2. 选择一笔订单、选择策略、创建任务。
3. 观察准备证据、开仓前盲测、事后复盘、完成四个阶段。
4. 页面隐藏超过一个轮询周期后恢复。
5. 模拟一次详情接口失败后自动恢复。
6. 快速切换历史 case，确认无旧响应覆盖。
7. 检查控制台和网络请求无未处理错误、重复创建或无限轮询。

创建真实模型任务属于有副作用验收，必须在实施后再次获得明确授权。

## 11. 数据库与迁移方案

### 11.1 是否需要迁移

- 阶段 A、C、D 本身不需要修改现有业务表。
- 阶段 B 如果采用持久化 `generation_no/task_deadline_at`，必须追加新迁移，不能修改 178。

### 11.2 新迁移要求

- 使用当时最新、未占用的迁移 ID。
- 新字段默认值必须兼容现有 case/job。
- 历史失败 job 的 deadline 不做猜测性回填；可以保持 NULL，并在人工重试时建立新 generation。
- 新索引或唯一约束必须评估现有行和锁表成本。
- 迁移自身可重复安全执行，不只依赖 `schema_migrations` 防重。
- 部署后查询迁移 ID和 generation/deadline 不变量。

### 11.3 禁止的数据操作

- 不删除公网 case #1。
- 不直接把 partial 改成 complete。
- 不手工插入复盘版本。
- 不修改模型响应或冻结证据 JSON。
- 不在部署过程中自动重试旧任务。

旧失败任务在新版本部署后，应由管理员显式点击重试，触发新的 generation；这一步需要单独授权。

## 12. 提交与发布建议

建议分为三个可独立审查的提交：

1. `fix(ai): correct manual review evidence boundaries`
   - K 线边界、缠论透传、路径指标精度及测试。
2. `fix(ai): harden manual review recovery and output contracts`
   - generation/deadline、租约恢复、人工重试、输出/引用/批准合同及测试。
3. `fix(ai-ui): make manual review navigation and polling recoverable`
   - 返回历史、创建幂等、轮询、竞态、中文状态、缓存键及测试。

每个提交完成后先推送 `dev_codex`。全部验收通过后再按明确授权合并到 `main`、部署公网。不得把“提交推送”解释为自动部署。

## 13. 公网部署与验收门

### 13.1 部署前

- 本地工作树只包含计划内文件。
- `dev_codex` 提交已推送且 CI/本地测试满足门槛。
- `main` 合并保持历史，目标提交明确。
- 如有迁移，先备份并核对表规模、字段现状和迁移 ID。
- 不自动重试 case #1。

### 13.2 部署后只读检查

- 公网目录为预期目录、分支为 `main`、提交为目标提交、工作树干净。
- `/health` 中数据库和 Redis 正常。
- 迁移 ID存在，job/case/version/source 无孤儿。
- Node 进程启动日志没有迁移、worker、模型任务恢复错误。
- `/ai/app.js` 的 `v=` 和 `build=` 为目标版本。
- 管理员页面可双向进入选择和历史。

### 13.3 有副作用的最终验收

获得明确授权后，新建一条专用测试复盘，记录：

- case/job/model task ID；
- 冻结策略、交易来源和行情证据哈希；
- M5/M15/H1/H4 闭合边界；
- 若策略开启缠论，记录缠论证据状态；
- 两阶段模型调用和总 deadline；
- 最终版本内容哈希；
- 未产生经验、记忆和策略写入的证明。

不要用旧 case #1 的成功重试替代新任务验收。旧任务适合验证人工重试恢复，新任务适合验证完整创建链路，两者是不同验收项。

## 14. 回滚方案

### 14.1 应用回滚

- 回滚到部署前已记录的 `main` 提交并重启 BaoTa Node 项目。
- 回滚后核对 `/health`、静态缓存键和启动日志。
- 不用 `git reset --hard` 清理未知工作树；按部署流程使用明确提交。

### 14.2 数据兼容

- 新增字段必须保证旧应用可忽略。
- 应用回滚不删除新增列、不删除新 generation 的审计任务。
- 若旧应用无法理解新 job 状态，则迁移方案不得引入新 enum 状态；优先复用已有状态并增加独立字段。

### 14.3 回滚触发条件

- 任务重复创建或同一 generation 出现多个有效模型任务。
- 部分证据被保存为 complete。
- 盲测请求包含真实交易方向、成交结果或利润。
- worker 并发提交多个当前版本。
- 部署后健康检查、迁移不变量或管理员权限失败。
- 前端缓存导致新旧合同混用。

## 15. 第一轮方案复审

### 发现的问题

1. 如果只修 `truncated_before_exit`，会让 case #1 继续进入模型任务，但租约冲突仍会把它耗尽，因此证据和恢复必须分阶段连续实施。
2. 如果简单延长外层重试间隔，不能解决进程重启、人工重试和 deadline 延长问题，因此需要 generation 身份和持久化 deadline。
3. 如果同时允许 `_json` 和非 `_json` 路径，会形成长期双合同，因此新生成只接受实际快照路径，旧内容仅展示兼容。
4. 如果删除旧 v1 前端分支，可能破坏历史版本查看；删除必须独立验证。
5. 如果部署后自动重试失败 case，会产生模型费用和数据库写入，超出修复部署授权。

### 已作调整

- 把任务身份从 attempt 改为 generation。
- 把 deadline 持久化作为首选，而不是每次 worker 计算。
- 增加证据引用目录和盲测/事后引用隔离。
- 把旧 v1 清理移出故障修复提交。
- 把公网只读验收和有副作用任务验收分开。

## 16. 第二轮方案复审

### 复审结论

方案已经覆盖：证据边界、缠论、模型输出、租约、自动/人工重试、版本确认、前端导航、轮询、并发、缓存、迁移、测试、部署和回滚。

### 仍需在实施时验证的风险

1. 通用 `ai_model_tasks` 是否已有可直接复用的持久化业务 deadline；若有，应避免重复字段。
2. 供应商 HTTP 200 但输出校验失败时，通用 tracker 的最佳状态分类需要与其他模型任务保持一致，不能只为手动复盘改变全局语义。
3. 真实 MT4 端到端需要明确配置的测试终端；静态 EA 合同和单元测试不能代替真实终端。
4. 公网目前只有一个失败 case，无法证明旧 v1 数据完全不存在；旧渲染分支暂不删除。
5. K 线只能提供 bar 级证据；没有 tick 数据时不能承诺边界 K 线内的精确 SL/TP 先后顺序。

### 实施准入条件

用户明确授权“开始修复”后，才进入代码实施。实施应严格保留本方案的问题编号和提交边界；发现会改变业务定义、迁移设计或通用模型任务语义的新事实时，先暂停并更新方案，不自行扩大范围。

## 17. 本地实施结果（2026-08-17）

### 已完成

- 阶段 A：修正已闭合 K 线边界、持仓区间 bar 级指标边界，并按冻结策略透传和校验缠论要求。
- 阶段 B：新增迁移 191，持久化 generation 和固定业务 deadline；自动恢复不消耗有效通用任务租约的外层次数；人工重试创建新 generation；已提交版本对应的 succeeded 通用任务可恢复业务 job。
- 阶段 C：建立 v2 严格输出合同、冻结策略真实路径校验、阶段隔离的证据引用目录、空必填字段拒绝、当前版本批准和批准后锁定。
- 阶段 D：选择页和策略页均可进入历史；创建结果未知时保留 client request ID；页面隐藏后恢复轮询；临时错误指数退避；详情请求使用代次屏障防止旧响应覆盖。
- 阶段 E：新增 v2 权威合同，并把旧实施文档标记为历史资料。

### 实施中确认的调整

1. `ai_model_tasks` 只保存结果哈希和引用，不保存可直接重放的完整模型 JSON。恢复逻辑仅在业务版本已提交时把 `succeeded` 通用任务恢复为业务成功；若版本未提交则 fail-closed，要求人工创建新 generation，禁止重新使用相同终态任务。
2. 静态缓存只追加本功能的 `build=manual-review-frontend2`，保留全站共享 `v=`，避免无关页面整体失效。
3. 新迁移只增加兼容列，不回写历史行；历史 NULL deadline 在首次认领事务内只填充一次。

### 两轮代码复审结论

- 第一轮：补齐了历史 NULL deadline 被自动重算、已完成通用任务恢复和并发创建唯一键回放三个边界。
- 第二轮：确认 v2 新生成不接受旧 `_json` 路径；批准后不能降级或切换版本；旧 v1 禁止内容编辑且不恢复经验候选操作入口，既有确认状态接口保持兼容。

### 尚未执行

- 未提交或推送任何分支。
- 未合并 `main`，未部署公网，未执行迁移 191。
- 未重试公网 case #1，未创建生产验收任务，未修改生产数据。
- 真实 MySQL、Redis、Bridge、MT4/MT5 和公网浏览器验收仍受第 13 节验收门约束。
