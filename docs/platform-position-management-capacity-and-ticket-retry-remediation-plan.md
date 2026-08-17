# 平台持仓管理容量降级与票号自动重试修复方案

## 1. 文档状态

- 日期：2026-08-17
- 仓库：`D:\dev_codex\wall-street-skill-local`
- 规划基线：`dev_codex` / `2e9e0b36e7ebfe3a16ec6a4a001dc747b1fb0c22`
- 状态：方案完成，尚未实施
- 来源：对平台策略订阅持仓管理与实时票号关联修复的第二次完整审查
- 本方案只授权后续代码修复范围，不包含生产部署、数据库写入、历史任务重放、订阅配置变更或真实订单操作。

## 2. 已确认问题

### 2.1 容量超限会整批关闭本轮持仓管理

`loadActivePositionManagementContext()` 当前把 pending 和 position 区段相加，超过 20 个区段或序列化上下文超过 32KB 时直接抛错。自动调度和手动分析调用方捕获错误后继续新信号推理，但不会把任何持仓管理上下文传给模型。

本次订阅目标修复保留了观摩源已经没有对应订单的订阅管理组，符合业务要求，但也扩大了进入容量检查的活动组集合。因此，一个超限组会让同一策略、品种下所有原本可处理的组在该轮一起失去挂单取消和持仓判断。

### 2.2 票号刷新瞬时失败后没有自主恢复

前端收到新持仓或 `signal_execution_updated` 后会刷新 `signal_tickets`。请求失败时会正确保留旧映射，但当前没有有界重试；后续价格和浮盈推送又明确使用 `refreshSignalTickets:false`，持仓结构不变时也不会重新调度。

因此，一次瞬时网络、WebSocket 或数据库读取失败仍可能让新持仓保持普通票号，直到用户切换页面、点击刷新或 F5。

## 3. 修复目标

1. 管理组或上下文超过预算时，不再整批丢弃本轮全部持仓管理。
2. 所有活动管理组在连续自然闭合周期中获得公平、可追踪的处理机会。
3. `position_exit` 仍必须由相邻闭合周期的两次独立有效判断确认，轮转或漏跑不得把相隔很久的两次判断拼成连续确认。
4. pending 和 position 属于同一 `management_group_id` 时必须作为一个原子组选择，不能跨批次拆开后产生相互不一致的模型判断。
5. 继续遵守 20 区段和 32KB 模型输入预算，不通过简单调大上限掩盖问题。
6. 票号映射请求短暂失败时能够自动有限重试，不再依赖 F5。
7. 重试不得跨账户、跨 ticket generation 写回，也不得把高频价格推送变成高频数据库请求。

## 4. 非目标与必须保留的边界

- 不新增第二套持仓管理模型任务，不为每个订阅账户单独调用模型。
- 不改变“一次匿名策略判断、逐账户私有执行”的架构。
- 不提高或取消 `POSITION_MANAGEMENT_MAX_GROUPS`、`POSITION_MANAGEMENT_MAX_CONTEXT_CHARS`。
- 不修改 position-management v1.6 模型合同；本次只改变服务端如何安全选择输入组。
- 不改变撤单一次确认、平仓两次确认、Magic、ownership、broker/login、ticket、方向、手数、Bridge 代际和 worker preflight。
- 不把 `admin_strategy_dispatch` 纳入 AI 持仓管理。
- 不新增数据库表、字段或迁移，不保存轮转游标。
- 不自动补建、重试或重放历史 cancel/exit 任务。
- 不把票号链接显示作为 broker 成交或订单归属证据。

## 5. 后端容量降级设计

### 5.1 先建立唯一管理组，再计算区段权重

在 `loadActivePositionManagementContext()` 中先完成当前 v1.6 的活动 outcome 读取、去重、匿名事实构建和私有 `_targets` 构建，再为每个唯一 `management_group_id` 建立选择描述：

- `section_weight`：只有 pending 或 position 时为 1，两者并存时为 2；
- `serialized_chars`：该组进入模型上下文后的实际 JSON 字符数；
- `stable_key`：使用 `management_group_id` 稳定排序；
- `targets`：仍为 non-enumerable 私有执行目标，不参与模型字符预算。

同一管理组的 pending/position 两个区段必须整体入选或整体延期，禁止为了凑预算拆开。

### 5.2 未超限时完全保持现有行为

如果全部唯一组的区段总数不超过 20 且完整 context 不超过 32KB：

- 返回全部组；
- `_targets` 包含全部对应活动 outcomes；
- 不启用轮转；
- diagnostics 标记 `selection_mode: all`。

这样正常规模用户不会因为本方案增加管理延迟或改变模型输入。

### 5.3 超限时使用两槽重叠轮转

超限时不额外调用模型，也不写数据库游标。服务端将稳定排序后的原子管理组打包成多个半预算批次：

- 每个批次最多使用 10 个区段；
- 字符预算先扣除空 context envelope 和固定安全余量，再把剩余预算平分；不得直接使用两个 16KB 后再追加 envelope；
- 不能放入半预算批次的单个异常大组单独标记为 `oversized_group`，本轮失败关闭该组，但不能影响其他组。

闭合 K 线序号使用现有 `timeframeIntervalMs()` 计算：

```text
bar_ordinal = floor(closed_bar_time_utc_ms / timeframe_interval_ms)
slot = bar_ordinal mod batch_count
selected = batch[slot] + batch[(slot - 1 + batch_count) mod batch_count]
```

这样每个批次会在相邻两个自然闭合周期中连续出现一次：第一次作为当前批次，下一周期作为上一批次。相邻两个半预算批次的并集仍不超过 20 区段和 32KB，既提供两次确认机会，又避免新增模型调用。

当只有一个批次时直接视为全量选择，不重复序列化同一批次。

### 5.4 选择后的私有目标边界

模型 context 和 `context._targets` 都只包含本轮入选的管理组。所有未入选组保留在本轮 non-enumerable diagnostics 中的计数，不携带账户或 ticket 明细，也不进入持久化函数。

这样能够保证：

- 模型不会为未看到的组输出动作；
- 延期组不会被错误写成 `hold/keep`，也不会意外重置确认状态；
- 当前模型输出不可能映射到另一个批次的私有账户目标。

### 5.5 连续平仓确认增加闭合周期相邻校验

轮转意味着同一 outcome 的两次实际评估之间可能隔了多个周期。不能用固定毫秒差判断相邻 K 线，因为周末、休市和数据缺口会使相邻可交易 K 线的 UTC 时间差大于 timeframe interval。

`loadActivePositionManagementContext()` 应从当前策略行情窗口中同时解析“当前闭合 K 线”和“上一根实际闭合 K 线”，把上一根时间保存在 non-enumerable 内部连续性证据中，不加入模型合同。`resolveAutomaticExitConfirmation()` 除现有 inference、task、snapshot 去重外，还必须验证：

```text
previous_evaluation.closed_bar_time_utc_ms
  === current_context.previous_closed_bar_time_utc_ms
```

两侧统一为 UTC 毫秒整数，不做北京时间、MT5 墙钟或固定时差换算。当前行情窗口无法提供上一根闭合 K 线时失败关闭为第 1 次确认。若不相邻：

- 当前有效 exit 只能作为第 1 次确认；
- 旧 `CANDIDATE` 必须结束为安全终态或被当前第 1 次候选明确替代；
- 不得进入 `EVIDENCE_CONFIRMED`；
- 事件记录原因 `automatic_confirmation_bar_gap`。

该校验也修复与容量无关的调度漏跑、服务重启或模型失败后把陈旧判断拼接为连续确认的风险。

### 5.6 diagnostics 与调用方行为

`context._diagnostics` 增加但不序列化以下字段：

- `total_group_count`
- `total_section_count`
- `selected_group_count`
- `selected_section_count`
- `deferred_group_count`
- `oversized_group_count`
- `selection_mode: all | rotating`
- `rotation_slot`
- `batch_count`
- `context_chars`
- `previous_closed_bar_time_utc_ms` 只存在于 non-enumerable 内部证据或 diagnostics，不进入模型 JSON

正常容量轮转不再抛 `position_management_group_limit_exceeded`。调用方继续新信号推理，并记录结构化、无账户信息的容量日志。只有 context 基础数据损坏、闭合时间不可用或入选结果仍违反硬预算时才整体失败关闭。

## 6. 前端票号有界自动重试设计

### 6.1 让调度器能够识别真实失败

当前 `loadHistoryTicketMap()` 在 catch 中直接返回旧 map，调用方无法区分“成功返回相同数据”和“请求失败”。增加内部选项，例如 `propagateFailure`：

- 普通历史/页面读取保持现有容错行为，失败时返回旧 map；
- `scheduleSignalTicketRefresh()` 强制刷新时启用失败传播；
- 传播错误前仍保留现有 `state.signalTickets`，不得清空页面关联。

该选项只影响前端内部控制流，不修改 `signal_tickets` WebSocket API。

### 6.2 有界退避与停止条件

增加独立重试状态：

- `_signalTicketRefreshRetryTimer`
- `_signalTicketRefreshRetryAttempt`
- 固定退避 `1000ms、2000ms、5000ms`
- 最多 3 次自动重试

一次刷新失败后，只有同时满足以下条件才安排下一次：

1. account context generation 未变化；
2. ticket-map context generation 未变化；
3. 当前仍有至少一个持仓 ticket 未映射到信号；
4. 没有其他 signal-ticket 请求正在进行；
5. 尚未超过最大重试次数。

成功返回后，如果所有当前持仓 ticket 已映射，立即清零重试状态。成功但归因暂未落库、仍存在未映射 ticket 时，允许继续使用剩余退避次数，因为执行事件可能早于最终映射可读时点。

### 6.3 新事件、人工刷新和账户切换

- 新 `signal_execution_updated` 或结构性 positions 事件到达时，取消等待中的退避并合并为一次立即刷新，重试计数从 0 开始。
- 用户点击刷新或重新进入交易页时，现有 `loadPositions()` 正常刷新，并重置该轮自动重试计数。
- `clearAccountContextCaches()` 必须清除 debounce timer、retry timer、dirty 状态和 attempt，并完成旧 Promise。
- 旧账户或旧 generation 的成功、失败、retry callback 都不得修改新账户状态或触发新账户重绘。
- 仅价格和浮盈变化继续不触发 ticket-map 请求。

### 6.4 请求风暴控制

保留现有串行 dirty-drain：任意时刻最多一个 `signal_tickets` 请求在飞。自动退避只负责在整轮请求已经结束后安排下一轮，不得与 trailing refresh 并行。

三个自动重试全部失败后：

- 保留最后已知映射；
- 新 ticket 继续显示普通文本；
- 不循环重试、不弹重复 toast；
- 下一次真实执行事件、账户恢复或人工刷新仍可重新开始一轮。

## 7. 文件范围

预计只修改：

- `server/routes/ai/position-management.js`
- `server/routes/ai/utils.js` 仅复用现有 `timeframeIntervalMs()`，原则上不修改
- `public/ai/app.js`
- `public/ai/index.html`
- `tests/ai/position-management.test.js`
- `tests/ai/frontend-demand-loading.test.js`
- `tests/ai/frontend-governance.test.js`
- 必要时补充 `tests/ai/position-management-worker.test.js`

不修改 `server/migrations.js`、Bridge 协议、`signal_tickets` 查询 SQL、订单发送 worker 或管理模式配置。

## 8. 测试方案

### 8.1 后端容量与轮转

1. 20 个区段以内完全返回全部组，输出与当前 v1.6 等价。
2. 21 个单区段组不抛错，并只返回预算内的两个相邻半批次。
3. 11 个 pending+position 混合组按 22 个区段计算，任何混合组都不被拆开。
4. 同一闭合 bar 重试得到完全相同的选择结果。
5. 连续闭合 bar 按当前批次加上一批次轮转，每个批次连续出现两次。
6. 遍历完整轮转周期后，每个活动管理组至少被选中两次且两次相邻。
7. 活动集合增删后仍不越过硬预算，不重复序列化组；无法连续时只影响确认速度，不得误确认。
8. 单组超过计算后的半批次字符预算时只延期/隔离该组，其他组仍可处理。
9. 选中 `_targets` 不包含延期组，序列化 JSON 不包含 diagnostics 私有数据或账户字段。
10. context 最终字符数始终不超过 32KB。

### 8.2 平仓确认时间语义

1. 相邻 M15 闭合 bar 的两个独立 exit 可确认。
2. 相隔两根或更多 K 线的 exit 只能重新计为 1。
3. 同一 bar、同一 inference、同一 snapshot 继续不能重复确认。
4. H1、H4、D1 以及跨周末场景使用行情窗口中的上一根实际闭合 K 线判断连续性。
5. 当前窗口缺少上一根闭合 K 线时只能重新计为 1。
6. 延期周期不得写伪造的 hold evaluation，也不得把旧 candidate 自动升级。
7. bar gap 后旧 candidate 的终止和新 candidate 建立保持 outcome 级幂等。

### 8.3 前端自动重试

使用 fake timers 和可控 Promise 覆盖：

1. 首次失败后 1 秒重试，成功后无需 F5 建立链接。
2. 接口成功但映射尚未出现时按 1/2/5 秒继续，出现后停止。
3. 三次重试全部失败后停止，不形成无限请求。
4. 高频 price/profit push 在等待退避期间不增加请求。
5. 新 execution event 取消退避并立即合并刷新。
6. 任意时刻最大并发 `signal_tickets` 请求数为 1。
7. 账户切换取消旧 timer，旧成功或失败响应均不能覆盖新账户。
8. 账户切换发生在 debounce、in-flight、retry-wait 三个阶段时，所有 Promise 都能结束。
9. 已有关联 map 在失败期间保持，不出现链接闪烁或被清空。
10. 人工刷新能够开启新一轮尝试。

### 8.4 回归命令

```powershell
node --check server/routes/ai/position-management.js
node --check public/ai/app.js
npx vitest run tests/ai/position-management.test.js tests/ai/position-management-worker.test.js tests/ai/llm.test.js
npx vitest run tests/ai/frontend-demand-loading.test.js tests/ai/frontend-governance.test.js tests/ai/frontend-precise-fixes.test.js
git diff --check
npm test
```

前端实施后必须在 Codex 内置浏览器验证：新静态 build key 已加载、页面无运行时错误、账户切换不串 map。真实 MT5 多账户事件只能在有自然 demo 样本或用户另行授权时验证，不能为了测试主动创建订单。

## 9. 实施阶段与验收门

### 阶段 1：先补失败回归

- 建立 21 区段整批丢失、bar gap 误确认、票号一次失败后不再恢复的测试。
- 验收：旧代码稳定暴露三条问题路径。

### 阶段 2：实现原子组预算与重叠轮转

- 建立原子组描述、稳定排序、半预算打包和两槽选择。
- 仅将本轮选择组写入可序列化 context 与 `_targets`。
- 验收：容量超限不再整批关闭，所有选择均满足硬预算。

### 阶段 3：收紧连续确认时间语义

- 增加 timeframe 相邻闭合 bar 校验和 gap 事件。
- 验收：任何跨周期缺口都不能完成第二次确认。

### 阶段 4：实现票号有界退避

- 增加失败传播、retry timer、attempt、停止条件和账户切换清理。
- 更新静态 build key。
- 验收：一次瞬时失败后自动恢复，并且并发始终为 1。

### 阶段 5：完整回归与提交

- 执行定向测试、全量测试、语法检查、浏览器检查和最终 diff 审查。
- 形成单一职责 Conventional Commit 并按仓库规则推送当前 `dev_codex`。
- 不合并 `main`，不部署公网，除非用户另行明确授权。

## 10. 回滚与生产验收

本方案无 schema 迁移。代码回滚可以恢复旧选择和刷新行为，但已经创建的任务、evaluation 和命令属于审计数据，不得通过删除数据库回滚。

出现以下任一情况停止发布或回滚：

- 轮转组超过 20 区段或 32KB；
- 同一管理组 pending/position 被拆到不同轮次；
- 跨 bar gap 的两次 exit 被确认；
- 延期组产生模型未见过的任务；
- 一个账户的 ticket map 写入另一个账户；
- 自动重试并发超过 1、超过次数上限或形成持续请求；
- 模型上下文出现订阅账户私有字段；
- 完整测试或健康检查出现相关回归。

生产验收只读观察自然发生的场景：容量 diagnostics、选中/延期数量、连续 bar 确认事件、票号首次失败后的自动恢复。不得为验收创建真实仓位或重放旧任务。

## 11. 第一轮方案复审：需求覆盖与设计克制

### 检查结论

- 两项审计发现均有明确修复和验收门。
- 简单提高 20/32KB 上限只能推迟故障，并扩大模型输入和供应商限制风险，已排除。
- 为每个批次额外调用模型会改变成本、配额、调度和“一次策略判断”语义，属于过度设计，已排除。
- 数据库存储轮转游标会引入迁移、锁和恢复问题，而闭合 bar 本身可以提供稳定时序，已排除。
- 只做普通 round-robin 会让每个组每轮只出现一次，破坏两次连续平仓确认，不能采用。

### 第一轮调整

最终方案采用“半预算批次 + 当前/上一槽重叠”，使每个批次在相邻两个闭合周期出现，同时不超过原硬预算；正常未超限路径完全不变。前端只增加三次有界退避，不引入永久轮询或用户可见的新状态机。

第一轮结论：覆盖需求，复用现有 v1.6、闭合 bar、generation 和串行 flight，改动范围可控，没有为低概率容量场景引入数据库或额外模型架构。

## 12. 第二轮方案复审：兼容性、安全与连带 Bug

### 检查结论

- **兼容性**：v1.6 模型字段和 WebSocket API 不变；静态 build key 只做缓存刷新。
- **数据与迁移**：不修改 schema、历史 outcome、任务或确认次数；无需生产回填。
- **并发与幂等**：同一 bar 的选择确定；`_targets` 只含入选组；worker 的 outcome/task/operation 幂等不变。
- **异常恢复**：活动集合变化或某次调度缺失可能打断两次相邻选择，因此必须增加 bar adjacency 校验，不能仅依赖重叠轮转。
- **时间语义**：轮转只使用 UTC 闭合 bar 生成无状态槽位；连续确认比较行情窗口中的上一根实际闭合 bar，不使用固定毫秒差、北京时间、浏览器时间或 MT5 未校准墙钟。
- **安全**：延期不等于 hold，不写伪造 evaluation；超大单组失败关闭自身，不能拖垮其他组。
- **前端竞态**：retry callback 必须同时校验 account generation 与 ticket generation；账户切换要覆盖 debounce、in-flight 和 backoff 三种阶段。
- **测试与回滚**：加入容量全周期、公平性、bar gap、fake timer、最大并发和账户切换测试；无迁移，可回滚代码但不删除审计数据。

### 第二轮调整

复审发现仅靠两槽轮转仍不能防止服务重启或模型失败后把跨周期判断拼接确认，因此把“上一根实际闭合 bar”升级为服务端硬门禁，并要求旧 candidate 在 gap 时安全结束或重建。最初考虑的固定 timeframe 毫秒差会误伤跨周末的连续可交易 K 线，已改为读取当前行情窗口的真实上一根闭合时间。复审还发现两个半批次不能各自直接占满 16KB，否则 envelope 会使最终 context 超过 32KB，因此改为先扣除 envelope 和安全余量后再平分。前端成功响应但映射尚未落库也需要继续有限重试，停止条件改为“请求成功且当前票号全部已映射”，而不是只看 HTTP/WS 成功。

第二轮结论：调整后没有发现阻止实施的兼容性、迁移、并发、幂等或安全问题，可以进入实施阶段。

## 13. 剩余风险

- 超限时单个管理组的最坏处理等待时间约为批次数量对应的闭合周期；这是保持单次模型预算和不增加模型调用的明确取舍，必须通过 diagnostics 可见。
- 活动组集合在连续两个周期之间变化可能改变批次边界；bar adjacency 门禁保证不会误确认，但可能延迟确认。
- 单个管理组自身超过半预算时将被安全隔离，仍需后续调查异常事实数量，不能自动截断后假装证据完整。
- 三次票号重试后仍失败时仍需等待新事件或人工刷新，避免永久轮询；页面关联是展示能力，不影响订单执行真相。
- 本地没有连接真实 MT5 多账户环境，实施后的真实事件验收仍需自然 demo 样本或单独授权的受控测试。
