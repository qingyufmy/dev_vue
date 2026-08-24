# 日复盘语义修复与 524 超时修复方案

## 1. 状态与范围

- 方案类型：实施与复审记录；本轮已按本方案完成业务代码和测试修改，并获授权提交、推送 `dev_codex`；不包含数据库写入、复盘重试、服务重启或部署。
- 仓库基线：`dev_codex`，提交 `cb931f5582ec492716283d17265ec29c76ae5f56`。
- 生产证据：2026-08-24 对日复盘 case `304`（周期 `2026-08-21`、策略版本 `21`）进行授权重试，3 次业务尝试共产生 5 次真实模型请求；3 次 HTTP 200、2 次 HTTP 524，最终未生成版本。
- 修改范围：日复盘 v3 语义校验、一次性定向修复、模型任务事件、失败文案及对应测试。
- 保护边界：不放宽证据校验，不伪造 `insufficient_evidence` 的替代结论，不改变冻结证据、交易事实、策略、记忆、账户、模型配置、重试次数和版本幂等规则。

## 2. 已确认的问题

### 2.1 语义校验与修复合同不匹配

当服务器确认某笔交易不存在证据限制时，模型仍输出 `insufficient_evidence`，校验器会正确拒绝并抛出：

`daily_v3_insufficient_state_without_server_limitation`

但当前校验器在遍历 `trade_assessments` 时遇到第一笔问题就立即抛错，修复上下文只携带一个 `outcome_id + fields`。如果同一输出中还有其他交易或顶层字段存在同类问题，一次修复无法完整覆盖；修复后全量复验仍可能再次得到同一个错误。

### 2.2 定向修复仍要求重写整份 JSON

当前修复请求虽然只提供相关冻结证据，却仍把原始完整输出放入请求，并要求模型返回完整复盘 JSON。生产重试中一次成功修复返回了约 7,509 个输出 token，最后一次修复又在约 126 秒后返回 HTTP 524。

这会同时带来三类风险：

1. 单字段语义修复承担整份复盘的生成成本和超时风险；
2. 模型可能改动未报告字段，随后被差异保护器拒绝；
3. 供应商 524 会覆盖此前更有诊断价值的语义校验错误。

### 2.3 前端没有准确识别修复阶段 5xx

前端只匹配 `LLM HTTP 5xx`，不能准确匹配 `LLM repair HTTP 524`，因此用户容易看到笼统失败信息，无法区分“主生成失败”和“主生成成功但定向修复超时”。

> 生产持久记录没有保存完整模型正文，因此无法证明那次 HTTP 200 修复究竟是未修改首个目标，还是修好首个目标后命中了下一个目标。下述方案同时消除这两条路径。

## 3. 最小修复设计

### 3.1 一次汇总全部非法语义目标

调整 `server/routes/ai/period-review.js`：

1. 在规范化正文前，只扫描服务器禁止的 `insufficient_evidence` 枚举；
2. 汇总顶层字段及所有受影响交易，形成 presentation-safe 的目标列表；
3. 一次抛出一个稳定错误，禁止逐笔遇错即停；
4. 兼容读取现有单目标 `outcome_id + fields`，新错误统一使用 `targets`。

建议内部结构：

```json
{
  "targets": [
    { "scope": "root", "field": "decision_quality" },
    { "scope": "trade_assessment", "outcome_id": 123, "field": "decision_quality" },
    { "scope": "trade_assessment", "outcome_id": 123, "field": "risk_execution_status" }
  ]
}
```

该结构只包含稳定 ID 和字段路径，不携带提示词、密钥、完整证据或模型正文。

### 3.2 改为“小补丁”修复，不重写整份复盘

在 `server/routes/ai/llm.js` 的通用修复上下文中增加可选的小补丁能力，旧调用保持原行为：

- 调用方可提供精简原始片段，而不是强制发送完整 `original_output`；
- 调用方可把模型返回的小补丁转换为候选完整对象；
- 转换后仍依次执行差异保护和原有完整业务校验。

日复盘修复只要求返回：

```json
{
  "changes": [
    {
      "scope": "trade_assessment",
      "outcome_id": 123,
      "field": "decision_quality",
      "value": "mixed"
    }
  ]
}
```

每个目标必须且只能出现一次；禁止增加目标、删除目标或修改文本、成交事实、价格、覆盖范围和其他字段。

### 3.3 允许值由服务器逐目标下发

修复请求不再展示包含 `insufficient_evidence` 的宽泛完整枚举，而是为每个目标明确给出当前允许值：

- `decision_quality`: `good|mixed|poor`
- `market_alignment`: `aligned|partly_aligned|conflict`
- `strategy_alignment`: `aligned|partly_aligned|conflict`
- `risk_execution_status`: `compliant|partly_compliant|violation`
- `outcome_attribution.avoidability`: `avoidable|partly_avoidable|normal_strategy_loss`

模型必须依据同一份冻结证据重新判断，服务器不得自动把结果硬改为 `mixed`、`partly_*` 或其他默认值。`normal_strategy_loss` 继续受现有亏损、决策、行情、策略和执行一致性校验约束。

### 3.4 只发送受影响交易的冻结上下文

修复上下文包含：

- 受影响 outcome 的 `pre_trade_frozen`、`holding_path`；
- 共享的后端统计和 `period_market`；
- 每个目标当前值、允许值；
- 服务器冻结的 evidence limitation policy。

不发送未受影响交易的完整正文，也不发送当前策略优化上下文。顶层 `decision_quality` 需要重判时，发送所有受影响交易的精简结论和日级统计，不重新发送整份复盘。

### 3.5 服务端合并后全量失败关闭

服务端在内存中克隆初始对象并应用补丁，然后执行：

1. 补丁结构、目标集合和枚举白名单校验；
2. 未授权字段差异校验；
3. `validateDailyReviewChunkContent()` 全量复验；
4. 只有全量通过后才写 checkpoint 和复盘版本。

任何漏修、多修、非法枚举、伪造证据或剩余语义冲突均失败关闭；不保存半成品，不创建版本。

### 3.6 缩小修复预算并保留一次修复上限

- 主生成预算保持不变；
- 修复请求单独设置小型输出上限，建议初始上限为 4,096 token，并通过生产事件观察后再收紧；
- 修复温度保持 `0`；修复推理强度使用低档，但不全局修改模型配置；
- 每次主生成最多一次修复请求，不在 `requestModel()` 内循环修复；
- 供应商返回 524、结果未知或 deadline 不足时，继续沿用现有业务任务重试与失败关闭规则。

补丁正文应远小于完整复盘，4,096 是包含供应商推理开销的初始上限，不是期望输出长度；若目标模型在低推理强度下仍稳定截断，必须依据真实 usage 再调整，不能直接恢复主生成的大预算。

### 3.7 错误可观测性与前端文案

- 在 `ai_model_task_events` 中记录 presentation-safe 的 `validation_failed` 事件：错误码、目标数量、是否包含顶层目标，不记录证据和正文；
- 修复开始、修复成功、修复 HTTP 错误继续使用真实 provider attempt；
- `period_review_jobs.last_error_code` 保留最终终态错误，事件链保留此前语义错误，避免互相覆盖；
- 更新 `public/ai/app.js`，识别 `LLM repair HTTP 5xx`，显示：主复盘已返回，但定向修复阶段的模型服务超时，本轮未保存不合格结果；
- 管理员仍可看到稳定错误码，普通用户只看中文原因。

本批不新增数据库字段或迁移。

## 4. 文件与实施顺序

### 批次 A：语义目标汇总与补丁合并

- `server/routes/ai/period-review.js`
- `tests/ai/period-review.test.js`

先建立多 outcome、同 outcome 多字段及顶层字段的聚合错误，再实现补丁目标白名单、合并和全量复验。

### 批次 B：通用修复请求的可选小补丁能力

- `server/routes/ai/llm.js`
- `tests/ai/llm.test.js`

只增加 opt-in 回调和独立修复预算；其他模型调用的完整 JSON 修复合同保持兼容。

### 批次 C：事件与前端失败表达

- `server/routes/ai/period-review.js`
- `public/ai/app.js`
- `public/ai/index.html`
- `tests/ai/period-review-v3-frontend.test.js`

补齐语义失败事件和修复阶段 5xx 文案，同步更新 `AI_FRONTEND_BUILD` 与 `app.js` 静态缓存键，不改变列表、版本和人工确认合同。

## 5. 测试矩阵

必须覆盖：

1. 同一 outcome 有多个非法 `insufficient_evidence` 字段时，一次返回全部目标；
2. 多个 outcome 同时非法时，一次返回全部目标；
3. 顶层与逐笔字段同时非法时均被覆盖；
4. 有服务器 limitation 的 outcome 仍可合法使用 `insufficient_evidence`；
5. 补丁缺目标、多目标、重复目标、越权字段或非法枚举时失败；
6. 模型不得借补丁修改复盘文本、交易覆盖和成交事实；
7. 应用补丁后再次命中完整 v3 业务冲突时仍失败；
8. 修复请求不含完整原始复盘，只含目标片段和相关冻结证据；
9. 修复请求使用独立 token 上限，且每次主生成最多一次修复；
10. `LLM repair HTTP 524` 进入正确终态并显示准确中文文案；
11. 成功版本的 `current_version_id`、checkpoint、版本幂等和 UI 草稿状态保持不变；
12. 前端构建标识、请求头和 HTML 静态缓存键保持一致；
13. 现有普通结构/格式修复、月复盘和其他 `requestModel()` 调用不受影响。

验证命令：

```powershell
node --check server/routes/ai/period-review.js
node --check server/routes/ai/llm.js
npx vitest run tests/ai/period-review.test.js tests/ai/llm.test.js tests/ai/period-review-v3-frontend.test.js
npm test
git diff --check
```

## 6. 发布与生产验收

实施、提交、推送和部署分别取得授权。部署后不自动补跑历史复盘，按以下顺序验收：

1. 核对部署 commit、`/health`、数据库和 Redis；
2. 先对 case `304`（2026-08-21）进行一次人工授权重试；
3. 成功后再单独重试 case `302`（2026-08-20），避免并发放大供应商压力；
4. 核对真实 model attempts：主生成与修复各自计数，`retry_wait` worker churn 不计模型请求；
5. 成功标准：生成一个新版本、逐笔覆盖 100%、禁止的 insufficient 状态为 0、case 为 `draft`、job 为 `succeeded`；
6. 失败标准：若 provider 仍返回 524，任务必须明确终止或按现有规则排队，不得长期显示生成中，不得创建半成品或重复版本；
7. 全程保留原始交易、信号、outcome、证据、策略、记忆和既有复盘记录。

## 7. 回滚

- 代码改动不涉及迁移和数据回填，可按批次提交回滚；
- 回滚不得删除部署后已经合法生成的复盘版本；
- 若补丁合并出现越权字段、错误 outcome 或绕过证据门禁，立即停止后续发布并回滚该批代码；
- provider 524 本身不触发数据回滚，只按任务终态处理。

## 8. 第一轮方案复审：正确性与失败关闭

### 发现与调整

1. **直接把非法值确定性改成 `mixed/partly_*` 会让服务器替模型做交易判断。**

   调整：服务器只确定允许值和目标集合，具体语义值仍由模型依据冻结证据选择，随后由完整 v3 校验器复验。

2. **只加强原修复提示词不能解决多 outcome 只报告第一处的问题。**

   调整：先聚合全部非法目标，再发出唯一一次修复请求。

3. **完全放宽 `insufficient_evidence` 虽能生成版本，但会把服务器已确认完整的证据错误标成不足。**

   调整：保留当前失败关闭规则，不改变 evidence limitation 的服务器所有权。

### 第一轮结论

修复不会降低 v3 证据门槛，也不会用默认值换取生成成功；核心是让一次修复拥有完整、精确且受限的目标集合。

## 9. 第二轮方案复审：性能、恢复、兼容与用户状态

### 发现与调整

1. **即使汇总全部目标，继续让模型重写完整 JSON 仍可能再次产生 7,000+ token 输出和 524。**

   调整：采用小补丁输出，服务端合并；修复请求只携带相关原始片段和冻结证据。

2. **直接改变通用修复流程可能影响其他 AI 业务。**

   调整：小补丁能力必须 opt-in；现有调用默认路径、修复次数和校验顺序保持不变。

3. **只保存最终 `LLM repair HTTP 524` 会丢失此前语义失败线索。**

   调整：最终 job 错误保持真实，模型任务事件额外记录安全的语义错误和目标数量。

4. **当前前端 5xx 正则不能覆盖 repair 阶段。**

   调整：增加 repair 5xx 映射并区分主生成与定向修复，不把失败继续显示为“生成中”；同时更新构建标识和 HTML 缓存键，避免线上继续加载旧文案。

5. **自动补跑 20、21 号会扩大模型调用和生产数据写入范围。**

   调整：部署后仍需逐个明确授权重试，先 21 号验收，再决定 20 号。

### 剩余风险

- 供应商仍可能独立返回 524；本方案降低请求体和输出规模，但不能保证外部服务永不超时。
- 模型可能返回非法或语义不一致的补丁；此时必须失败关闭，不能保存版本。
- 顶层结论重判需要跨交易摘要；上下文裁剪过度会降低判断质量，因此必须保留日级统计和所有受影响交易的精简事实。
- 生产没有保留失败正文，无法对旧的 HTTP 200 修复做逐字段复原；最终验收必须依靠新事件和新重试证据。

### 第二轮结论

方案已覆盖语义正确性、请求体规模、供应商超时、状态终结、兼容性和生产重试边界；无需迁移或历史数据修复，可以进入实现阶段。
