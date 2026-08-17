# 手动交易复盘 v3 审计后修复方案

## 1. 文档状态

- 方案类型：审计后纠正方案，仅描述实施步骤，不代表已经修复或部署
- 基线仓库：`D:\dev_codex\wall-street-skill-local`
- 基线分支：`dev_codex`
- 基线提交：`efbef85fb87ce714541350fa29b67acfe831401f`
- 审计结论：当前实现具备单笔 v3 候选点和多版本综合分析主体能力，但合同识别、综合冻结信封、最终应用围栏、总 deadline、前端幂等和保护证据绑定仍未闭环
- 实施授权：本文不授权修改业务代码、执行迁移、调用真实模型、合并 `main` 或部署公网

## 2. 必须保留的业务合同

本轮修复不得改变以下已确认边界：

1. 新建单笔复盘一次只选择一条已完成人工交易。
2. 开仓前盲测看不到真实方向、真实开仓价、真实止盈止损、盈亏、持仓路径和用户事后说明。
3. 当前策略定义为创建复盘时冻结的平台策略版本，并使用其完整冻结记忆库作为非权威经验参考。
4. 每个历史候选点只读取该时点已经闭合、当时可获得的证据；后一候选点不得向前一候选点泄漏行情。
5. 事后阶段才解释为什么盈利、采用了什么技术分析、当前策略是否会在合理时间偏移内同方向入场，以及建议止盈止损是否合理。
6. 多条综合分析只选择同一用户、同一交易账号、同一策略的固定复盘版本，最少 2 条、最多 20 条。
7. 单笔和综合分析只产生待人工验证的结论或假设，不自动修改策略、写入策略记忆、创建经验候选、触发回测、发布策略或发送交易命令。
8. 已有 v2 历史继续可读；旧任务不能因为 v3 修复被误判、覆盖或自动重跑。

## 3. 审计问题与修复映射

| 编号 | 等级 | 已确认问题 | 修复批次 |
| --- | --- | --- | --- |
| F1 | 高 | 新任务在候选行情缺少 `candles` 字段时会省略 `counterfactual_points`，worker 随后静默走 v2 | A |
| F2 | 高 | 综合任务没有冻结完整模型运行时，最终应用也未复验输入、提示词和输出合同哈希 | B |
| F3 | 中 | 综合任务创建后仍受来源 case 实时状态影响，固定版本可能被后续 `deferred` 状态否定 | B |
| F4 | 中 | 综合任务前端每次点击生成新请求 ID，双击或超时重试会创建重复任务 | D |
| F5 | 中 | v3 的 4–6 次串行模型调用仍共用固定 30 分钟总 deadline | C |
| F6 | 中 | 业务版本先提交、模型任务后标记成功，末步失败会产生业务成功但任务失败/停滞的分裂状态 | C |
| F7 | 中 | 模型返回的周期未绑定冻结证据；ATR 通过递归取第一个值，可能使用错误周期 | A |
| F8 | 低 | 综合进度、策略筛选、入口上下文和轮询恢复不准确 | D |

## 4. 总体修复原则

### 4.1 明确合同，不再用数据形状猜版本

新建任务必须显式写入复盘合同版本。数据缺失只能形成该合同下的可解释失败或证据不足，不能改变合同版本。

### 4.2 冻结发生在模型调用之前

来源版本、策略快照、记忆库、模型非敏感运行时、模型输入、提示词和输出合同都必须在模型请求之前形成稳定哈希。恢复只能使用同一冻结信封；信封不完整或已变化时停止当前 generation，要求人工开启新 generation。

### 4.3 最终应用与模型任务终态保持原子一致

同一 MySQL 事务内完成业务版本写入、case/job 状态更新和 `ai_model_tasks` 成功终态更新。任一围栏失败，整笔事务回滚。

### 4.4 只做必要增量

- 不新建第三套单笔复盘表。
- 不复制通用模型任务状态机。
- 不改写 migration 192、193、194。
- 不在本轮删除 v2、借用 task ID 的兼容逻辑或历史账本；待 v3 真实运行稳定后单独清理。
- 不为了“判断策略一致性”在服务端硬编码指标权重、固定交易方法或特定策略分支。

## 5. 批次 A：合同识别与保护证据正确性

### 5.1 显式冻结单笔复盘合同版本

在新建单笔复盘形成不可变 `evidence_json` 前写入：

```json
{
  "review_contract_version": "manual-trade-review-v3"
}
```

该字段参与 `evidence_hash` 和 job 幂等键。无需新增 case 列，避免只为一个不可变合同标记扩张表结构。

兼容规则：

1. 新建任务一律标记为 `manual-trade-review-v3`。
2. 已有记录显式带 v3 标记时严格走 v3。
3. 部署前已经生成且没有标记、但冻结证据完整包含候选点的记录，可按不可变证据形状识别为 v3 兼容记录。
4. 没有标记且没有候选点的历史记录才按 v2 处理。
5. v3 记录缺少候选点、候选点为空或候选证据不完整时，返回稳定领域错误，例如 `manual_trade_review_counterfactual_points_unavailable`；禁止调用 v2 提示词。

部署前已经落库且“无合同标记、无候选点”的记录无法仅凭现有数据可靠区分真正 v2 与曾经静默降级的新任务。不得按时间或 case ID 猜测并批量改写；这些记录保持 v2 只读/兼容，用户需要完整 v3 时新建复盘。任何数据回标必须另行做生产证据审计并取得数据库修改授权。

需要修改：

- `server/routes/ai/manual-trade-review.js`
- `server/routes/ai/manual-trade-evidence.js`
- `tests/ai/manual-trade-review.test.js`
- `tests/ai/manual-trade-review-v3-worker.test.js`
- `tests/ai/manual-trade-review-counterfactual-evidence.test.js`

### 5.2 候选证据始终保留 v3 结果形状

`buildManualTradeMarketEvidence()` 对新合同始终返回：

- `counterfactual_points`
- `candidate_points`
- `counterfactual_points_status`
- `counterfactual_points_reason`

无法取得主周期 candle 序列时返回空数组和明确 `unavailable` 原因，而不是省略字段。创建任务可以保存证据不足状态，但 worker 必须 fail closed，不得发生模型费用和 v2 降级。

### 5.3 周期白名单

生成以下两个集合：

1. `strategy_declared_timeframes`：来自冻结策略 `market_data_plan`。
2. `evidence_available_timeframes`：来自当前候选点和事后路径实际冻结的 timeframe 节点。

验证规则：

- `strategy_signals[].timeframe` 必须同时属于策略声明和当前候选证据。
- `technical_analysis_chain[].timeframes` 必须存在于冻结证据；`strategy_derived` 还必须属于策略声明。
- 每个周期必须能与对应 `evidence_refs` 的周期一致，不能用 M15 引用支持 H1 结论。
- 不在白名单中的周期使模型输出校验失败，可进入既有一次 JSON 修复；仍失败则当前点失败，不篡改为其他周期。

### 5.4 精确 ATR 与保护证据

删除“递归返回行情树第一个 ATR”的行为，改为：

1. 使用候选点冻结的 `primary_timeframe`。
2. 只在该 timeframe 的标准指标节点中查找策略声明的 ATR 指标身份和周期。
3. 若存在多个 ATR 且无法确定策略使用哪一个，返回 `unknown`，不得任选。
4. 保护评估保存 `atr_timeframe`、`atr_period`、`atr_value` 和 `atr_evidence_ref`；这些字段由服务端派生，模型不能覆盖。
5. `strategy_consistency` 仅在冻结策略存在可机器校验的保护规则时计算；没有声明则保持 `unknown`，不新增硬编码规则。

### 5.5 批次 A 验收

- 新任务没有 candles 时保持 v3，零次模型调用并返回稳定原因。
- 真正的历史 v2 仍按原合同读取和重试。
- 模型声称未声明或无证据的周期时校验失败。
- 多周期行情中只能使用候选主周期的目标 ATR；歧义时结果为 `unknown`。
- 不改变盲测输入隔离和单笔选择上限。

## 6. 批次 B：综合来源、模型运行时与最终围栏

### 6.1 创建时完成来源冻结

把当前在 worker claim 阶段完成的来源冻结提前到综合任务创建事务：

1. 锁定并验证全部来源 case/version。
2. 校验用户、账号、策略、允许状态、version content hash 和策略 snapshot hash。
3. 立即生成并保存 `frozen_source_set_json/hash` 与 `strategy_snapshot_json/hash`。
4. 保存创建时的 `confirmation_status`，以后不重新解释。

创建完成后，claim 和最终保存只复验：

- 固定 version 仍存在；
- version content hash 与冻结哈希一致；
- 来源归属和策略身份一致；
- 冻结来源集合、策略快照和 selection hash 一致。

不得再次以来源 case 的实时 `status` 或 `approved_version_id` 否定已创建综合任务。来源后续编辑、确认、标记问题或稍后处理不改变已固定版本。

### 6.2 追加 migration 195

新增迁移 `195_manual_trade_review_aggregate_runtime_fence`，只向 `manual_trade_review_aggregate_cases` 追加：

- `model_runtime_json MEDIUMTEXT DEFAULT NULL`
- `model_runtime_hash CHAR(64) DEFAULT NULL`

`model_runtime_json` 只保存非敏感字段：模型 profile ID、provider、model、protocol、credential source、endpoint 指纹、温度/思考配置、能力与 token 限制快照哈希。禁止保存 API Key、解密凭据或原始敏感 URL。

迁移要求：

- 单独幂等检查每个列；
- 不修改 192–194；
- 不回填历史成功任务；旧记录为空时按兼容路径读取；
- 不包含 DROP、状态批量改写或数据删除；
- 部署前后应用均能读取空字段。

### 6.3 generation 级模型运行时冻结

流程调整为：

1. claim 取得业务租约和已冻结来源。
2. 解析模型并构造非敏感 runtime snapshot/hash。
3. 在同一业务租约下持久化 runtime hash，随后才能创建通用模型任务。
4. 恢复时重新读取当前 profile 仅用于取凭据，并验证其非敏感 runtime hash 与冻结值一致。
5. 若进程在 runtime 冻结前退出，当前 generation 不自动换模型恢复，标记为可人工重试；新 generation 可以冻结新的模型配置。
6. 若 runtime 已冻结但模型任务未创建，恢复使用原 runtime 创建同一幂等任务。

### 6.4 完整输入围栏

`saveManualTradeReviewAggregateOutput()` 新增并复验：

- `model_runtime_hash`
- `input_hash`
- `prompt_hash`
- `output_contract_hash`
- `model_task_id`
- `frozen_source_set_hash`
- `strategy_snapshot_hash`
- `generation_no`
- 业务 lease token

事务内锁定 aggregate case 和对应 `ai_model_tasks`，确认任务自身保存的哈希与 aggregate case 完全一致后才允许写版本。

### 6.5 批次 B 验收

- 综合任务创建后把来源设为 `deferred`，仍按原固定版本生成。
- 修改来源版本正文或哈希会 fail closed。
- claim 后修改模型 profile，同 generation 不换模型继续；只能人工新 generation。
- 篡改任一输入、提示词、合同、runtime 或来源哈希都会阻止最终应用。
- 迁移比较显示只有新 ID 195，既有迁移正文不变。

## 7. 批次 C：deadline 与原子终态

### 7.1 动态业务 deadline

单笔复盘按冻结候选数量计算 generation deadline：

```text
v2: 30 分钟
v3: 30 分钟基础时间 + 每个候选点 15 分钟
上限: 120 分钟
```

因此默认 3 点为 75 分钟，最大 5 点为 105 分钟。每个模型任务仍使用通用 `manual_analysis` 的 15 分钟 attempt 上限，并受剩余业务时间约束。

要求：

- 创建和人工重试均根据冻结证据计算一次 deadline。
- 恢复不得滚动延长同一 generation 的 deadline。
- 已成功候选点不重复调用，不消耗新的模型费用。
- 剩余时间不足以完成下一阶段时明确失败，不发起必然超时的请求。
- 综合分析仍只有一次模型调用，保留 30 分钟 deadline。

### 7.2 业务结果与模型任务原子提交

为通用模型任务运行时增加受控的事务内成功终态 helper，由调用方传入已有 MySQL transaction runner。单笔和综合分析最终应用都使用该 helper：

1. 模型任务已经是 `result_ready/applying`，且 lease、task ID、result hash 匹配。
2. 同一事务写入业务版本。
3. 同一事务更新 case/job 或 aggregate case。
4. 同一事务把 `ai_model_tasks` 更新为 `succeeded`，写入稳定 `result_ref/result_hash`。
5. 任一步 affected rows 不为 1，全部回滚。
6. 事务提交后只停止 heartbeat 和同步内存 tracker 状态，不再进行第二次数据库终态写入。

禁止复制一份模型任务 SQL 到两个复盘模块；helper 放在现有 model-task runtime/tracker 层，并保持其他调用方原行为不变。

### 7.3 恢复与对账

- 业务成功且模型任务非成功的既有异常数据，只允许只读诊断后用稳定 result hash 对账，不自动重跑模型。
- `status_unknown` 且没有确定结果时继续 fail closed。
- 不能取得供应商结果的 `terminal_succeeded` 任务不得假装生成版本；若业务版本已经存在，则按版本 hash 补齐任务成功状态。
- 人工重试创建新 generation，不覆盖旧版本和旧模型任务。

### 7.4 批次 C 验收

- 3 点和 5 点任务的 deadline 分别为 75 和 105 分钟。
- 模拟在第 1、2、3 个候选及事后阶段前后中断，已成功点不重复请求。
- 注入模型任务最终更新失败时，业务版本、case/job 状态全部回滚。
- 注入业务版本写入失败时，模型任务不能成为 `succeeded`。
- 不再出现 worker 返回 failed、页面却已有成功草稿的分裂结果。

## 8. 批次 D：综合分析前端与恢复体验

### 8.1 稳定创建幂等

新增状态：

- `manualTradeReviewAggregateClientRequestId`
- `manualTradeReviewAggregateSubmitting`

行为：

1. 当前选集第一次提交时生成 request ID。
2. 请求超时或网络错误时保留 ID，用户重试安全重放。
3. 服务端成功返回后才清理 ID。
4. 用户改变账号、策略或来源集合时清理旧 ID。
5. submitting 期间禁用按钮并阻止重复事件。
6. 同一 ID 与不同 selection hash 冲突时展示明确中文错误，不自动换 ID 重试。

### 8.2 综合进度与轮询

为综合任务使用独立的最小进度模型：

```text
准备固定来源 -> 正在综合分析 -> 校验并保存 -> 完成
```

不得继续把 `model_aggregation` 显示为“准备证据”。轮询复用单笔任务的可见性暂停、瞬时错误退避和鉴权终止规则；网络错误不能永久停止轮询。

### 8.3 账号与策略上下文

- 综合入口不再强制依赖“先打开一条单笔详情”。
- 优先使用手动复盘页面当前账号和策略筛选；缺失时显示明确选择器。
- 综合历史查询同时提交 `trading_account_id + strategy_id`。
- 后端列表接口增加可选 `strategy_id` 过滤并继续校验 owner；详情读取仍按 ID 和 owner fail closed。
- 切换账号或策略时退出旧综合详情、停止旧轮询并清空选集，防止跨上下文陈旧结果。

### 8.4 中文状态与可访问性

- 所有新增领域错误映射自然中文，不显示内部英文错误码。
- 按钮使用 `disabled`、`aria-busy` 和明确加载文案。
- 进度不能只依赖颜色；键盘焦点、错误提示和 reduced-motion 保持现有设计基线。

### 8.5 批次 D 验收

- 双击创建只产生一次 POST 和一个 aggregate case。
- 响应超时后重试返回同一个 case。
- 同账号不同策略的综合历史不会混入当前列表。
- `model_aggregation` 显示“正在综合分析”。
- 页面隐藏后停止轮询，恢复可见后继续；瞬时 5xx 自动退避重试。
- 不先打开单笔详情也能通过显式账号和策略进入综合模式。

## 9. 测试与验证矩阵

### 9.1 静态和单元测试

- 对全部修改 JavaScript 执行 `node --check`。
- 扩充：
  - `manual-trade-review-counterfactual-evidence.test.js`
  - `manual-trade-review-v3-worker.test.js`
  - `manual-trade-review-v3-contract.test.js`
  - `manual-trade-review-aggregate.test.js`
  - `manual-trade-review-frontend.test.js`
  - `manual-trade-review-stage-runs.test.js`
  - `model-task-runtime.test.js`
- 增加负向测试：v3 证据缺失不降级、错误周期、错误 ATR、来源状态变化、哈希篡改、模型配置漂移、超时重放和事务终态失败。

### 9.2 全量回归

运行 `npm test`。当前基线为 3226/3228，通过；两项 Bridge 发布测试因子 PowerShell 找不到 `Get-FileHash` 失败。实施后必须确认：

- 手动复盘新增测试全部通过；
- 全量测试没有新增失败；
- Bridge 两项既有环境失败单独记录，不能混入修复提交。

### 9.3 真实 MySQL

在非生产数据库验证：

- migration 195 首次运行和重复运行；
- 既有 aggregate 行允许新列为空；
- 唯一键、CAS、并发创建和事务回滚；
- 业务版本与 `ai_model_tasks` 终态原子一致；
- 无 DROP、无历史状态批量改写。

### 9.4 浏览器

本地服务使用可见 PowerShell 启动并验证 `/health`，随后用 Codex 内置浏览器以管理员账号检查：

- 新建 v3、证据不足、生成中、失败、重试和历史返回；
- 综合多选、双击、超时重放、策略切换、轮询和中文状态；
- 控制台无异常，网络请求没有重复创建；
- 桌面和窄屏布局、键盘焦点与错误状态。

### 9.5 真实模型与公网

仅在用户另行授权后：

1. 创建一条新的 v3 单笔复盘，观察 3 个候选点和事后阶段真实终态。
2. 创建一个 2–3 条来源的综合任务，观察唯一模型任务、固定来源和最终版本。
3. 不发送交易、不修改策略、不写记忆。
4. 部署后核对公网提交、migration 195、worker 日志、API、静态缓存键和页面实际行为。

## 10. 实施顺序与提交边界

1. **提交 A：合同与证据正确性**
   - 显式 v3 合同、候选 fail closed、周期和 ATR 修复。
2. **提交 B：综合冻结信封**
   - migration 195、创建时来源冻结、runtime/hash 最终围栏。
3. **提交 C：deadline 与原子终态**
   - 动态 deadline、事务内模型任务成功 helper、恢复测试。
4. **提交 D：综合前端**
   - 稳定幂等、筛选、进度、轮询与可访问性。
5. **验收提交（仅必要测试/文档调整）**
   - 只收纳实施产生的测试或文档校正，不混入其他模块清理。

每个提交必须单一职责、审查实际 diff、运行对应定向测试后推送当前 `dev_codex`。合并 `main`、公网部署和真实模型验证分别需要用户明确授权。

## 11. 回滚与发布

### 11.1 代码回滚

- A、C、D 可按提交逆序回滚。
- B 的代码可回滚，但 migration 195 不删除列；旧代码必须容忍附加列。
- 回滚不得删除 case、version、stage、point、aggregate 或 `ai_model_tasks` 历史。

### 11.2 功能止损

- v3 候选异常：停止领取新的 v3 job，保留历史只读，不降级为 v2。
- 综合异常：关闭综合创建入口，不影响单笔复盘。
- 模型任务状态未知：停止自动重发，保留对账证据。
- 迁移异常：停止启动并保留日志，不执行手工 SQL 修补，先形成独立数据库修复授权。

### 11.3 发布门槛

以下条件全部满足才可建议合并和部署：

- F1–F8 均有对应回归测试；
- migration 195 在真实非生产 MySQL 验证通过；
- 没有新增全量测试失败；
- 本地浏览器完成单笔和综合主路径；
- 工作区干净，提交范围可追溯；
- 用户明确授权合并 `main` 和公网部署。

## 12. 第一轮方案复审：需求覆盖、复用与设计克制

### 12.1 检查结论

1. 三项业务目标均覆盖：技术逻辑重建、历史时间邻域策略回放与保护判断、多条固定复盘综合优化。
2. F1–F8 均有明确修复批次和验收门槛，没有只修页面、不修状态机的遗漏。
3. 保留现有 case/job/stage/point/aggregate 和通用模型任务，没有新建重复工作流。
4. 最初考虑为单笔 case 增加 `review_contract_version` 数据库列；复审后认为不可变 evidence 已参与哈希，直接把合同标记写入 evidence 更小且足够，因此取消该列。
5. 最初考虑新建 aggregate run 表保存每个 generation；复审后确认当前 aggregate case 加通用模型任务已经能表达当前 generation，新增两个 runtime fence 列即可，避免重复账本。
6. “借用首个候选点 task ID 作为兼容 checkpoint”虽有技术债，但不是本轮已复现故障；立即重构会扩大 migration 192 兼容风险，故移出本轮。
7. 不把 `strategy_consistency` 强行计算为 pass/fail；只有策略声明可机器验证规则时才派生，否则保留 unknown，避免服务端越权成为交易策略。

### 12.2 第一轮调整

- 单笔合同标识由新增列调整为冻结 evidence 字段。
- 综合 generation 存储由新表调整为两个非敏感 runtime fence 列。
- 来源冻结提前到创建事务，减少 claim 时对实时 case 状态的依赖。
- 技术债清理从修复批次移到稳定后独立任务。

### 12.3 第一轮剩余风险

- evidence JSON 增加合同字段会改变新任务 evidence hash，这是预期行为，必须补幂等兼容测试。
- aggregate case 只保存当前 generation 的 runtime fence，旧 generation 详细身份仍主要依赖 `ai_model_tasks` 和版本记录；当前修复范围可接受。
- 严格周期校验可能暴露现有模型输出质量问题，需要保留一次结构化修复机会，但不能静默改写周期。

## 13. 第二轮方案复审：兼容、迁移、并发、恢复与发布

### 13.1 兼容与数据

1. v2 历史通过“无显式标记且无候选点”继续识别，不要求批量回填。
2. 已有无标记 v3 通过完整候选证据兼容识别，避免部署后误降级。
3. 无标记且无候选点的既有记录不可可靠反推合同，保持 v2 兼容并明确要求新建 v3，不做猜测式数据回填。
4. migration 195 仅加可空列；旧应用读取不受影响，代码回滚无需删列。
5. 来源确认状态在创建时冻结，后续 case 状态变化不会改变历史语义。

### 13.2 并发与幂等

1. 单笔 request ID 和现有签名选择上下文保持不变。
2. 综合前端稳定 request ID 与服务端 `(user_id, client_request_id)` 唯一键共同防双写。
3. 最终事务同时锁 aggregate/case、业务 job、模型任务并复验全部哈希，防止旧 worker 应用新 generation。
4. 动态 deadline 只在创建或人工新 generation 时计算，同 generation 恢复不延期。

### 13.3 异常恢复

1. runtime 未冻结就中断的 generation 不允许换模型自动恢复，转人工新 generation。
2. runtime 已冻结且任务未创建，可凭同一幂等键安全创建。
3. 已保存候选点不重复请求；未知供应商状态继续等待对账。
4. 业务版本与模型任务成功在同一事务提交，消除末步分裂窗口。

### 13.4 安全与副作用

1. runtime snapshot 不保存密钥或敏感 endpoint，只保存指纹和非敏感配置。
2. 所有来源、详情和重试继续按当前用户与管理员内容权限校验。
3. 不增加策略、记忆、回测、订单或 Bridge 写路径。
4. ATR 和周期验证基于通用冻结声明与证据，不新增特定策略规则。

### 13.5 测试、回滚和连带风险

1. 新事务 helper 属于跨模块风险点，必须保持默认调用方行为不变并补 model-task runtime 回归。
2. 更长 deadline 会延长异常任务占用时间，但租约、单点任务上限和全局 120 分钟上限控制资源；监控需区分正常长任务和停滞。
3. 创建时冻结最多 20 条来源会增加事务正文和锁持有时间；只读取固定小集合并按稳定顺序锁定，真实 MySQL 需验证并发。
4. 综合历史增加策略过滤是向后兼容的可选参数，不改变详情 owner 校验。

### 13.6 第二轮最终结论

第二轮未发现仍需新增独立架构的实质问题。调整后的方案覆盖 F1–F8，保留两阶段隔离、固定来源、无自动策略/记忆/交易副作用，并把新迁移限制为两个可空非敏感围栏列。方案可进入实施，但真实 MySQL、浏览器和真实模型终态仍是发布前必要验证，不能由 mock 测试替代。
