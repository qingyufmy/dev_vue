# Mimo Code 任务：自动推理核心链路 1-6 项修复

## 1. 任务目标

修复当前自动推理主链路中已经确认的 6 项问题：

1. AI `cancel_pending` 绕过用户自动交易和交易发送开关。
2. 用户选择第 2/3 档止盈但对应价格为空时，自动订单仍可发送。
3. 自动交易只限制单笔手数，不限制同品种累计持仓，也缺少可靠的执行幂等保护。
4. 用户在自动推理配置中选择的品种没有持久化，实际会订阅策略全部品种。
5. Redis 调度锁没有续租，释放非原子，冷却失败后可能重复推理。
6. 手动执行 AI 挂单后写错状态字段，挂单对账器无法继续跟踪。

本任务要求完整修复、补充自动化测试、给出手工实测步骤，并提交到 `dev_codex`。

## 2. 仓库和分支约束

- 仓库：`D:\dev_codex\wall-street-skill-local`
- 只能在 `dev_codex` 分支工作。
- 禁止合并到 `main`，禁止修改、强推或重置 `main`。
- 开始前执行并记录：

```powershell
git status --short --branch
git log -5 --oneline
```

- 当前工作区可能已经存在其他用户或 Agent 的并发改动。编写本任务时观察到以下文件为未提交状态：
  - `server/bridge-ws.js`
  - `server/migrations.js`，其中包括 migration `047_add_thinking_mode`
  - `server/routes/ai/config.js`，其中包括 `thinking_enabled`、`reasoning_effort` 保存逻辑
  - `server/routes/ai/llm.js`
  - `server/routes/ai/scheduler.js`
  - 未跟踪的 `.mcp.json`、`test-mcp.js`
- 上述内容不属于本任务。不得删除、覆盖、回退或擅自重写。
- Mimo 开始执行时必须重新运行 `git status` 和 `git diff`，以实际状态为准。若这些改动仍未提交，先辨认其内容和来源，必须在结果文件中说明如何保留；不要把 `.mcp.json`、`test-mcp.js` 加入提交。
- 修改前先阅读完整调用链，不允许只根据本文行号机械修改。重点文件：
  - `server/routes/ai/config.js`
  - `server/routes/ai/llm.js`
  - `server/routes/ai/scheduler.js`
  - `server/routes/ai/strategy.js`
  - `server/bridge-ws.js`
  - `server/db.js`
  - `server/migrations.js`
  - `public/ai/app.js`
  - `tests/ai/*.test.js`
  - `tests/bridge-ws.test.js`

## 3. 明确不处理的内容

以下内容本次不要修改：

- 不处理原审查第 7 项：migration `035_default_bridge_settings`。
- 不处理原审查第 8 项：智能平仓全部逻辑。
- 不处理任何次要问题，包括模型非数字手数、手动推理周期展示、订阅刷新失败策略等。
- 不重写缠论算法、行情指标、提示词管理、观摩模式或桥接重连架构。
- 不改变“手动执行不走后端风控”的既定设计。
- 不改变“自动推理使用管理员桥接行情，交易使用用户自己的桥接”的既定设计。
- 不新增前端框架，不做无关重构，不改 UI 视觉样式。

## 4. 修复一：`cancel_pending` 必须执行完整权限门禁

### 当前问题

`server/routes/ai/scheduler.js` 在共享信号分发后，直接对 `onlineSubscribers` 执行 `cancel_pending`。用户即使关闭以下任一开关，仍可能被撤单：

- `auto_scheduler.enable_auto_trade`
- `user_bridge_settings.trade_send_enabled`
- 运行时桥接的 `tradeEnabled`

自动下单稍后才查询这些开关，撤单没有复用该结果。

### 必须实现

1. 将“允许自动执行交易动作”的用户筛选提取为一个明确的服务端门禁，撤单和开仓共用同一套判定：
   - `auto_scheduler.enabled = 1`
   - `auto_scheduler.enable_auto_trade = 1`
   - 用户仍为 `pro`，管理员按项目现有权限规则处理
   - `user_bridge_settings.trade_send_enabled = 1`
   - `isBridgeAlive(userId) === true`
   - `isTradeEnabled(userId) === true`
   - 用户仍订阅当前 `prompt_type_id + symbol`
2. `cancel_pending` 只能对通过门禁的用户执行。未通过门禁的用户仍可接收信号，但不得撤单、挂单或开仓。
3. 在每次真正发送撤单指令前再次检查桥接和交易发送状态，防止筛选后状态发生变化。
4. 对模型输出的撤单条件做服务端规范化：
   - `symbol` 必须与本轮调度品种一致，比较时使用项目统一的 broker suffix 归一化方法。
   - `pending_type` 只能是项目支持的挂单类型。
   - `max_price`、`min_price` 必须是有限数字。
   - 无效条件忽略并记录审计，不得扩大为 `cancel_all`。
5. 同一挂单命中多个条件时只能撤销一次，按 `userId + ticket` 去重。
6. `pending_list` 获取失败、返回结构异常或撤单返回 `status !== 'success'` 时必须失败关闭：不得假设撤单成功，不得更新数据库为 cancelled。
7. 成功、跳过、失败都要有清晰审计，审计中包含 `signal_id`、`prompt_type_id`、`ticket`、原因和实际 MT5 结果；不得记录密钥或完整敏感请求。

### 验收测试

- 自动推理开启、自动交易关闭：收到信号，但不调用 `pending_list/cancel_pending/open/pending`。
- 自动交易开启、交易发送关闭：收到信号，但不执行任何交易动作。
- 两个撤单条件命中同一 ticket：只发送一次撤单命令。
- `XAUUSD` 条件能匹配用户桥接返回的 `XAUUSD.s`，但不能匹配其他品种。
- MT5 返回 `{ status: 'error' }` 时数据库不能写成 cancelled。

## 5. 修复二：自动订单禁止缺失所选止盈档位

### 当前问题

`normalizeAiSignal()` 会清空方向错误的 TP2/TP3；`signalOrderPayload()` 仍按用户 `selected_take_profit` 直接取值；`validateTradeRequest()` 不要求 AI 自动订单必须具备有效 SL/TP。因此可以生成 `tp=null` 的自动订单。

### 必须实现

1. 不改变用户选择的止盈档位，不允许静默从 TP2/TP3 降级成 TP1。
2. 在自动执行的最终服务端校验中要求：
   - `sl`、所选 `tp` 都是大于 0 的有限数字。
   - 买单 `sl < entryReference` 且 `tp > entryReference`。
   - 卖单 `sl > entryReference` 且 `tp < entryReference`。
   - 挂单使用挂单入场/触发语义对应的参考价；市价单优先使用执行前最新 quote。
3. 如果用户所选 TP2/TP3 不存在或无效，本用户本次自动执行必须标记为 `rejected` 或 `skipped`，不得向 MT5 发送订单。
4. 信号仍正常保存和推送，不能因为某个用户所选止盈档位无效而阻断其他用户。
5. 拒绝原因使用稳定机器码，例如 `selected_take_profit_missing`、`invalid_stop_loss_direction`、`invalid_take_profit_direction`，并写入 delivery 和审计。
6. 此校验只约束自动执行路径。不要改变用户已经确认的“手动执行不走后端风控”设计。

### 验收测试

- 用户选择 TP2，信号 TP2 为 null：不调用 MT5 下单。
- 用户选择 TP3，TP3 方向错误：不调用 MT5 下单。
- 买卖方向正确、SL 和所选 TP 有效：允许继续执行。
- 一个用户 TP2 无效、另一个用户选择 TP1：前者拒绝，后者正常执行。

## 6. 修复三：累计持仓限制和自动执行幂等

### 当前问题

`validateTradeRequest(config, account, positions, request)` 接收了 `positions`，但不使用。`max_position_size` 只限制单笔手数。同一策略连续产生同方向市价信号时，可以持续叠加仓位。

### 必须实现

1. 在自动执行前读取用户最新账户、持仓和最新报价，不得使用管理员账户持仓做用户执行风控。
2. 将用户的 `max_position_size` 明确定义为自动交易下“同一标准化品种的累计持仓手数上限”：
   - 使用 broker suffix 归一化后比较品种。
   - 累计该品种所有当前持仓的绝对 `volume`。
   - `当前累计手数 + 新订单手数 > max_position_size` 时拒绝。
   - 不允许通过买卖对冲抵消后按净头寸放行，使用 gross exposure。
3. 所有数字必须 `Number.isFinite()`；持仓返回结构异常时失败关闭，不得按空持仓继续下单。
4. 对自动 delivery 增加数据库原子认领：
   - 执行前将 `execution_status` 从 `not_attempted` 条件更新为 `executing`。
   - 只有受影响行数为 1 的执行者可以向 MT5 发单。
   - 其他并发调用必须跳过，防止同一用户、同一 signal 重复执行。
   - 成功、拒绝、失败必须从 `executing` 落到终态。
5. 如果需要给 `auto_signal_deliveries` 增加执行认领时间或重试字段，使用新的、幂等的 migration；同时更新 `server/db.js` 新库建表结构。
6. 不允许一个 delivery 永久卡在 `executing`。如实现超时恢复，必须只恢复“确认没有成功发单证据”的记录，避免重试造成重复真实订单；方案和限制写进结果文件。
7. 挂单数量保护读取 `pending_list` 失败时必须失败关闭，不得按 0 笔挂单继续提交新挂单。
8. 挂单品种比较统一使用 broker suffix 归一化，避免 `XAUUSD` 与 `XAUUSD.s` 导致旧挂单未识别、重复挂单。

### 验收测试

- 当前 XAUUSD 持仓 0.04，用户上限 0.05，新订单 0.02：拒绝。
- 当前 `XAUUSD.s` 持仓 0.03，新订单 `XAUUSD` 0.02，上限 0.05：允许；再增加 0.01：拒绝。
- 两个并发执行者认领同一 delivery：只有一个能调用 MT5。
- `positions` 或 `pending_list` 响应异常：不发送订单。
- 已处于 success/rejected/failed 的 delivery 不可再次执行。

## 7. 修复四：恢复用户级多品种选择持久化

### 当前问题

前端提交 `selected_symbols`，后端只验证不保存。`auto_scheduler.symbols` 已被删除，配置读取、Redis 重建、订阅查询和调度重建全部使用 `auto_prompt_types.symbols_json`，导致用户实际订阅策略全部品种。

### 数据模型要求

1. 不恢复含义模糊的旧 `symbols` 字段。新增明确字段，例如：

```sql
auto_scheduler.selected_symbols_json TEXT NULL
```

2. 新增独立、幂等 migration，并同步更新 `server/db.js` 的新库建表结构。
3. 兼容已有数据：
   - `selected_symbols_json IS NULL` 表示旧用户尚未明确保存选择，运行时回退为当前策略支持的全部品种。
   - 用户保存配置后必须写入明确 JSON 数组。
   - 不使用空数组表示“全部”。空数组表示未选择任何品种，开启自动推理时必须拒绝或显示 `no_symbols`，不得偷偷恢复成全部。
4. 策略支持品种变化后，实际用户品种必须取：

```text
用户已选品种 ∩ 当前策略支持品种
```

失效品种不能继续订阅或执行。

### 必须修改的链路

- `saveUserAutoConfig()`：验证后持久化 `selected_symbols_json`。
- `getAutoConfig()`、`getUserAutoConfig()`：返回用户真实选择。
- `getAutoSubscribers()`：按用户真实选择筛选。
- `reconcileAutoSchedulers()`：只为至少一个在线订阅用户实际选择的品种建立调度器。
- `rebuildRedisSubscriptions()`、`syncUserRedisSubscription()`：Redis 中保存真实用户选择。
- `getUserAutoRuntimeStatus()`：状态和 title 展示真实选择，不是策略全部品种。
- `toggle_auto`、桥接重连恢复、配置保存后的 reconcile：保持相同语义。
- 管理员调度统计：订阅数按真实用户选择统计。

### 一致性要求

- 保存策略和品种选择时使用参数化 SQL。
- 用户选择的品种必须是当前策略支持品种的子集。
- 品种统一大写、去空格、去重；调度 key 比较使用 broker suffix 归一化。
- 切换策略时，前端提交的新选择必须一次保存；不能保留旧策略不支持的品种。
- 保存配置时自动推理已经开启，应在保存成功后移除旧订阅、加入新订阅并立即 reconcile。

### 验收测试

- 策略支持 XAUUSD、EURUSD，用户只选 EURUSD：刷新、重连、服务器重启后仍只订阅 EURUSD。
- 两个用户分别选择不同品种：只建立对应调度 key，信号不串发。
- 管理员从策略删除 EURUSD：用户旧选择中的 EURUSD 自动失效，不再订阅。
- 明确保存空数组后不能启动调度器，返回 `no_symbols`。
- 旧用户字段为 NULL 时仍按策略全部品种运行，保证升级兼容。

## 8. 修复五：Redis 调度锁、续租和冷却原子化

### 当前问题

- 锁固定 10 分钟过期，没有续租。
- 解锁使用 `GET` 后 `DEL`，不是原子 compare-and-delete。
- cooldown 查询异常后继续执行。
- `setCooldown()` 失败结果被忽略，下一次 tick 可能很快再次推理。

### 必须实现

1. 锁 token 必须随机且每次任务唯一。
2. 使用 Redis Lua 或等效原子操作实现：
   - 仅 token 匹配时续租。
   - 仅 token 匹配时释放。
   - 不得使用分离的 `GET` + `DEL`。
3. 推理执行期间启动锁续租，续租间隔显著小于锁 TTL；任务结束后可靠停止续租定时器。
4. 续租失败或发现 token 已不属于当前任务时：
   - 标记本轮锁已丢失。
   - 禁止进入后续真实交易动作。
   - 已经生成但未执行的信号可保存为不可执行状态或终止本轮，具体实现写入结果文件。
5. 冷却检查失败必须失败关闭，本轮不得推理。
6. 成功完成一轮后，将“设置 cooldown + 释放当前锁”做成 token 校验下的原子收尾，确保不会删除其他实例的新锁。
7. 冷却写入失败时不得按成功完成并在 5 秒后重跑。状态应显示 Redis/调度锁异常并等待 Redis 恢复。
8. 本地 `inFlight` 只能作为单进程优化，不能替代 Redis 锁。
9. `stopUnifiedScheduler()` 必须清理 tick timer 和锁续租 timer；不能留下后台定时器。
10. Redis 不可用时继续保持当前“自动推理暂停”的设计，不允许降级成本地锁执行。

### 验收测试

- 两个模拟实例同时获取同一 key：只有一个成功。
- 旧 token 不能释放或续租新 token 的锁。
- 长任务超过初始 TTL，续租正常时第二实例仍无法获取锁。
- 续租失败后不执行撤单、挂单或开仓。
- cooldown TTL 查询异常时不调用 AI。
- cooldown 设置失败时不会在短时间内重复产生第二个信号。
- 停止调度器后不存在续租 timer。

## 9. 修复六：统一挂单状态生命周期

### 当前问题

`server/bridge-ws.js` 的手动信号执行路径存在两种错误：

- 共享信号挂单写入 `trade_ticket/is_executed`，没有写 `pending_ticket/pending_state`。
- 普通信号挂单写入 `order_state='pending'`，但对账器查询 `pending_state='pending'`。

因此手动执行 AI 挂单后不会进入 `reconcilePendingOrders()`。

### 状态语义

统一使用：

```text
pending -> filled | cancelled | expired | superseded
```

`trade_ticket` 只表示已成交后的持仓/成交 ticket；`pending_ticket` 表示挂单 ticket。挂单刚提交成功时不得提前标记为已成交。

### 必须实现

1. 手动执行普通 AI 信号挂单成功后更新 `ai_signals`：
   - `pending_ticket`
   - `pending_state = 'pending'`
   - `pending_valid_until`
   - 不要只写 `order_state`。
2. 手动执行共享信号挂单成功后更新当前用户的 `auto_signal_deliveries`：
   - `pending_ticket`
   - `pending_state = 'pending'`
   - `pending_valid_until`
   - `execution_status = 'success'`
   - 不要把挂单 ticket 写成已成交 `trade_ticket`。
3. 自动执行共享挂单继续以 delivery 表作为每用户真实状态来源。不要用共享 `ai_signals` 的单个 ticket 表示多个用户的挂单。
4. 市价订单成功才设置 `is_executed=1` 和 `trade_ticket`。挂单是否沿用 `is_executed` 表示“已发送”必须统一定义；推荐挂单 pending 阶段保持 `is_executed=0`，成交后再设 1，并同步调整所有查询和 UI。若保留其他语义，必须在结果文件解释且保证所有路径一致。
5. `reconcilePendingOrders()` 必须能够处理普通信号和 delivery 两种来源，并修复其中未定义日志函数 `l(...)` 的错误。
6. MT5 `pending/open/cancel` 返回 `status !== 'success'` 时不能写成功状态。
7. 对账更新必须带记录 id 和用户 id 等必要条件，避免同 ticket 在不同用户间串改。
8. 对共享信号的成交、取消、过期只更新对应 delivery；共享根信号不得被某一个用户的 ticket 覆盖。
9. 对账完成后给对应用户推送状态事件，前端重新加载时数据库状态必须一致。

### 验收测试

- 手动执行普通 pending 信号：进入 `ai_signals.pending_state='pending'`，对账器能发现。
- 手动执行共享 pending 信号：只更新当前用户 delivery，不污染其他用户和共享根信号。
- 挂单成交：pending 状态变 filled，填写 trade ticket 和 executed_at。
- 挂单消失且已过有效期：变 expired。
- 挂单消失但未过有效期：按当前既定规则变 cancelled。
- MT5 返回 error：状态不能写 success/pending。
- 两个用户的相同 ticket 文本不会互相更新。

## 10. 数据库迁移要求

- 新 migration ID 必须先检查当前最大 ID，避免与用户现有 `047_add_thinking_mode` 冲突。
- migration 必须幂等，重复启动不得失败。
- 新字段同时写入 `server/db.js` 的 `CREATE TABLE IF NOT EXISTS` 定义。
- 不得修改或删除历史 migration 035。
- 不得把现有用户 `enabled`、`enable_auto_trade`、`trade_send_enabled` 批量改值。
- 如需回填用户品种，只允许使用“NULL 表示旧用户回退策略全部品种”的兼容语义，不要伪造用户选择。

## 11. 自动化测试要求

至少补充或扩展以下测试：

- `tests/ai/config.test.js`
  - 用户品种持久化和策略交集。
  - 累计持仓上限。
  - 所选 TP 缺失/方向错误拒绝。
- `tests/ai/scheduler.test.js`
  - 撤单权限门禁。
  - 撤单条件归一化和 ticket 去重。
  - delivery 原子认领。
  - Redis token 续租、原子释放、冷却失败关闭。
  - 挂单列表失败关闭。
- `tests/bridge-ws.test.js` 或新的聚焦测试文件
  - 普通信号和共享信号手动挂单的数据库字段。
  - MT5 error 不写成功。
- 必要时扩展 `tests/ai/llm.test.js`，但不要借机处理本任务明确排除的非数字手数次要问题。

测试必须验证实际行为和 SQL 参数，不能只检查函数存在或字符串包含。

## 12. 验证命令

在仓库根目录执行：

```powershell
node --check server/routes/ai/config.js
node --check server/routes/ai/llm.js
node --check server/routes/ai/scheduler.js
node --check server/routes/ai/strategy.js
node --check server/bridge-ws.js
node --check server/db.js
node --check server/migrations.js
npm.cmd test
git diff --check
```

如果本机环境允许，再执行：

```powershell
npm.cmd run dev
```

启动后观察至少 30 秒，确认没有 `[FATAL]`、migration 错误、未处理 Promise rejection 或调度器高频重复日志。若因数据库、Redis、端口或环境变量无法启动，必须记录准确原因，不得写“已验证通过”。

## 13. 手工实测说明要求

结果文件必须按可操作步骤写清楚以下实测方法，每一步包括前置数据、操作、预期前端状态、预期数据库字段和预期日志：

1. 策略支持两个品种，用户只选一个，保存、刷新、桥接重连、服务器重启后检查订阅。
2. 用户关闭自动交易，但保持自动推理开启，生成包含 `cancel_pending` 的信号，确认只推送不撤单。
3. 用户关闭交易发送，重复第 2 步。
4. 用户选择 TP2，但构造 TP2 缺失信号，确认 delivery 被拒绝且 MT5 无订单。
5. 已有同品种持仓接近手数上限，确认新自动订单被累计持仓规则阻止。
6. 同一 delivery 并发触发两次，确认只有一个 MT5 命令。
7. 手动执行普通 pending 信号和共享 pending 信号，分别检查数据库 pending 字段。
8. 模拟挂单成交、取消、过期，运行对账器后检查状态。
9. 两个 Node 实例竞争同一 scheduler key，确认只有一个实例推理；长任务续租期间第二实例仍不能获取锁。
10. Redis 在 TTL/cooldown/续租阶段失败时，确认系统暂停且不会重复推理或执行交易。

## 14. 提交与推送

完成后：

1. 再次执行 `git status --short --branch` 和 `git diff --check`。
2. 确认没有提交 `.env`、令牌、API Key、`.mcp.json`、`test-mcp.js`、日志、构建产物或数据库文件。
3. 提交信息建议：

```text
fix: harden automatic inference execution flow
```

4. 推送到：

```powershell
git push origin dev_codex
```

5. 禁止推送到 `main`。

## 15. 结果文件

必须创建：

`docs/agent-results/20260711-mimo-ai-inference-core-safety-fix-result.md`

结果文件必须包含：

1. 实际分支名。
2. 修复前 commit、修复后真实 commit hash 和提交信息；禁止写“待提交”。
3. 是否已推送到 `origin/dev_codex`。
4. 修改文件清单，每个文件注明函数名、具体改动和影响范围。
5. 六项问题逐项说明实际实现，不得只写“已修复”。
6. migration ID、新字段、NULL/空数组兼容语义和回滚风险。
7. Redis 锁 TTL、续租间隔、Lua 原子操作和锁丢失后的处理方式。
8. delivery 幂等认领和 `executing` 卡住时的处理方式。
9. 所有测试、语法检查、启动检查的真实命令与真实结果。
10. 第 13 节要求的详细手工实测步骤。
11. 未完成项、已知风险和无法验证项。
12. 说明如何保留任务开始前已有的 thinking mode 改动，以及它们是否进入本次 commit。

## 16. 完成标准

只有同时满足以下条件才算完成：

- 第 1 至第 6 项均完成且有针对性测试。
- 用户关闭自动交易或交易发送后，任何 AI 自动交易动作都不能执行，包括撤单。
- 自动订单不可能携带缺失或方向错误的所选 TP。
- 用户品种选择可跨刷新、重连和重启保持。
- 同一 delivery 不会并发重复执行。
- Redis 锁可以续租并原子释放，Redis 异常时失败关闭。
- 普通和共享挂单都进入统一 pending 生命周期。
- 全量测试通过，或对无法通过项给出真实、可复现的阻塞原因。
- 已提交并推送到 `origin/dev_codex`。
- 结果文件包含真实 commit hash、详细改动位置和完整手工实测说明。
