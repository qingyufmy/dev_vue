# 平台策略订阅持仓管理与实时票号关联修复方案

## 1. 文档状态

- 日期：2026-08-17
- 仓库：`D:\dev_codex\wall-street-skill-local`
- 规划基线：`dev_codex` / `e3c83e6671f4cad640c3f688690e67128aa26fd5`
- 公网/虚拟机核验基线：`/www/wwwroot/aurum-ai` / `dev_codex` / `5b600b85147eb0f0f370cdf2e26fd2bda6b4d4fe`
- 状态：已实施并完成本地验证
- 本次实施不包含生产部署、数据库写入、历史任务重放或真实订单操作。

## 2. 问题结论

### 2.1 订阅账户撤单和平仓目标被观摩源白名单误删

平台策略推理使用管理员观摩源的 `strategy_reference_portfolio` 作为匿名市场参考，这是正确边界；但 `loadActivePositionManagementContext()` 当前在建立管理组之前执行：

```js
if (referenceOutcomeIds && !referenceOutcomeIds.has(Number(rawRow.outcome_id))) continue
```

该过滤同时删除了模型证据和执行目标，导致同一 `management_group_id` 下不属于观摩源的订阅账户 outcome 无法进入 `_targets`。因此：

- `pending_cancel` 只为管理员观摩源创建任务；
- `position_exit` 只为管理员观摩源记录评估、累计确认并创建任务；
- 观摩源订单已取消、止盈、止损或人工关闭后，仍存续的订阅订单成为无法继续管理的“孤儿订单”。

### 2.2 仅恢复 `_targets` 仍不足以修复

当前验证器要求 `current_facts_status === 'available'`。观摩源已经没有对应订单时，即使订阅 outcome 被保留，模型的 `cancel/exit` 仍会因 `pending_current_facts_unavailable` 或 `position_current_facts_unavailable` 被服务端改成安全默认的 `keep/hold`。

因此必须拆分：

1. 模型可以读取的匿名决策证据；
2. 模型不可见的逐账户执行目标；
3. 真实执行前的账户、订单、Magic、方向和状态校验。

### 2.3 新持仓票号映射缓存没有随执行状态失效

前端收到新持仓或 `signal_execution_updated` 后，没有使 `signalTickets` 缓存失效。`signal_tickets` 映射仍按交易历史 revision 复用，新成交并不保证同步改变该 revision，因而票号要到 F5 清空内存缓存后才关联到信号。

### 2.4 管理员手动策略分发不是本次自动模型管理范围

`admin_strategy_dispatch` 当前没有 `inference_task_id`、`thesis_id` 或 `management_group_id`，其持仓使用管理员关联保护和关联批量平仓流程。本文不为这类订单伪造 AI 论点，也不把它们静默并入自动模型平仓。

如果后续要求“管理员手动策略分发单也由模型持续管理”，应单独设计可审计的冻结论点来源、管理组生命周期、退出确认和用户告知，不能作为本次缺陷修复的附带改动。

## 3. 修复目标

1. 平台模型继续只读取观摩源匿名参考事实，不读取订阅用户账户、票号、余额、权益、盈亏、手数或人工订单。
2. 同一管理组下所有有效订阅 outcome 都进入服务端私有执行目标集合。
3. 即使观摩源已经没有对应订单，仍按原冻结论点和当前闭合行情评估订阅用户的存续管理组。
4. `cancel` 对每个仍有策略挂单的账户分别创建一次撤单任务；`exit` 对每个仍有策略持仓的账户分别记录评估并独立累计两次确认。
5. 每个账户执行前继续读取自己的实时 Bridge 库存并失败关闭，禁止触碰人工单、其他策略订单或状态已变化的订单。
6. 新持仓出现后无需 F5，票号能够在执行归因落库后自动关联到信号。
7. 不自动重放 13073 或任何历史 `cancel/exit` 决策，不对旧 outcome 做推测性修复。

## 4. 非目标与必须保留的行为

- 不向共享模型暴露订阅账户私有持仓快照。
- 不改变平台策略“一次共享推理、逐账户执行”的总架构。
- 不改变 `position_exit` 两次闭合周期确认机制。
- 不降低 pending/position 类型隔离、系统 Magic、ownership generation、账户身份和 worker preflight 校验。
- 不恢复已退役的 `shadow` 或 `auto_reverse` 模式。
- 不把数据库中没有 thesis/management group 的订单自动回填成模型管理订单。
- 不修改数据库 schema；如实施中发现确需迁移，必须停止本方案并重新审查。
- 不把前端票号是否显示为链接当成订单执行或 broker 成交证据。

## 5. 后端设计

### 5.1 将一个集合拆成三个职责明确的数据结构

在 `loadActivePositionManagementContext()` 中使用以下概念，名称可以按现有风格调整，但职责不能重新混合：

| 数据结构 | 是否发送给模型 | 内容 |
| --- | --- | --- |
| `managementGroups` | 是 | 按 `management_group_id` 去重后的冻结论点、方向、入场方式、行情证据引用和匿名参考事实 |
| `referenceFactsByGroup` | 是 | 仅来自平台观摩源、能映射到当前策略 outcome 的匿名 position/pending facts |
| `executionTargetsByGroup` | 否 | 所有仍为 `open/closing` 且有有效 thesis 的管理员及订阅 outcome，保留用户、账户、票号、ownership 等执行字段 |

处理顺序：

1. 从现有 SQL 读取当前策略、品种下所有有 thesis 的活动 outcomes。
2. 对每行先执行 `normalizePositionManagementOutcome()` 和 `isActivePositionManagementOutcome()`。
3. 不再用 `referenceOutcomeIds` 删除该行。
4. 将活动 outcome 按 `management_group_id + outcome_id` 去重写入 `executionTargetsByGroup`。
5. 仅当 outcome 位于 `referenceOutcomeIds` 时，才把对应终端事实加入 `referenceFactsByGroup`。
6. 模型管理组的 pending/position 类型由该组是否存在相应执行目标决定，而不是由观摩源当前是否还有该类型订单决定。
7. `_targets` 指向完整的 `executionTargetsByGroup`，并继续保持 non-enumerable，确保不会被序列化进提示词。

### 5.2 区分“决策证据可用”和“观摩终端参考可用”

将当前含义混杂的 `current_facts_status` 拆成两个状态：

- `decision_context_status`：冻结论点必需字段、决策周期闭合 K 线和不可变 snapshot hash 是否完整；只有该状态可用，模型判断才可进入服务端验证。
- `reference_facts_status`：观摩源是否有当前策略对应的终端参考事实；取值至少区分 `available`、`missing`、`unavailable`。

模型上下文要求：

- `reference_facts_status = available`：可附带现有匿名 `position_facts` / `pending_order_facts`。
- `reference_facts_status = missing`：表示观摩源当前没有该管理组订单，但服务端仍有订阅执行目标；模型使用冻结论点和当前闭合行情判断，不伪造终端事实。
- `reference_facts_status = unavailable`：观摩源查询失败。模型仍可形成市场层候选，但实际执行必须依赖逐账户实时 preflight；如果闭合行情或冻结论点也不完整，则 `decision_context_status = unavailable` 并保持 `hold/keep`。

不得在模型 JSON 中加入订阅目标数量、用户 ID、账户、ticket、volume、profit、balance、equity、真实开仓价或订阅用户 SL/TP。

### 5.3 调整验证器，而不是取消安全门禁

将 `validatePositionManagementResponse()` 的执行候选门禁从“观摩终端事实必须可用”调整为“匿名决策上下文必须可用”：

- `decision_context_status !== available`：继续按现有逻辑失败关闭为 `hold/keep`。
- `decision_context_status === available` 且参考事实缺失：允许 `exit/cancel`，但 evidence refs 必须来自该组允许的闭合 bar、snapshot 或已有观摩终端事实。
- `exit/cancel` 仍必须有结构化 reason code、reason、market alignment 和合法 evidence refs。
- 不允许模型引用不存在的 subscriber terminal ref。

因为模型可见 contract 的状态字段语义发生变化，应将 position-management contract 从 v1.5 升级到 v1.6，并同步提示词、校验器和测试。旧 thesis 仍可作为冻结来源参与新周期推理，不修改历史记录。

### 5.4 逐账户持久化和执行保持独立

`persistPositionManagementEvaluations()` 应在完整 `_targets` 上执行现有类型筛选：

- `position_exit`：仅匹配真实 `position_id` 的目标；每个 outcome 独立写 evaluation、累计确认并创建/更新任务。
- `pending_cancel`：仅匹配仍为 `pending` 的策略挂单目标；每个 outcome 创建独立任务。
- 同一管理组出现管理员 pending、订阅用户 position 等不同生命周期时，各自只进入正确任务类型。

现有 worker 仍负责最后一道实时安全检查：

- 当前 user/trading account/ownership generation 匹配；
- 当前 Bridge 在线且账户身份一致；
- ticket/position 仍存在且属于该 outcome；
- 系统 Magic、策略、方向和订单类型匹配；
- 状态已经取消、成交、平仓或被人工修改时不发送命令；
- 任何歧义都失败关闭并留下任务事件，不做模糊匹配。

### 5.5 历史失败记录处理

- 不根据旧信号 13073 直接补建订阅撤单任务。
- 不重放任何旧 `position_exit` 决策或补齐确认次数。
- 修复部署后，只允许新的自然推理周期基于当时最新行情和实时账户状态创建候选。
- 对仍存续的旧 auto-shared outcome，由新周期正常纳入管理；如果 broker 已变化，worker preflight 应拒绝而不是尝试修复数据。
- 旧 `admin_strategy_dispatch` outcome 保持现有人工关联保护/平仓路径。

## 6. 前端实时票号关联设计

### 6.1 使用独立 ticket-map generation

`signalTickets` 的有效性不能只依赖 `_lastHistoryRevision`。增加仅用于票号归因的 generation/epoch：

- key 至少包含 `kind + accountContextGeneration + ticketMapGeneration + historyRevision`；
- 收到执行归因变化时递增 signal ticket generation；
- 旧 generation 的异步响应不得覆盖当前账户或当前 generation；
- 同 generation 的并发请求继续复用 flight，避免请求风暴；
- 账户切换、退出和 Bridge identity 变化时清空 map、cache、flight 引用并递增 generation。

### 6.2 事件触发规则

新增一个合并调度函数，例如 `scheduleSignalTicketRefresh()`：

1. `signal_execution_updated`：使 signal ticket map 失效并调度强制刷新。
2. `msg.positions` 导致结构变化且存在未映射 ticket：调度刷新；仅价格/浮盈变化不刷新。
3. `bridge_data_changed` 的 positions stream：继续快速刷新持仓，不在每次行情跳动时请求 ticket map；结构变化检测负责补刷新。
4. 刷新完成后，仅在 account generation 和 ticket generation 仍匹配时，用 `state.positions` 重新渲染两张持仓表。
5. 请求失败时保留已有映射，不应把整个 `state.signalTickets` 清空为 `{}`；下一次事件或人工刷新可重试。

这样既解决 F5 才关联的问题，也避免把实时价格推送变成高频数据库查询。

### 6.3 后端映射接口边界

现有 `signal_tickets` 已能从普通信号、订阅 delivery 和 `admin_strategy_trade_targets` 返回映射；F5 后能够恢复证明接口数据最终正确。本次默认不修改该接口 SQL。

只有行为测试证明执行归因已经落库但接口仍缺 ticket 时，才单独修正接口，并保持用户/观摩范围过滤不变。

### 6.4 静态缓存版本

修改 `public/ai/app.js` 后更新 `public/ai/index.html` 的 `build=` 特性键，并同步所有固定校验测试。保留全站统一的 `v=` 主版本，不额外创建第二套缓存入口。

## 7. 测试方案

### 7.1 后端管理上下文

在 `tests/ai/position-management.test.js` 增加或改写：

1. **同组两账户挂单**：观摩源只含管理员 outcome，模型只有一个匿名组，`_targets` 同时包含管理员和订阅用户；序列化 JSON 不包含订阅私有字段。
2. **同组两账户持仓**：一次 `exit` 为两个 outcome 分别写 evaluation，不能只写管理员。
3. **孤儿订阅持仓**：观摩源 positions 为空但订阅 outcome 仍 active，管理组不能消失；合法 bar/snapshot 证据允许形成 `exit` 候选。
4. **孤儿订阅挂单**：观摩源 pending 为空但订阅挂单仍 active，合法候选可形成订阅撤单任务。
5. **两次确认隔离**：不同账户分别累计确认，管理员完成或重置不能改变订阅用户计数。
6. **混合生命周期**：同组 pending 和 position 只进入各自任务类型。
7. **陈旧/人工/其他策略订单**：继续排除，不能因本次放宽而进入 `_targets`。
8. **证据不足**：冻结论点或闭合行情不完整时仍失败关闭，不允许仅凭数据库 open 状态自动退出。
9. **隐私断言**：模型上下文不得出现 `user_id`、`trading_account_id`、`login_account`、ticket、volume、profit、balance、equity 等字段。

现有“观摩组合没有某 outcome 就删除整个持仓组”的断言必须改写，因为它与正式需求冲突。

### 7.2 worker 与持久化

扩展 `tests/ai/position-management-worker.test.js`：

- 每个订阅目标生成稳定且唯一的 operation ID；
- 重复调度不生成第二条命令；
- ticket 已不存在或状态变化时零发送；
- Magic、账户身份、ownership generation、策略或方向不匹配时零发送；
- 一个账户失败不能跳过其他合法账户，也不能把其他账户结果写回当前 outcome。

### 7.3 模型 contract

扩展 `tests/ai/llm.test.js`：

- v1.6 正确解释 `decision_context_status` 与 `reference_facts_status`；
- 参考事实缺失不等于管理组消失；
- 模型只能输出管理组级候选，不能输出账户或 ticket；
- v1.6 输出经过 repair 后仍必须满足 evidence refs 和 reason code 约束。

### 7.4 前端行为测试

在 `tests/ai/frontend-demand-loading.test.js` 增加可执行 harness，而不只检查字符串：

1. 初始 ticket map 没有新 ticket；新 position push 后先显示普通文本。
2. `signal_execution_updated` 触发一次合并刷新；接口返回新映射后，现有持仓无需 F5 变成信号链接。
3. 连续 execution/positions 事件只发一次同 generation 请求。
4. 账户切换后，旧账户请求晚返回也不能覆盖新账户映射或重绘新账户表格。
5. 请求失败时保留旧映射并允许后续重试。
6. 仅价格/浮盈更新不触发 ticket map 请求。

同步更新 frontend governance/static cache tests。

### 7.5 验证命令

实施后至少执行：

```powershell
npm test -- --run tests/ai/position-management.test.js tests/ai/position-management-worker.test.js tests/ai/llm.test.js
npm test -- --run tests/ai/frontend-demand-loading.test.js tests/ai/frontend-governance.test.js tests/ai/frontend-precise-fixes.test.js
node --check server/routes/ai/position-management.js
node --check public/ai/app.js
git diff --check
```

随后执行完整 `npm test`。任何既有失败必须与本次变更区分并记录，不能以定向测试通过代替全量回归。

## 8. 实施顺序

### 阶段 1：先建立失败回归

- 改写错误的 reference-only 测试。
- 增加多账户 pending、position、孤儿组和隐私断言。
- 增加前端票号 generation 行为测试。
- 验收：测试在旧代码上能够稳定暴露本次三个缺陷。

### 阶段 2：拆分模型证据与执行目标

- 重构 `loadActivePositionManagementContext()`。
- 保留完整私有 `_targets`，只把观摩源匿名事实加入可序列化 context。
- 加入 management-group 不变量检查与去重。
- 验收：模型组数量按 thesis/group 计算，执行目标数量按 active outcomes 计算，两者不再混用。

### 阶段 3：升级 v1.6 决策证据语义

- 更新 contract、提示词和验证器。
- 允许无观摩终端事实但有完整冻结论点与闭合行情的组继续评估。
- 保留所有 reason/evidence/repair/fail-closed 约束。
- 验收：孤儿组可产生候选，但缺少决策证据的组仍只能 hold/keep。

### 阶段 4：验证逐账户任务和 worker 防线

- 确认 pending cancel 一次确认、position exit 两次确认均逐 outcome 隔离。
- 覆盖 stale target、账户切换、Magic/策略不匹配、命令幂等和零误发。
- 验收：一个管理组可安全产生多个账户任务，每条命令只作用于自己的当前订单。

### 阶段 5：修复前端票号缓存失效

- 增加 ticket-map generation、合并调度和异步响应防串账户。
- 在 execution update 和结构性 position change 后刷新并重绘。
- 更新静态 build key。
- 验收：无需 F5 完成关联，且高频行情不增加 ticket-map 请求。

### 阶段 6：全量回归与发布前审查

- 执行定向测试、完整测试、语法和 diff 检查。
- 审查模型 JSON 隐私字段、任务幂等、生产旧记录处理和缓存 race。
- 形成单一、可回滚的 scoped commit；提交、推送、合并和部署需用户另行授权。

## 9. 生产验收与安全发布

部署前记录运行分支、旧 commit、目标 commit、工作树状态和健康基线。生产验收必须使用自然产生或明确授权的 demo 场景，不得为了验证主动创建真实订单。

验收矩阵：

1. 管理员与订阅账户同组挂单，模型新周期给出 cancel：每个仍存在挂单的账户各有一条任务和独立 Bridge 结果。
2. 管理员挂单已取消、订阅挂单仍存在：订阅挂单继续进入评估，管理员不再创建任务。
3. 管理员与订阅账户同组持仓，连续两个闭合周期给出 exit：两个账户独立累计确认并各自执行。
4. 管理员仓先关闭、订阅仓仍存在：订阅仓的管理组不消失。
5. 订阅账户订单在执行前已经人工变化：worker 拒绝且不发送错误命令。
6. 新持仓成交并落库后，页面不刷新浏览器即可显示票号信号链接。
7. 管理员和订阅用户看到的管理状态与各自真实任务一致，不把管理员成功显示为订阅用户成功。

旧信号 13073 只作为历史诊断证据，不作为部署后自动重试对象。

## 10. 回滚标准

出现以下任一情况立即停止发布或回滚代码：

- 模型上下文出现订阅账户、ticket、volume、profit、balance、equity 等私有字段；
- 任务命中人工单、其他策略订单或错误账户；
- 同一 outcome/闭合周期产生重复命令；
- 观摩源缺失导致大量无证据 exit/cancel；
- 账户切换后票号映射串到其他账户；
- Bridge/数据库健康异常或完整测试出现相关回归。

本方案不含 schema 迁移，代码可通过回退目标 commit 恢复。若生产已经创建了新任务，不能通过删库回滚；应使用现有全局冻结/最大模式控制阻止后续自动执行，并在只读核验每个任务、命令和 broker 状态后另行处理。

## 11. 两轮方案复审

### 第一轮：业务和隐私边界复审

发现仅删除 `referenceOutcomeIds` 过滤会把订阅目标重新带回同一个可序列化 group，存在把私有终端事实误送给共享模型的风险；同时，现有 `current_facts_status` 会继续把孤儿组改成 hold/keep。

调整：明确建立三套数据结构；`_targets` 永不序列化；模型只接收管理组级冻结论点、闭合行情和观摩源匿名事实；增加独立的决策证据状态，避免把“观摩源没有订单”等同于“无法判断策略逻辑”。

### 第二轮：执行安全、历史数据和前端竞态复审

发现直接重放旧决策可能对已经变化的 broker 订单执行过时操作；前端简单 `forceRefresh` 也可能被旧账户异步响应覆盖，或在高频 positions 推送中形成请求风暴。

调整：只允许新自然推理周期产生任务；不回填旧确认次数；保留逐账户 worker preflight 和幂等 operation ID；前端采用 account generation + ticket generation + 合并 flight，并在失败时保留已有映射。

## 12. 剩余风险

- 当前生产尚无“同一 auto-shared 管理组在管理员和订阅账户均成交为持仓”的近期真实样本，平仓修复的生产验收需要等待自然 demo 场景或另行授权的受控测试。
- broker 在推理与执行之间仍可能变化，只能由 worker 实时 preflight 和幂等状态机降低风险，不能由模型上下文彻底消除。
- 历史 auto-shared outcome 如果本身缺失 thesis/management group，不在本方案自动修复范围；实施前后应只读统计并单独报告。
- `admin_strategy_dispatch` 是否未来进入 AI 持仓管理仍是独立产品决策，不能与本缺陷修复混合发布。
