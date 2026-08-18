# 挂单成交后持仓票号实时绑定信号修复方案

## 1. 方案状态与范围

- 方案性质：公网只读诊断后的正式修复方案；本文件不修改业务代码、数据库、订单或公网服务。
- 本地仓库：`D:\dev_codex\wall-street-skill-local`，当前基线提交 `632b835836d353cb7dcfedcf19e20b07e4b07bf4`。
- 公网运行目录：`/www1/wwwroot/aurum-ai`，分支 `main`，运行提交同为 `632b835836d353cb7dcfedcf19e20b07e4b07bf4`。
- 目标问题：挂单成交并转为持仓后，持仓列表立即出现新票号，但票号暂时不能点击进入对应信号；F5 后关联恢复。
- 本次仅修复实时展示与事件衔接，不改变信号归属、订单执行、风控、挂单成交、持仓管理或历史归档合同。
- 工作区中以下用户已有改动与本方案无关，实施时必须保留且不得混入本次提交：
  - `scripts/push_period_reviews_to_lark.py`
  - `tests/scripts/test_push_period_reviews_to_lark.py`

## 2. 公网已确认事实

- 新持仓票号：`737970444`。
- MT5 当前持仓中确实存在该票号。
- 公网 `signal_tickets` 当前已将该票号映射到信号 `24456`。
- 信号 `24456` 为 `buy_limit`，后台 `pending_ticket`、`trade_ticket` 和 delivery 归属最终均已正确。
- 因此本问题不是永久丢失关联，也不是 F5 才触发数据库绑定；F5 只是重新读取已经完成的后台映射。
- 后台 Pending Reconciler 每 30 秒对挂单终态进行一次归因。挂单成交后，它会更新 delivery 的 `pending_state='filled'`、`is_executed=1` 和 `trade_ticket`，然后发送 `pending_filled` 浏览器事件。
- 前端发现持仓结构变化时会立即刷新票号映射，并按 1 秒、2 秒、5 秒进行三次补偿重试，总覆盖约 8 秒。
- 前端处理了 `signal_execution_updated`，但没有处理 `pending_filled`。
- 当挂单刚好在一次后台对账之后成交时，后台归因可能接近 30 秒后才完成；前端约 8 秒的补偿已经结束。后台随后发出的 `pending_filled` 又被前端忽略，因此页面一直保留无链接票号，直到 F5。

## 3. 根因与最早断点

正确链路应为：

```text
MT5 挂单成交
→ positions 实时快照出现新持仓
→ 前端先显示持仓票号
→ Pending Reconciler 确认成交并写入 trade_ticket / outcome.position_id
→ 服务端发出可消费的“票号归属已更新”事件
→ 前端强制刷新 signal_tickets
→ 重新渲染持仓票号为信号链接
```

当前最早断点是：

```text
Pending Reconciler 已完成关联并发送 pending_filled
→ 前端 WebSocket 分派没有 pending_filled 分支
→ signal_tickets 不再刷新
```

本质上是“后台最终一致性最长约 30 秒”与“前端补偿窗口约 8 秒”之间存在空档，同时最终一致性完成事件没有接入前端。

## 4. 修复目标

1. 新持仓可以先于后台归因显示，但后台关联完成后必须自动变成可点击信号票号，无需 F5。
2. 不依赖延长固定轮询覆盖 30 秒；以后台最终一致性事件作为权威完成通知。
3. 重复、乱序或同时到达的 `positions`、`pending_filled`、`signal_execution_updated` 事件不得产生并发请求风暴或旧响应覆盖新映射。
4. 账户切换、观摩源切换、退出登录后，旧账户事件不得污染当前票号映射。
5. 后台尚未完成关联时，票号保持普通文本；不得猜测信号 ID，也不得将其他同品种订单错误绑定。
6. 修复不得改变订单、delivery、outcome、风险或 Bridge 执行状态。

## 5. 代码修复设计

### 5.1 统一服务端成交归属事件

修改 `server/routes/ai/scheduler.js` 中 Pending Reconciler 的成交分支：

1. 保留现有 `pending_filled` 事件，避免破坏已有潜在消费者。
2. 在 delivery、outcome 和审计记录提交成功后，额外发送标准 `signal_execution_updated` 事件。
3. 事件只携带安全且必要的字段：
   - `signal_id`
   - `status:'success'`
   - `reconciled:true`
   - `pending_state:'filled'`
   - `trade_ticket`
4. 事件必须在数据库写入完成后发送，禁止出现“前端先刷新、后台尚未提交”的反向时序。
5. 若数据库事务失败，不得发送成功事件。

采用现有 `signal_execution_updated` 作为统一事件，是为了复用前端现有的信号详情、信号列表和票号映射刷新路径；`pending_filled` 继续作为领域事件兼容保留。

### 5.2 前端显式接收 `pending_filled`

修改 `public/ai/app.js` WebSocket 消息分派：

1. 增加 `pending_filled` 分支，作为兼容和兜底路径。
2. 校验 `signal_id` 与 `ticket` 为非空安全标识后，调用现有：

```js
scheduleSignalTicketRefresh({ immediate:true, resetRetry:true })
```

3. 不直接把事件中的 `ticket → signal_id` 写入 `state.signalTickets`。最终映射仍从服务端 `signal_tickets` 权威接口读取，防止跨账户、观摩源或乱序事件造成错误绑定。
4. 若当前持仓表正在显示该票号，映射刷新完成后沿用现有 `renderPositionTables(state.positions)` 重绘逻辑。
5. 事件触发的刷新继续使用现有 flight 合并、generation 校验和串行 drain，确保 `pending_filled` 与 `signal_execution_updated` 同时到达时最多形成一条串行刷新链。

### 5.3 保留有界补偿，不扩大轮询

- 保留当前 1/2/5 秒重试，覆盖“positions 已出现、后台马上完成归因”的快速路径。
- 不把重试简单延长到 30 秒以上。长轮询只是在掩盖最终完成事件缺失，并会持续增加 WebSocket 查询。
- 最终一致性由服务端事件驱动；补偿重试只负责处理事件前的短暂竞态。

### 5.4 账户与观摩源隔离

- 所有事件触发的映射请求继续携带当前 `accountContextGeneration`、`ticketMapContextGeneration` 和 `ticketMapGeneration`。
- 旧 generation 的响应必须被丢弃，不能覆盖新账户映射。
- 退出登录、账户切换、Bridge 重连时继续清理 debounce、retry、flight 和 waiter 状态。
- 管理员自身账户与订阅用户/观摩源映射仍按现有 `dataUserId` 和 observer strategy scope 查询，不扩大数据可见范围。

## 6. 测试方案

### 6.1 前端核心回归

扩展 `tests/ai/frontend-demand-loading.test.js`：

1. 持仓先出现，第一次 `signal_tickets` 尚无映射，票号显示普通文本。
2. 1/2/5 秒重试全部结束后，仍然没有映射。
3. 模拟 20–30 秒后收到 `pending_filled`。
4. 验证前端立即发起强制映射刷新，并将票号渲染为指向正确信号的链接。
5. 同时发送 `pending_filled` 与 `signal_execution_updated`，验证请求被合并/串行化，不产生并发风暴。
6. 后到的旧 generation 响应不得覆盖新账户映射。
7. 服务端暂时仍未返回映射时保持普通文本，不生成虚假链接。

### 6.2 服务端事件测试

扩展 Pending Reconciler 对应测试：

1. 挂单仍存在时不发送成交事件。
2. 挂单消失且匹配到真实持仓时，先更新 delivery/outcome，再发送 `pending_filled` 和标准 `signal_execution_updated`。
3. `signal_execution_updated` 必须包含正确 `signal_id` 和 `trade_ticket`。
4. 数据库写入失败时不得发送成功事件。
5. 非 delivery 的旧信号路径保持现有行为，不误写共享根信号的用户票号。

### 6.3 静态资源和兼容测试

- 更新 `public/ai/index.html` 的 `app.js` 缓存构建键，确保部署后浏览器获得新事件处理代码。
- 更新 `tests/frontend-static-cache-version.test.js` 和必要的前端治理断言。
- 运行：

```text
node --check public/ai/app.js
npx vitest run tests/ai/frontend-demand-loading.test.js tests/ai/scheduler.test.js tests/frontend-static-cache-version.test.js
git diff --check
```

根据实际改动再运行所有 scheduler、order intent、signal outcome 和前端治理相关测试。

## 7. 公网发布与验收

发布是独立授权边界。代码完成后，在用户明确要求提交、推送和部署时执行：

1. 只提交本方案所列代码、测试、缓存键和方案文件，不包含飞书脚本改动。
2. 推送指定分支并确认远端提交一致。
3. 公网通过受控部署流程更新并重启。
4. 验证公网分支、提交、干净工作树、`/health`、静态缓存键和启动日志。
5. 使用真实或低风险测试挂单观察：
   - 新持仓出现后允许短暂显示普通票号；
   - 后台 Pending Reconciler 确认成交后，无需 F5 自动变为信号链接；
   - 点击链接打开正确的信号，而不是同品种的其他信号；
   - 浏览器控制台无错误，WebSocket 请求没有持续循环。
6. 若没有安全的真实成交窗口，只能声明代码和集成测试通过，不能声称公网真实成交链路已验证。

## 8. 不采用的方案

- **把前端轮询延长到 30–60 秒**：增加无效请求，仍受调度延迟和网络波动影响，不能替代完成事件。
- **收到 `pending_filled` 后直接本地写入映射**：事件可能跨账户、跨观摩源或乱序，存在错绑风险。
- **根据品种、方向、手数和时间猜信号**：多个同向同品种挂单可能同时存在，不具备唯一性。
- **让 F5 成为正式恢复方式**：无法满足实时持仓管理需求。
- **缩短 Pending Reconciler 到数秒**：会增加 Bridge 和数据库压力，且没有修复事件消费断点。

## 9. 实施顺序

1. 增加服务端标准成交归属事件及事务后发送约束。
2. 增加前端 `pending_filled` 兼容处理，并复用现有串行映射刷新器。
3. 增加延迟超过 8 秒、双事件、乱序和账户切换回归测试。
4. 更新前端缓存键与静态资源治理测试。
5. 执行定向与相关回归测试，复审完整差异。
6. 获得单独授权后再提交、推送、部署和进行公网验收。

## 10. 两轮方案复审

### 第一轮：业务与数据安全复审

- 确认后台当前最终绑定正确，修复对象是实时 UI 一致性，不做历史数据修复。
- 确认不从事件载荷直接建立归属，而是重新读取服务端权威映射，避免错绑。
- 确认只在 delivery/outcome 更新成功后发送完成事件。
- 确认不改变挂单成交、下单、风控、平仓或订阅分发逻辑。

第一轮调整：放弃“直接使用事件 ticket 与 signal_id 更新本地 map”，改为事件只负责失效缓存和触发权威重读。

### 第二轮：并发、兼容与发布复审

- 确认保留 `pending_filled`，同时补发标准 `signal_execution_updated`，避免破坏潜在旧消费者。
- 确认双事件复用已有 flight 合并和 generation 防护，不新增平行刷新状态机。
- 确认保留 1/2/5 秒快速补偿，但不依赖扩大轮询窗口。
- 确认缓存构建键必须更新，否则部署后旧浏览器可能继续运行缺少事件处理的脚本。

第二轮调整：将前端 `pending_filled` 处理作为兼容兜底保留，即使标准事件因旧服务版本或中间版本缺失，页面仍能自动恢复。

## 11. 完成标准

- 挂单成交后的持仓票号在后台归因完成后自动变成正确的信号链接，无需 F5。
- 映射缺失期间不猜测、不误绑、不显示错误链接。
- `pending_filled` 与 `signal_execution_updated` 同时到达不会造成并发请求风暴。
- 账户/观摩源切换时旧响应不能污染当前映射。
- 定向测试、相关回归、语法检查和 `git diff --check` 全部通过。
- 公网真实行为只有在部署后完成实际成交观察才能标记为已验证。
