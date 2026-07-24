# Mimo Code 二次修复任务：自动推理核心安全链路验收缺陷

## 1. 背景与目标

上一轮任务已提交：

```text
997cfd0 fix: harden automatic inference execution flow (6 items)
```

Codex 对 `fe913bb..997cfd0` 的实际代码复核发现：上一轮结果文件宣称完成，但仍有 9 项明确缺陷。其中最严重的问题会导致所有自动开仓和自动挂单永远跳过；Redis 锁丢失后也不能阻止后续交易动作。

本任务必须修复这 9 项残留问题，并补齐真正覆盖新代码的专项测试。禁止再次仅运行旧的 469 个测试后声称完成。

## 2. 仓库、分支和基线

- 仓库：`D:\dev_codex\wall-street-skill-local`
- 分支：只能使用 `dev_codex`
- 审查基线 commit：`997cfd0`
- 禁止合并、提交或推送到 `main`
- 开始前执行：

```powershell
git status --short --branch
git log -5 --oneline --decorate
git diff --check
```

当前可能存在以下未跟踪文件，禁止加入提交：

- `.mcp.json`
- `test-mcp.js`
- `docs/agent-tasks/20260711-mimo-ai-inference-core-safety-fix.md`
- `docs/agent-results/20260711-mimo-ai-inference-core-safety-fix-result.md`
- 本任务文件

不得删除、覆盖或回退用户已有改动。不得泄露 `.env`、API Key、令牌、密码或桥接认证信息。

## 3. 本次修改范围

重点文件：

- `server/db.js`
- `server/migrations.js`
- `server/routes/ai/config.js`
- `server/routes/ai/scheduler.js`
- `server/bridge-ws.js`
- `tests/ai/config.test.js`
- `tests/ai/scheduler.test.js`
- `tests/bridge-ws.test.js`
- 必要时新增一个聚焦自动推理执行链路的测试文件

## 4. 明确不处理

- 不处理 migration 035。
- 不处理智能平仓。
- 不处理缠论、行情指标或提示词算法。
- 不改变观摩模式的数据来源。
- 不改变“手动执行不走后端风控”的既定设计。
- 不修改 thinking mode 功能。
- 不做无关重构或 UI 样式调整。

## 5. 缺陷一：delivery 认领结果字段写错，自动交易全部失效

### 已确认原因

`server/db.js` 的 `queryRun()` 返回：

```js
{ changes: result.affectedRows, insertId: result.insertId }
```

但 `executeDelivery()` 使用：

```js
if (claimed.affectedRows !== 1) return
```

`claimed.affectedRows` 永远是 `undefined`，因此自动 delivery 全部在认领后直接返回。

### 必须修改

1. 使用项目真实返回契约判断：`claimed.changes === 1`。
2. 不要修改 `queryRun()` 的公共返回结构，避免影响全项目调用者。
3. 认领 SQL 必须保持条件更新：只有 `execution_status='not_attempted'` 才能进入 `executing`。
4. `queryRun()` 返回 null、缺少 `changes`、`changes !== 1` 时失败关闭，不调用 MT5。
5. 增加自动化测试，真实 mock `queryRun()` 返回 `{ changes: 1 }` 和 `{ changes: 0 }`：
   - `changes=1` 时继续走后续自动执行。
   - `changes=0` 时不调用 MT5。
   - 两次并发认领同一 delivery，只有一次能执行。

## 6. 缺陷二：Redis 锁丢失不能中断交易，收尾也没有原子化

### 已确认原因

- `lockLost` 只在调用 `runUnifiedAutoCycle()` 前检查一次。
- 续租失败发生在推理运行过程中时，信号保存、撤单和下单不会再读取 `lockLost`。
- 当前先 `setCooldown()`、再释放锁、最后又 `setCooldown()`，不是原子收尾。
- `stopUnifiedScheduler()` 无法访问局部变量 `lockRenewTimer`，不能在停止调度器时立即清除续租 timer。

### 必须实现：统一 Lock Guard

1. 为每轮调度创建明确的锁上下文，例如：

```js
{
  key,
  token,
  lost,
  renewTimer,
  async assertOwned(),
  async isOwned()
}
```

具体命名可调整，但必须把锁所有权传递到 `runUnifiedAutoCycle()`、撤单和 `executeDelivery()`，不能只保存在 tick 局部闭包中。

2. `isOwned()` 必须向 Redis 校验当前 lock key 的 token，而不是只看本地布尔值。
3. 以下不可逆阶段之前必须重新校验锁所有权：
   - LLM 返回后、写入共享信号前。
   - 写入 deliveries/广播本轮信号前。
   - 每个用户开始 AI `cancel_pending` 前。
   - 每一笔真正发送 `cancel_pending` 前。
   - 每个 delivery 认领前。
   - 每次真正发送 `open` 或 `pending` 指令前。
4. 任一校验失败：
   - 本轮标记 `lock_lost`。
   - 禁止后续撤单、挂单和开仓。
   - 已认领但尚未向 MT5 发送的 delivery 必须落到明确的 `skipped_lock_lost` 或等价终态，不能卡在 `executing`。
   - 写入审计和调度状态。
5. 如果锁在某一笔 MT5 指令发送之后才丢失，不能自动重试该 delivery；将结果记为成功、失败或不确定，避免重复下单。

### 必须实现：原子 finalize

6. 使用一个 Lua 脚本完成 token 校验下的原子收尾：
   - 当前 token 匹配才允许设置 cooldown。
   - 设置 cooldown 成功后删除当前 lock。
   - 返回明确结果码。
7. 删除当前重复调用 `setCooldown()` 的逻辑。每轮只能有一个明确的 finalize 路径。
8. finalize 失败时不得 30 秒后盲目重跑。必须：
   - 保持调度器暂停状态。
   - Redis 恢复后先检查 lock/cooldown 状态。
   - 结合本轮 `lastRunAt` 或最近共享信号时间计算剩余间隔，不能立即再次推理。
9. 锁续租 timer 保存到 scheduler state/lock context，使 `stopUnifiedScheduler()` 可以清理。
10. 所有退出分支都必须清理续租 timer，防止 timer 泄漏。

### 专项测试

- 旧 token 不能续租、释放或 finalize 新 token 的锁。
- 续租失败发生在 LLM 等待期间，LLM 返回后不得保存可执行信号或执行交易动作。
- 续租失败发生在用户批量执行中，后续用户不得再执行。
- finalize 的 cooldown + del lock 必须通过一次 Lua eval 完成。
- finalize 失败后不会在 30 秒或 5 秒内重新推理。
- `stopUnifiedScheduler()` 能清除续租 timer。

## 7. 缺陷三：用户品种只写入，读取、Redis 和状态链路未接通

### 已确认未修改路径

以下函数仍使用 `auto_prompt_types.symbols_json`，忽略 `auto_scheduler.selected_symbols_json`：

- `getAutoConfig()`
- `getUserAutoConfig()`
- `getUserAutoRuntimeStatus()`
- `rebuildRedisSubscriptions()`

这会导致配置刷新显示策略全部品种，再次保存时覆盖用户原选择；Redis 订阅和状态 title 也会显示错误。

### 必须实现

1. 提取唯一的用户有效品种解析逻辑，避免 4 个模块各写一套不同规则。建议实现纯函数：

```text
resolveEffectiveSymbols(selected_symbols_json, strategy_symbols_json)
```

语义必须是：

- `selected_symbols_json === NULL`：旧用户回退为策略全部品种。
- 明确 JSON `[]`：用户没有选择任何品种，不得回退为全部。
- 非空数组：用户选择与当前策略支持品种取交集。
- JSON 损坏：失败关闭为空数组并记录警告，不能扩大为策略全部品种。
- 统一大写、trim、去重，并使用 broker suffix 规则匹配。

2. 全部接通：
   - `getAutoConfig()` 返回真实 `selected_symbols`。
   - `getUserAutoConfig()` 返回真实 `selected_symbols`。
   - `getUserAutoRuntimeStatus()` 的 `selected_symbols`、active keys 和 title 使用真实选择。
   - `rebuildRedisSubscriptions()` SELECT 并使用 `selected_symbols_json`。
   - `syncUserRedisSubscription()` 只能接收并写入真实有效选择。
   - `getAutoSubscribers()` 和 `reconcileAutoSchedulers()` 复用同一语义。
   - 桥接重连、toggle_auto、保存配置后重新同步 Redis 时不得恢复策略全部品种。
3. 用户明确保存空数组时：
   - 配置保存成功。
   - 自动推理不能建立 runtime scheduler。
   - 状态显示 `no_symbols`。
4. 管理员删除策略中的某个品种后，用户选择自动取交集，不再订阅已删除品种，但数据库原始用户选择可以保留以便审计。

### 专项测试

- 策略 `[XAUUSD, EURUSD]`，用户保存 `[EURUSD]`，所有读取接口、Redis 重建、reconcile 都只得到 EURUSD。
- 刷新配置再保存不会把 XAUUSD 加回来。
- NULL 回退全部；`[]` 保持空；损坏 JSON 失败关闭为空。
- 策略删除 EURUSD 后有效集合为空，不建立调度器。
- `XAUUSD.s` 与策略 `XAUUSD` 按统一 suffix 规则处理。

## 8. 缺陷四：自动挂单的 pending_list 失败后仍继续提交

### 已确认原因

`executeDelivery()` 的 supersede 路径在 `pending_list` 返回错误或抛错时只打印日志，之后仍继续调用 `executeOrder()`。

### 必须实现

1. 对挂单类型订单，`pending_list` 必须满足：
   - 响应存在。
   - `status !== 'error'`，推荐严格要求成功状态或合法数组。
   - `orders/pending_list` 是数组。
2. 任一条件不满足：
   - delivery 标记为 `rejected` 或 `skipped`。
   - 原因固定为 `pending_list_unavailable`。
   - 写审计。
   - 立即 return，不得发送新挂单。
3. supersede 中实际挂单品种比较使用 `stripBrokerSuffix()`，不能再用 `po.symbol === symbol`。
4. `pending_type` 统一转小写后比较。
5. 撤单结果必须严格要求 `status === 'success'`。任何其他返回都视为失败，不更新 superseded/cancelled。
6. 挂单数量限制应根据撤单后仍确认存在的同品种挂单计算，不能只统计撤单失败次数。

### 专项测试

- `pending_list` 返回 error、undefined、错误结构、抛异常：均不调用 `pending/open`。
- `XAUUSD.s` 能被 XAUUSD 新信号识别。
- 撤单返回空对象或非 success：不能写 superseded。
- 撤单后仍有 2 笔受限挂单：拒绝新挂单。

## 9. 缺陷五：AI cancel_pending 实际挂单比较仍不支持 broker suffix

### 必须实现

1. `normalizeCancelCondition()` 保留当前策略品种约束。
2. 对 `pendingOrders` 过滤时也使用：

```js
stripBrokerSuffix(po.symbol) === stripBrokerSuffix(cond.symbol)
```

3. `pending_type` 统一小写，并继续保持 ticket 去重。
4. 无效品种条件不得触碰其他品种挂单。

### 专项测试

- 条件 XAUUSD 可匹配 XAUUSD.s/XAUUSD.c。
- 条件 XAUUSD 不能匹配 EURUSD。
- 同一 ticket 被多个条件命中只撤一次。

## 10. 缺陷六：共享根信号仍被用户 pending ticket 污染

### 已确认位置

自动共享挂单成功后仍执行：

```sql
UPDATE ai_signals SET is_executed = 1, ... pending_ticket = ? WHERE id = ?
```

delivery 成交后又按 `pending_ticket` 更新共享 `ai_signals`。多用户会互相覆盖。

### 必须实现

1. 对 `source='auto_shared'` 的共享根 `ai_signals`：
   - 不写用户 `pending_ticket`。
   - 不写用户 `trade_ticket`。
   - 不因某个用户执行而写 `is_executed=1`。
   - 不写某个用户的 pending_state。
2. 每个用户的真实执行状态、pending ticket、trade ticket、executed_at 全部只写对应的 `auto_signal_deliveries`。
3. `reconcilePendingOrders()` 处理 delivery 成交时只更新该 delivery，不再通过 `pending_ticket` 更新共享根信号。
4. 手动执行共享信号同样只更新当前用户 delivery。
5. 普通用户私有信号继续使用 `ai_signals` 自身 pending 字段，不受影响。

### 专项测试

- 同一共享信号给两个用户产生不同 pending ticket，两个 delivery 各自保存，根信号保持无 ticket。
- 用户 A 成交不修改用户 B delivery，也不修改共享根 ticket。
- 私有信号 pending/filled 生命周期仍正常。

## 11. 缺陷七：自动订单最终 SL/TP 校验仍可绕过

### 已确认问题

- `order.sl == null` 时不拒绝。
- `entryRef <= 0` 时整段 SL/TP 校验跳过。
- 市价单使用管理员 `market.latest_price`，而不是用户执行前最新 quote。

### 必须实现

1. 自动执行最终校验必须强制要求：
   - `sl` 是有限正数。
   - 用户选择的 `tp` 是有限正数。
   - entry reference 是有限正数。
2. 市价单必须使用用户桥接执行前最新 quote：
   - buy 使用用户 ask。
   - sell 使用用户 bid。
3. 挂单使用实际挂单入场/触发语义对应的价格，并明确 stop_limit 的触发价与限价关系。
4. buy：`sl < entry < tp`；sell：`tp < entry < sl`。
5. quote 获取失败、价格不是有限正数、SL 缺失、TP 缺失或方向错误时失败关闭，不调用 MT5。
6. 避免在 `executeOrderCore()` 内重复获取 quote 后产生不同参考价。可以将已获取的新鲜 quote 传入执行层，或在最终发送前用同一份 quote 校验并执行。
7. 不改变浏览器手动执行不走后端风控的设计。

### 专项测试

- SL null、TP null、entry 0、quote error 均拒绝。
- buy/sell 正确和错误方向分别覆盖。
- 管理员价格与用户 quote 明显不同时，以用户 quote 为准。

## 12. 缺陷八：delivery 可能永久卡在 executing

### 安全原则

进程可能在认领后、MT5 发送前或发送后崩溃。不能简单把超时 executing 重置成 `not_attempted`，否则可能重复真实下单。

### 必须实现

1. 使用现有 `execution_claimed_at`，必要时新增 `execution_claimed_by` 或 `execution_attempt_id`。
2. 所有正常退出路径必须将 `executing` 落到：
   - `success`
   - `rejected`
   - `failed`
   - `skipped`
   - `uncertain`/`manual_review` 等明确不自动重试状态
3. 增加 stale executing 检查：
   - 超过合理阈值仍为 executing 时，标记 `uncertain` 或 `manual_review`。
   - 写审计和管理员可见日志。
   - 禁止自动重置并重发 MT5 指令。
4. 如果能通过明确 MT5 ticket/幂等 request id 证明已执行，可恢复为 success；不能证明时保持不确定，等待人工处理。
5. 服务启动后和周期 reconciler 中都要处理 stale executing，不能永久卡住。

### 专项测试

- 认领后正常成功/拒绝/异常均离开 executing。
- 模拟进程中断留下旧 executing，reconciler 标记 uncertain，不调用 MT5。
- 新鲜 executing 不被错误处理。

## 13. 缺陷九：Migration 048 可在字段创建失败后仍被标记成功

### 已确认原因

Migration 048 内部 catch 普通错误后只 `console.error()`，没有重新抛出；`runMigrations()` 随后仍插入 `schema_migrations`。

### 必须实现

1. 修正 migration 048：
   - Duplicate column 可作为幂等成功处理。
   - 其他错误必须 throw，让外层不能标记 applied。
2. 考虑 048 可能已经在生产数据库中被错误标记 applied，新增后续 repair migration，例如 049（执行前检查当前最大 ID）：
   - 查询 information_schema 验证 `execution_claimed_at`、`selected_symbols_json` 是否真实存在。
   - 缺失时补建。
   - 非 duplicate 错误必须抛出。
3. 如果本任务新增 claim/recovery 字段，也由 repair migration 一并保证。
4. 同步更新 `server/db.js` 新库建表结构。
5. 不修改 migration 035，不批量修改用户开关值。

### 专项测试或验证

- 模拟 ALTER 普通失败，migration 不写入 schema_migrations。
- 模拟 048 已标记但字段缺失，repair migration 能补齐。
- 字段已存在时重复启动无错误。

## 14. 强制自动化测试要求

上一轮没有新增任何测试，本轮禁止再次跳过。

1. 必须修改或新增测试文件，`git diff 997cfd0..HEAD -- tests` 必须有实质内容。
2. 测试总数必须高于当前 469。
3. 至少覆盖本文件每个“专项测试”章节的关键分支。
4. 不能只测试字符串、函数存在或 SQL 包含；必须验证：
   - DB mock 的返回契约和参数。
   - Redis eval/TTL/续租行为。
   - MT5 bridge 是否被调用或明确未调用。
   - delivery 和 ai_signals 分别被怎样更新。
5. 为便于测试，可以提取小型纯函数或依赖注入边界，但禁止为了测试暴露不安全的生产接口或重写整个调度架构。
6. 定时器测试必须使用 fake timers，并在测试后清理，不能留下 open handles。

## 15. 必须运行的验证命令

```powershell
node --check server/routes/ai/config.js
node --check server/routes/ai/scheduler.js
node --check server/bridge-ws.js
node --check server/db.js
node --check server/migrations.js
npm.cmd test
git diff --check
git status --short --branch
```

另外输出：

```powershell
git diff --stat 997cfd0..HEAD
git diff --name-status 997cfd0..HEAD
```

如果环境允许，执行：

```powershell
npm.cmd run dev
```

观察至少 30 秒，确认无 `[FATAL]`、migration error、unhandled rejection、5 秒重复推理或 timer 泄漏。无法启动时必须记录真实原因。

## 16. 手工实测说明

结果文件必须给出以下可直接操作的实测步骤，每项包含前置条件、操作、预期日志、预期数据库和预期 MT5 行为：

1. 开启自动交易并生成普通 buy/sell 信号，确认 delivery 能从 not_attempted 进入 executing 再进入终态，不再全部跳过。
2. 同一 delivery 并发执行两次，确认只有一次 MT5 指令。
3. Redis 续租失败后，确认 LLM 返回也不会撤单或下单。
4. 两实例竞争调度 key，确认一轮只有一个共享信号。
5. 用户只选择 EURUSD，刷新、重新保存、桥接重连、服务重启后仍只有 EURUSD。
6. pending_list 故障时确认不提交新挂单。
7. XAUUSD 条件能管理 XAUUSD.s 挂单。
8. 两用户执行同一共享 pending 信号，确认根 ai_signals 不保存用户 ticket。
9. 自动订单 SL 缺失、TP 缺失、用户 quote 方向错误时确认 MT5 无订单。
10. 模拟 stale executing，确认进入 uncertain/manual_review 且不自动重发。
11. 在测试数据库验证 048 已标记但字段缺失时，repair migration 能补齐。

## 17. 结果文件要求

必须创建：

`docs/agent-results/20260711-mimo-ai-inference-core-safety-followup-result.md`

结果文件必须包含：

1. 分支名。
2. 修复前 commit `997cfd0`。
3. 修复后真实 commit hash 和提交信息，禁止写“待提交”。
4. 是否推送到 `origin/dev_codex`。
5. 9 项缺陷逐项写明修改文件、函数、SQL、状态变化和安全边界。
6. Redis lock guard、续租、所有权检查和 atomic finalize 的真实实现说明。
7. 用户品种 NULL、空数组、损坏 JSON 的真实语义。
8. stale executing 的处理规则及为什么不会重复下单。
9. migration 048 修正和 repair migration 的 ID、字段及失败行为。
10. 新增测试文件、测试名称、新增测试数量和总测试数量。
11. 所有验证命令的真实输出摘要。
12. 第 16 节的详细手工实测步骤。
13. 未完成项和无法验证项。任何未完成项都不得写“任务全部完成”。

## 18. 提交与推送

完成后只提交本任务相关修改：

```text
fix: complete automatic inference safety hardening
```

然后：

```powershell
git push origin dev_codex
```

禁止提交 `.mcp.json`、`test-mcp.js`、`.env`、日志、数据库、构建目录或令牌。

## 19. 完成标准

只有全部满足才算完成：

- `claimed.changes === 1` 正确接通，自动交易不再全部跳过。
- Redis 锁丢失能阻止后续所有真实交易动作。
- cooldown 与 lock 通过 token 校验原子 finalize。
- 用户品种选择贯穿读取、Redis、reconcile、状态、重连和重启。
- pending_list 故障严格失败关闭，broker suffix 匹配一致。
- 共享根信号不再保存任何用户 ticket 或执行状态。
- 自动执行强制要求新鲜用户 quote、有效 SL 和所选 TP。
- stale executing 不会永久卡住，也不会被自动重发。
- migration 失败不会被错误标记 applied，已有坏状态可由 repair migration 修复。
- 有新增专项测试，测试总数高于 469，且全量测试通过。
- 已提交并推送到 `origin/dev_codex`。
- 结果文件包含真实 commit 和详细实测说明。
