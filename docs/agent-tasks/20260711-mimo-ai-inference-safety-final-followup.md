# Mimo Code 任务：自动推理安全收尾修复与真实专项测试

## 1. 任务背景

上一轮提交：

```text
19bd9c8 fix: close automatic inference safety gaps
```

Codex 对 `bdfeb0c..19bd9c8` 的实际代码和新增测试进行了复核，并执行了全量测试。当前虽然显示 484 项测试通过，但仍有 3 项生产逻辑缺陷和 1 项测试质量问题，因此不能验收。

本任务要求完成窄范围收尾修复。必须测试真实生产逻辑和状态变化，禁止继续使用“模块能够 import”“导出函数存在”或“mock 能返回自己设置的值”作为功能测试。

## 2. 仓库、分支与基线

- 仓库：`D:\dev_codex\wall-street-skill-local`
- 工作分支：`dev_codex`
- 修复基线：`19bd9c8`
- 禁止修改或推送 `main`
- 完成后提交并推送到 `origin/dev_codex`

开始前执行并记录：

```powershell
git status --short --branch
git log -5 --oneline --decorate
git diff --check
```

当前仓库存在若干未跟踪的任务文件、结果文件、`.mcp.json` 和 `test-mcp.js`。不得删除、覆盖或提交与本任务无关的未跟踪文件。

## 3. 修改范围

主要文件：

- `server/routes/ai/scheduler.js`
- `tests/ai/scheduler-safety.test.js`

确有必要时，可新增一个聚焦 scheduler 的测试文件，或将纯逻辑抽成仅供 scheduler 内部使用的 helper。不得进行无关重构。

## 4. 明确不处理

- 不改变观摩模式的数据来源和权限设计。
- 不改变手动交易不走后端风控的现有设计。
- 不修改缠论、LLM 提示词、行情指标和前端。
- 不修改自动推理的正常策略周期定义。
- 不处理 migration 035、打包和部署问题。
- 不删除用户或其他 Agent 已存在的未跟踪文件。

## 5. 修复一：finalize 失败恢复必须真正补写 cooldown

### 5.1 当前缺陷

当前恢复分支在 lock 不存在且 cooldown 不存在时执行：

```js
await finalizeLock(key, lockToken, Math.ceil(remaining / 1000))
```

`finalizeLock()` 的 Lua 只有在 lock key 当前值仍等于旧 token 时才会写 cooldown。恢复流程已经允许 lock key 不存在，因此该调用会返回 false，实际上无法补写 cooldown。

之后代码使用：

```js
setTimeout(tick, Math.min(remaining, 60000))
```

当策略周期大于 60 秒时，scheduler 可能在 60 秒左右重新进入正常 tick，而不是等待完整剩余周期。

### 5.2 必须实现

1. 保留正常 finalize 使用的原子 Lua：校验自己的 token、写 cooldown、删除 lock。
2. 为 finalize 失败恢复实现独立恢复流程，不能用旧 token 调用 `finalizeLock()` 假装补写成功。
3. 恢复流程必须区分以下状态：
   - Redis 不可用：继续处于 `finalize_failed`，只安排恢复检查，不执行正常 tick。
   - lock 被其他 token 持有：不删除、不覆盖该锁，不执行正常 tick；继续恢复检查。
   - cooldown 已存在：读取 TTL，等待 TTL，不重复写入，不执行推理。
   - lock 不存在且 cooldown 不存在：根据本轮是否已完成、`lastRunAt` 和 interval 计算保守剩余时间，并原子补写 cooldown。
   - lock 仍为自己的旧 token：允许通过安全 Lua 原子完成 finalize。
4. lock 不存在时补写 cooldown 应使用 `SET key value NX EX seconds` 或等价 Lua，防止覆盖其他实例刚写入的 cooldown。
5. 必须检查补写结果：
   - 写入成功，或发现 cooldown 已被其他实例写入，才算恢复成功。
   - Redis 写入失败时继续恢复检查，禁止进入正常 tick。
6. 禁止用 `Math.min(remaining, 60000)` 把完整等待周期压缩成 60 秒后直接执行推理。可以每 30/60 秒执行一次“只检查状态的 recovery poll”，但 recovery poll 绝不能调用推理周期。
7. 建议把 recovery timer 与普通 tick timer 分开保存，例如 `_finalizeRecoveryTimer`。`stopUnifiedScheduler()` 必须清理：
   - 普通 timer；
   - lock renew timer；
   - finalize recovery timer。
8. scheduler 被删除、停止或重建后，旧 recovery callback 不得重新写入 state 或启动 tick。callback 每次异步操作前后都应确认当前 state 实例仍有效且 running。
9. `lastRunAt` 解析失败时必须使用完整 interval 作为保守等待，不能得到 `NaN` 后缩短等待。
10. 恢复状态和错误原因需保留在 scheduler state/Redis state，方便前端和日志排查。

### 5.3 推荐结构

可以提取纯函数和恢复函数，例如：

```js
function calculateFinalizeRecoverySeconds(lastRunAt, intervalMinutes, nowMs) {}
async function recoverFinalizeFailure(key, state, lockToken) {}
```

名称可以不同，但职责必须清楚，且真实生产代码调用这些函数。

### 5.4 必须测试

- finalize 返回 false 后，完整 interval 到期前 `runUnifiedAutoCycle` 调用次数不增加。
- lock 不存在、cooldown 不存在时，成功写入剩余 cooldown。
- cooldown 补写使用 NX 语义，不覆盖已有 cooldown。
- 补写失败时只继续 recovery，不调用正常 tick。
- cooldown 已存在时按 TTL 等待。
- 其他 token 持锁时不删除锁、不写 cooldown、不推理。
- 无效 `lastRunAt` 使用完整 interval。
- stop scheduler 后 recovery timer 不再执行。
- scheduler 停止后，即使 Redis Promise 延迟返回，也不能复活 scheduler。

测试必须使用 fake timers 和可控 Redis mock 真正推进 callback，并在 `afterEach` 恢复 timers、停止 scheduler、清理模块状态。

## 6. 修复二：AI cancel_pending 的类型和价格筛选必须安全

### 6.1 当前缺陷

当前挂单价格执行 `parseFloat(po.price)` 后没有验证有限数。`NaN > max_price` 和 `NaN < min_price` 都是 false，因此非法价格可能反而通过条件并被撤销。

`pending_type` 仍使用大小写敏感的精确比较：

```js
po.pending_type !== cond.pending_type
```

### 6.2 必须实现

1. broker suffix 继续统一通过 `stripBrokerSuffix()` 比较。
2. `pending_type` 条件和 MT5 挂单类型都转换为标准小写后比较。
3. 当撤单条件包含 `max_price` 或 `min_price` 时：
   - 挂单价格必须 `Number.isFinite(price)` 且 `price > 0`；
   - 价格无效时跳过该挂单，不得撤单；
   - 写一条 info/warning 审计，说明因 `invalid_pending_price` 跳过。
4. 不涉及价格条件的 `cancel_all` 可不依赖价格，但仍需合法 ticket、品种匹配和锁检查。
5. ticket 必须为非空、可用于 MT5 的值；无效 ticket 跳过并审计。
6. 保持同一用户同一 ticket 去重。
7. 每笔实际 `cancel_pending` 前继续执行 lock ownership 与 trade/bridge 状态检查。

### 6.3 必须测试

- XAUUSD 匹配 XAUUSD.s、XAUUSD.c，不匹配 EURUSD。
- `BUY_LIMIT`、`Buy_Limit` 能匹配规范化后的 `buy_limit`。
- 有价格条件时，null、空字符串、NaN、Infinity、0、负数价格均不得撤单。
- 合法 max/min price 边界按现有业务语义命中或跳过。
- `cancel_all` 在价格缺失时仍可撤销合法挂单。
- 相同 ticket 命中多条条件时只调用一次 MT5。
- 第二个 ticket 前模拟锁丢失，第二个及后续 ticket 不调用 MT5。

测试必须调用生产筛选 helper 或真实 cancel_pending 流程，不能只测试 `normalizeCancelCondition()` 返回对象。

## 7. 修复三：挂单上限必须依据撤单后真实剩余数量

### 7.1 当前缺陷

`remainingPendingCount` 当前仅统计“同方向撤单失败次数”，没有统计：

- 同品种反方向挂单；
- 撤单后仍真实存在的挂单；
- MT5 返回撤单成功但订单尚未从列表消失的情况。

这会导致已有挂单达到上限时仍继续提交新挂单。

### 7.2 必须实现

1. 获取初始 `pending_list` 后，按 broker suffix 归一化统计同品种所有受限挂单，而不是只统计同方向撤单失败。
2. supersede 仍只撤销现有设计要求的“同品种同方向”挂单，不改变反方向挂单处理策略。
3. 所有撤单请求完成后，必须再次调用用户自己的 `pending_list`，确认同品种实际剩余挂单。
4. `remainingPendingCount` 必须来自第二次确认查询结果。
5. 第二次查询出现以下情况时必须失败关闭，不得提交新挂单：
   - 请求抛异常；
   - status 表示 error；
   - orders/pending_list 缺失或不是数组；
   - 无法可靠解析结果。
6. 如果桥接具有明确的“撤单成功但列表最终一致性延迟”语义，可以进行一次短暂、有限、可测试的确认重试；禁止无限重试。若最终仍能看到旧单，则按仍存在统计。
7. 在发送新挂单前，根据真实剩余数判断：

```text
remainingPendingCount + 1 <= MAX_PENDING_PER_SYMBOL
```

注意新订单本身也占一个名额。若上限为 2，当前已经剩余 2 个时不能再下；剩余 1 个时最多再下 1 个。
8. 统计应覆盖同品种所有方向；无效 symbol/ticket 的异常条目应保守处理并审计，不得静默把风险数量降为 0。
9. 两次 pending_list、每次撤单和最终下单前均应遵循 lockGuard。锁丢失后已 claim 的 delivery 更新为 `skipped`，写结构化原因，不发送后续 MT5 指令。
10. pending_list 失败、锁丢失、挂单上限命中时，除 `execution_status` 外，还要写 `execution_result`，至少包含机器可读的 `reason`、统计数量或错误摘要。

### 7.3 必须测试

- 初始有 2 个反方向同品种挂单，不撤销，禁止创建第三个。
- 初始 2 个同方向挂单，全部撤销且复查为空，允许创建新挂单。
- 一个撤销成功、一个失败，复查仍有 1 个，允许或拒绝必须符合 `remaining + 1 <= max`。
- MT5 返回 cancel success，但复查仍看到原 ticket，按仍存在处理。
- 复查 pending_list 抛异常、返回 error、返回错误结构时均不调用新 pending/open。
- 不同 broker suffix 的同基础品种计入同一上限。
- 不同基础品种不计入当前品种上限。
- 锁在撤单后、复查前或最终下单前丢失时，停止流程并正确落库。

## 8. 修复四：重写虚假的 scheduler 专项测试

### 8.1 必须删除或改写的空测试模式

以下测试不能保留为“已覆盖”的依据：

- 只验证 `typeof mod.reconcilePendingOrders === 'function'`。
- 只验证 `__schedulerTest` 中存在某个函数。
- 设置 `db.queryRun.mockResolvedValue({ changes: 1 })` 后，仅断言这个 mock 返回 1。
- 名称写着 quote/lock/delivery，但没有调用对应生产路径。

可以保留必要的导出存在性 smoke test，但不得计入安全功能覆盖，并且不能替代行为测试。

### 8.2 测试设计要求

1. 可将以下逻辑提取为真实生产代码使用的纯 helper，再通过 `__schedulerTest` 暴露：
   - lock guard 创建；
   - finalize 恢复等待时间计算；
   - cooldown 恢复写入；
   - cancel condition 与 pending order 匹配；
   - 同品种挂单统计；
   - quote/SL/TP 校验。
2. 纯 helper 测试之外，至少增加集成级 scheduler 单元测试，证明生产流程调用 helper 后是否调用 MT5、是否更新 delivery。
3. 每个 Promise 断言必须 `await` 或 `return`。当前以下警告必须清零：

```text
Promise returned by expect(...).resolves... was not awaited
```

4. 测试必须断言关键副作用：
   - `mt5Bridge` 的 action 和调用次数；
   - `executeOrderCore` 是否调用；
   - `queryRun` 写入的状态和 `execution_result.reason`；
   - `insertAudit` 的 reason；
   - timer 推进前后推理调用次数；
   - Redis SET/EVAL/GET/TTL 的参数和顺序。
5. 禁止用源代码字符串搜索代替行为测试。
6. 禁止通过宽泛 `if (mod.__schedulerTest) { ... }` 让导出缺失时测试仍通过。导出是测试前提时应直接断言并调用。
7. 测试之间必须隔离模块状态、timer、mock 和 scheduler state，不能依赖执行顺序。

## 9. 数据状态与审计要求

以下失败状态必须同时具有可机器读取的持久化原因：

- `finalize_failed`
- `lock_lost_before_send`
- `pending_list_unavailable`
- `pending_limit_reached`
- `invalid_pending_price`
- `invalid_pending_ticket`

对于 delivery 状态更新，不能只写：

```sql
SET execution_status = 'skipped'
```

应同时更新 `execution_result`，内容至少为 JSON：

```json
{
  "reason": "pending_limit_reached",
  "remaining_pending_count": 2,
  "max_pending_per_symbol": 2
}
```

具体字段可按现有表结构调整，但不得只依赖日志文本。

## 10. 验证命令

必须执行并在结果文件记录真实输出摘要：

```powershell
node --check server/routes/ai/scheduler.js
node --check server/routes/ai/config.js
node --check server/migrations.js
npm.cmd test
git diff --check
git status --short --branch
git diff --stat 19bd9c8..HEAD
git diff --name-status 19bd9c8..HEAD
rg -n "RELEASE_LUA|releaseLock" server/routes/ai/scheduler.js
```

额外要求：

- 全量测试必须通过。
- scheduler 专项测试不得产生未 await Promise 警告。
- 新增测试数不是验收核心，真实覆盖上述行为才是验收核心。
- 不得把现有无关测试故意产生的错误日志误报为本任务问题，但必须单独列出本任务测试是否有 warning/unhandled rejection。

## 11. 手工实测说明

结果文件必须给出用户可按步骤执行的手工验证，至少包括：

1. **finalize 恢复**：模拟 finalize Redis 错误，观察完整策略周期内没有第二次 cycle start，并检查 cooldown key 的 TTL。
2. **已有 cooldown**：恢复时预先存在 cooldown，确认不会覆盖 TTL，也不会提前推理。
3. **停止 scheduler**：进入 finalize recovery 后关闭最后一位订阅用户，确认 recovery callback 不会复活 scheduler。
4. **价格条件撤单**：让挂单返回非法 price，确认 AI 条件撤单不会发送 cancel_pending，并能看到审计原因。
5. **类型大小写**：MT5 返回 `BUY_LIMIT`，AI 返回 `buy_limit`，确认合法条件可以匹配。
6. **挂单上限**：用户已有两个同品种反方向挂单，生成新挂单信号，确认不发送第三个挂单。
7. **撤单后复查**：同方向旧单撤销后，确认系统第二次获取 pending_list，再决定是否下新单。
8. **复查失败**：第二次 pending_list 超时，确认 delivery 被拒绝/跳过且没有新单。
9. **锁丢失**：撤单完成后替换 Redis token，确认复查或下单阶段停止，delivery 离开 executing。

每一步都要说明：前置条件、操作、预期日志、预期数据库字段、预期 Redis key、预期 MT5 侧行为。

## 12. 结果文件要求

完成后创建：

```text
docs/agent-results/20260711-mimo-ai-inference-safety-final-followup-result.md
```

结果文件必须包含：

1. 分支名。
2. 修复前基线 `19bd9c8`。
3. 修复后的真实完整 commit hash，不得写“待提交”。
4. 是否已推送 `origin/dev_codex`。
5. 每项问题对应的修改文件、函数和最终行号。
6. finalize 恢复状态机及 cooldown 原子补写方式。
7. pending condition 价格、类型、ticket 的匹配规则。
8. 撤单前数量、撤单结果、复查后实际数量和新订单名额的计算规则。
9. 所有新增/改写测试的测试名称及其真实断言对象。
10. 全部验证命令与真实结果，包括测试总数和 warning 情况。
11. 用户手工实测步骤，按第 11 节逐项给出。
12. 未完成项、未验证项和残余风险。只要存在未完成项，不得声称“全部完成”。

## 13. 提交与推送

建议提交信息：

```text
fix: finish automatic inference scheduler safety recovery
```

只提交本任务相关生产代码和测试。结果文件如果受 `.gitignore` 影响，可保持未跟踪，但必须实际生成。

完成后执行：

```powershell
git push origin dev_codex
```

禁止提交 `.env`、令牌、`.mcp.json`、`test-mcp.js`、日志、构建产物或其他无关文件。

## 14. 完成标准

只有同时满足以下条件才能报告完成：

- finalize 失败恢复能够真实写入或确认 cooldown，完整间隔内不重复推理。
- recovery poll 与正常 tick 完全分离，停止 scheduler 后不会复活。
- AI cancel_pending 对类型大小写、价格有效性、ticket 和 broker suffix 的处理正确。
- 挂单上限依据撤单后第二次查询的实际同品种挂单数量，并把新订单计入上限。
- pending_list 任何失败都不会继续创建新挂单。
- 锁丢失后不继续撤单或下单，delivery 持久化机器原因。
- 所有专项测试真正执行生产路径或生产 helper，不再存在空验证测试。
- Promise 断言 warning 清零，全量测试通过。
- 修改已提交并推送到 `origin/dev_codex`，结果文件包含真实 commit 和详细实测说明。
