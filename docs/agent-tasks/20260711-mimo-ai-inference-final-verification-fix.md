# Mimo Code 第三轮任务：自动推理最终验收修复与专项测试

## 1. 任务背景

当前基线提交：

```text
bdfeb0c fix: complete automatic inference safety hardening (9 items)
```

Codex 复核后确认，该提交仍不能验收：存在 3 项 P0 和 5 项 P1/P2 问题。其中 `lockGuard` 使用箭头函数访问 `this`，会在首次所有权校验时直接抛出 TypeError，导致自动推理无法完成。

本任务是窄范围最终修复。必须先补专项测试复现问题，再修改生产代码。禁止只修改旧测试的 mock 调用次数，禁止在测试总数仍为 469 时声明完成。

## 2. 仓库与分支

- 仓库：`D:\dev_codex\wall-street-skill-local`
- 分支：`dev_codex`
- 修复基线：`bdfeb0c`
- 禁止修改或推送 `main`

开始前执行并记录：

```powershell
git status --short --branch
git log -5 --oneline --decorate
git diff --check
```

当前存在若干未跟踪的任务、结果和 MCP 调试文件。不得删除，也不得加入本次提交：

- `.mcp.json`
- `test-mcp.js`
- `docs/agent-tasks/20260711-*.md`
- `docs/agent-results/20260711-*.md`

结果文件除外；结果文件按第 15 节创建，但若目录被 gitignore，可保持未跟踪并在最终报告说明。

## 3. 修改范围

主要修改：

- `server/routes/ai/scheduler.js`
- `tests/ai/scheduler.test.js`
- 必要时新增 `tests/ai/scheduler-safety.test.js`

仅在确实需要测试导出或纯函数时少量修改：

- `server/routes/ai/config.js`
- `server/migrations.js`

## 4. 明确不处理

- 不处理 migration 035。
- 不处理智能平仓。
- 不处理缠论、行情指标、thinking mode、提示词和前端样式。
- 不改变观摩模式。
- 不改变手动执行不走后端风控的设计。
- 不重写整个 scheduler，不做无关清理。

## 5. 修复一：Lock Guard 的箭头函数 `this` 致命错误

### 当前错误

`server/routes/ai/scheduler.js` 中：

```js
const lockGuard = {
  lost: false,
  isOwned: async () => {
    if (this.lost) return false
  },
  assertOwned: async () => {
    if (this.lost || !(await this.isOwned())) return false
  }
}
```

箭头函数没有自己的 `this`。ESM 严格模式下会报：

```text
TypeError: Cannot read properties of undefined (reading 'lost')
```

### 必须实现

1. 禁止在 lockGuard 箭头函数中使用 `this`。
2. 推荐实现为闭包引用：

```js
const lockGuard = {
  key,
  token,
  lost: false,
  renewTimer: null,
}

lockGuard.isOwned = async () => {
  if (lockGuard.lost) return false
  // Redis token check
}

lockGuard.assertOwned = async phase => {
  if (lockGuard.lost || !(await lockGuard.isOwned())) {
    lockGuard.lost = true
    return false
  }
  return true
}
```

也可以使用普通方法，但必须通过自动化测试真实调用 `assertOwned()`，不能只做静态字符串测试。
3. Redis GET 失败、Redis 不存在、token 不一致时必须返回 false 并设置 lost。
4. 删除或修复任何依赖不存在变量的锁辅助函数。

### 专项测试

- token 相同时 `assertOwned()` 返回 true，不抛异常。
- token 不同时返回 false，并将 `lost=true`。
- Redis GET 抛异常时返回 false。
- 再次调用已 lost 的 guard 不访问 Redis。

## 6. 修复二：锁所有权必须传递到每个撤单和 delivery

### 当前问题

- 只在整个 `cancel_pending` 阶段开始前检查一次锁。
- 只在整个自动交易阶段开始前检查一次锁。
- `executeDelivery()` 没有 `lockGuard` 参数。
- 锁可能在批量用户执行过程中丢失，后续用户仍会继续撤单或下单。

### 必须实现

1. 将 `lockGuard` 传入 `executeDelivery()`：

```text
runUnifiedAutoCycle -> executeDelivery(..., lockGuard)
```

2. 在以下位置调用 `await lockGuard.assertOwned(phase)`：
   - 每个撤单用户开始处理前。
   - 每一笔 `cancel_pending` 真正发送前。
   - 每个 delivery 认领前。
   - delivery 完成权限、quote、positions、pending_list 检查后，在真正发送 `open/pending` 前最后检查一次。
3. 锁丢失时：
   - 尚未认领的 delivery 不认领。
   - 已认领但尚未发送 MT5 的 delivery 更新为 `skipped`，`execution_result` 写机器原因 `lock_lost_before_send`。
   - 不调用 `open`、`pending`、`cancel_pending`。
   - 写审计。
4. Promise 并发批次中，各 delivery 必须独立执行最后锁检查；不能依赖批次开始前一次检查。
5. 如果 MT5 指令已经发送后锁才丢失，禁止自动重试；按实际返回更新 success/failed/uncertain。

### 专项测试

- 第一个用户执行后模拟 token 改变，第二个用户不得调用 MT5。
- 撤单 ticket 列表执行到第二笔时锁丢失，第二笔及之后不撤。
- delivery 认领后、下单前锁丢失，delivery 离开 executing 并变 skipped，不调用 open/pending。

## 7. 修复三：finalize 失败后禁止 30 秒盲目重跑

### 当前问题

当前 finalize 失败后仍执行：

```js
setTimeout(tick, 30000)
```

如果交易已经完成但 Redis 响应失败，30 秒后可能重复推理和交易。

### 必须实现

1. finalize 成功时保持现有原子 Lua：token 匹配后设置 cooldown 并删除 lock。
2. finalize 返回 false 或抛错时：
   - scheduler 进入 `finalize_failed` 暂停状态。
   - 不安排普通 tick 重跑。
   - 启动独立的恢复检查，恢复检查不得执行推理。
3. 恢复检查流程：
   - 等 Redis 可用。
   - 检查 lock key 当前 token/TTL。
   - 检查 cooldown key。
   - 若 cooldown 已存在，等待其 TTL。
   - 若 cooldown 不存在，根据本轮 `lastRunAt` 和 interval 计算剩余等待时间，并补写剩余 cooldown；不得立即推理。
   - 如果无法确认本轮是否完成，使用完整 interval 作为保守等待时间。
4. 恢复成功后才重新安排正常 tick。
5. `stopUnifiedScheduler()` 必须同时清理正常 timer、续租 timer 和 finalize 恢复 timer。
6. 删除不再使用的 `releaseLock()`；当前函数引用已删除的 `RELEASE_LUA`，不得保留潜在 ReferenceError。

### 专项测试

- finalize false 后 30 秒内、完整 interval 前不会调用推理。
- Redis 恢复且已有 cooldown 时按 TTL 等待。
- cooldown 不存在时补写剩余 interval。
- stop scheduler 清理 recovery timer。
- 代码中不存在对未定义 `RELEASE_LUA` 的引用。

## 8. 修复四：AI cancel_pending 的 broker suffix 匹配

### 当前问题

supersede 已使用 `stripBrokerSuffix()`，但 AI `cancel_pending` 仍然精确比较字符串，所以 XAUUSD 条件匹配不到 XAUUSD.s。

### 必须实现

1. AI cancel_pending 实际挂单过滤改为：

```js
stripBrokerSuffix(po.symbol) === stripBrokerSuffix(cond.symbol)
```

2. `pending_type` 双方统一转小写。
3. price 必须是有限数字；条件涉及价格而挂单价格无效时不得撤单。
4. 保持 ticket 去重。
5. 每一笔撤单前执行第 6 节的锁所有权检查和交易权限检查。

### 专项测试

- XAUUSD 匹配 XAUUSD.s、XAUUSD.c。
- XAUUSD 不匹配 EURUSD。
- pending_type 大小写不影响匹配。
- 同 ticket 命中多个条件只调用一次 cancel_pending。

## 9. 修复五：自动 SL/TP 和用户 quote 必须严格失败关闭

### 当前问题

- quote 获取失败时回退管理员 `market.latest_price`。
- SL null 时不拒绝。
- entryRef 小于等于 0 时跳过整个校验。
- quote 缺 ask/bid 时也回退管理员价格。

### 必须实现

1. 市价自动订单必须从用户桥接获取新鲜 quote：
   - buy 使用 ask。
   - sell 使用 bid。
2. quote 请求失败、`status !== 'success'`（若桥接成功结构无 status，则按项目真实成功契约判断）、ask/bid 缺失、非有限数或小于等于 0：立即拒绝，原因 `user_quote_unavailable`。
3. 禁止回退管理员 `market.latest_price`。
4. 自动订单必须同时满足：
   - entryRef 有限且 > 0。
   - SL 有限且 > 0，禁止 null。
   - 用户所选 TP 有限且 > 0，禁止 null。
   - buy：SL < entryRef < TP。
   - sell：TP < entryRef < SL。
5. 挂单 entryRef 使用实际挂单价格；stop_limit 需要按照项目桥接参数语义确认触发价和 stoplimit price，不能混用。
6. 最终向 MT5 发送前再次执行锁校验。

### 专项测试

- quote error、空对象、ask/bid null、NaN、0 全部拒绝。
- SL null 和 TP null 全部拒绝。
- buy/sell 正确与错误方向全部覆盖。
- 管理员行情价格有效但用户 quote 失败时仍拒绝。

## 10. 修复六：pending_list 所有异常分支必须 return

### 当前问题

错误响应和错误结构已经失败关闭，但 `catch (listErr)` 只记录日志，之后继续提交新挂单。

### 必须实现

1. 将 pending list 获取和结构校验封装成一个失败关闭流程。
2. 返回 error、undefined、错误结构或抛异常时统一：
   - delivery -> rejected/skipped。
   - `execution_result.reason = 'pending_list_unavailable'`。
   - 写审计。
   - 立即 return。
3. 不允许 catch 后落入 `executeOrder()`。
4. `remainingPendingCount` 必须表示撤单后确认仍存在的同品种受限挂单数量，而不是仅统计撤单失败次数。
5. 无法重新查询确认撤单后状态时，保守地把未确认撤销的订单计为仍存在。

### 专项测试

- pending_list 抛异常时不调用 pending/open。
- 撤单成功、失败混合时正确计算 remaining count。
- remaining count 达上限时拒绝新挂单。

## 11. 修复七：stale executing 更新必须防止覆盖成功状态

### 当前问题

对账器先 SELECT stale executing，再按 id 无条件 UPDATE uncertain。查询和更新之间若正常执行完成，会把 success 覆盖成 uncertain。

### 必须实现

1. UPDATE 必须带状态条件和时间条件：

```sql
UPDATE auto_signal_deliveries
SET execution_status='uncertain', execution_result=?
WHERE id=?
  AND execution_status='executing'
  AND execution_claimed_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
```

阈值参数化或使用固定安全常量均可，但不要拼接用户输入。
2. 只有 `queryRun(...).changes === 1` 时才写 stale 审计和日志。
3. `changes === 0` 表示状态已被其他流程更新，静默跳过，不得覆盖。
4. stale 查询或更新失败不能影响普通 pending 对账，但必须记录错误。

### 专项测试

- changes=1 时更新 uncertain 并审计。
- changes=0 时不审计、不覆盖。
- 模拟 SELECT 后状态变 success，最终保持 success。

## 12. 修复八：删除失效的 releaseLock 死代码

`RELEASE_LUA` 已删除，但 `releaseLock()` 仍引用它。当前虽无调用，未来复用会抛 ReferenceError。

必须删除 `releaseLock()`，或定义并测试其真实用途。由于当前统一使用 `finalizeLock()`，推荐直接删除，并用 `rg` 验证不存在：

```powershell
rg -n "RELEASE_LUA|releaseLock" server/routes/ai/scheduler.js
```

预期无匹配。

## 13. 强制测试规则

这是完成门槛，不是建议：

1. 必须新增真正的新测试用例，测试总数必须大于 469。
2. `tests/ai/scheduler.test.js` 当前 13 个测试；完成后必须明显增加，或新增独立 `scheduler-safety.test.js`。
3. 必须覆盖第 5 至第 11 节列出的关键专项测试。
4. 禁止只调整 `mockResolvedValueOnce()` 次数后声称新增测试。
5. Redis/bridge/DB 均可通过现有 Vitest mock 完成，不接受“mock 成本高”作为跳过理由。
6. 可将以下逻辑提取成可测试 helper：
   - lock guard 创建。
   - cancel condition 匹配。
   - SL/TP/quote 自动执行校验。
   - finalize 恢复等待计算。
   - stale executing 条件更新。
7. 测试专用导出使用统一 `__schedulerTest` 对象，不能暴露为 WebSocket/API 功能。
8. fake timers 测试后必须恢复并清理 timer。

## 14. 验证命令

必须执行并记录真实结果：

```powershell
node --check server/routes/ai/scheduler.js
node --check server/routes/ai/config.js
node --check server/migrations.js
npm.cmd test
git diff --check
git status --short --branch
git diff --stat bdfeb0c..HEAD
git diff --name-status bdfeb0c..HEAD
rg -n "RELEASE_LUA|releaseLock" server/routes/ai/scheduler.js
```

`npm.cmd test` 的测试总数必须大于 469。若仍为 469，本任务自动判定未完成。

如果环境允许：

```powershell
npm.cmd run dev
```

观察至少 30 秒，确认没有 TypeError、ReferenceError、migration error、unhandled rejection、重复推理日志或 timer 泄漏。

## 15. 结果文件

必须创建：

`docs/agent-results/20260711-mimo-ai-inference-final-verification-fix-result.md`

必须包含：

1. 分支名。
2. 修复前 commit `bdfeb0c`。
3. 修复后真实 commit hash，禁止“待提交”。
4. 是否推送 `origin/dev_codex`。
5. 8 项问题逐项列出修改文件、函数和行为。
6. lock guard 正确实现代码片段，说明为何不存在箭头函数 this 问题。
7. 每个不可逆交易动作前的锁校验位置。
8. finalize 失败恢复状态机及 timer 清理方式。
9. quote/SL/TP 失败关闭规则。
10. 新增测试文件、测试名称、新增数量及最终总数。
11. 全部验证命令和真实结果。
12. 未完成或未验证项；存在未完成项时禁止声称全部完成。

## 16. 手工实测说明

结果文件必须给出：

1. 正常 Redis token 下跑一轮，确认无 TypeError，信号、delivery 和自动执行正常。
2. LLM 返回前替换 Redis token，确认不保存 delivery、不交易。
3. 第一位用户执行后替换 token，确认后续用户不交易。
4. finalize 模拟失败，确认完整 interval 内不重复推理。
5. XAUUSD 条件撤销 XAUUSD.s 挂单。
6. 用户 quote 失败、SL 缺失、TP 缺失分别确认 MT5 无订单。
7. pending_list 抛异常确认无新挂单。
8. stale executing 与正常 success 竞争时确认 success 不被覆盖。

## 17. 提交与推送

建议提交信息：

```text
fix: close automatic inference safety gaps
```

完成后：

```powershell
git push origin dev_codex
```

禁止提交 `.env`、`.mcp.json`、`test-mcp.js`、日志、构建产物或任何凭据。

## 18. 完成标准

同时满足以下全部条件才算完成：

- lockGuard 真实调用不抛 TypeError。
- 每位用户、每笔撤单、每笔自动订单发送前都校验 Redis token。
- finalize 失败不会在 30 秒后盲目推理。
- AI cancel_pending 支持 broker suffix。
- 用户 quote、SL、所选 TP 任一无效都失败关闭。
- pending_list 所有失败分支都立即 return。
- stale executing 不会覆盖 success。
- 不存在 `RELEASE_LUA/releaseLock` 死代码。
- 新增专项测试，测试总数大于 469，且全量测试通过。
- 提交并推送到 `origin/dev_codex`。
- 结果文件包含真实 commit 和验证结果。
