# 阶段 12T：Bridge 历史采集、权威投影与迁移演练验收记录

> 日期：2026-09-04
> 状态：源码实现与离线验证完成；数据库迁移、旧数据回填、真实依赖、Bridge/MT 实机联调均未执行

## 1. 本阶段结果

本阶段把 Stage 12S 的权威交易记录从“有结构、有读 API、无生产者”推进为可由 V4 运行时驱动的采集链路：

```text
独立历史 scheduler
  → MySQL outbox: trade.history.requested
  → BullMQ: 只携 accountId
  → Bridge Gateway 当前 route/epoch
  → query.request: history.orders / history.trades / history.deals
  → 500 条以内稳定游标页
  → MySQL 终端事实与账户交易记录
  → history_revision + trade.history.changed
  → 浏览器按需重拉 HTTP 快照
```

MT5 按“历史订单 + 历史成交”采集，只有入场与出场成交量完全闭合、品种和方向一致、时间及价格证据完整的 position episode 才生成已平仓账户交易记录。MT4 按终端已经封口的历史 trade 采集。balance、credit、charge、correction 等资金流水保留为终端事实，但不会进入交易盈亏记录。

## 2. 进程与异步边界

- 新增独立 `aurum-v4-scheduler-trade-history` PM2 角色。它只寻找最近仍在线且到期的账户，在短事务中更新同步状态并写 outbox，不访问终端、不处理历史正文。
- Outbox dispatcher 将 `trade.history.requested` 映射为 BullMQ job，job 只含 `accountId`。Redis 不保存历史列表、订单、成交或原始证据。
- Bridge Gateway 已经持有真实 WebSocket sink，因此只在该进程消费历史查询 job。查询 Worker 与交易命令 Worker 独立，历史采集不会进入 `command.request`，也不会改变命令账本的重放规则。
- 每条 WebSocket 同时最多一个历史查询在途。响应必须同时匹配 request ID、message correlation、resource、terminal instance、broker server、login 和 connection epoch。
- Socket 断开会取消该连接全部待处理查询；本地截止时间之后迟到的只读响应被忽略，不会因为正常竞态拆掉新的健康连接。

## 3. 采集窗口、分页与恢复

- 首次同步从 `2000-01-01T00:00:00Z` 开始；该边界早于受支持的 MT4/MT5 产品历史，避免用“最近若干年”静默截断老账户数据。
- 增量同步从上次 `fresh_through` 向前重叠 24 小时，允许终端对最近成交补齐费用或状态；同 ticket 不同证据会 fail closed，当前实现不会静默覆盖。
- 单页最大 500 条，单资源最多 2,000 页；`has_more` 与 `next_cursor` 必须一致，重复游标立即终止。
- Scheduler 只选择活动 Bridge 会话：ready 每 60 秒可再次登记，failed 至少 30 秒后重试，异常遗留 syncing 至少 5 分钟后才允许重新登记。
- 网络查询不持有 MySQL 事务。每一页解码后才按“同步状态 → ticket 排序事实 → stable trade key → deal mapping”的固定次序短事务提交。

## 4. 权威事实投影

终端原始对象先做规范化和 canonical SHA-256，再落 `terminal_history_orders_v4` / `terminal_history_deals_v4`。账户交易记录使用稳定键：

- MT5：`mt5:position:{position_id}`；
- MT4：`mt4:ticket:{ticket}`。

价格、手数和费用使用八位定点十进制运算；净盈亏明确等于毛盈亏 + 佣金 + swap + fee。终端业务日由 UTC 成交时间和会话已校准时区偏移计算。缺少时区、票号、品种、方向、手数、价格或完整闭合证据时不生成用户交易记录。

本阶段不根据 magic、comment 或时间邻近猜测来源。新采集记录先保持 `source=unknown / attribution=unresolved`；只有后续将终端 ticket 与 execution outcome、distribution target 或 Bridge result 做精确对账，才允许升级为 system/manual/other_ea/mixed。

## 5. 浏览器实时失效

采集完整结束后，同一事务：

1. 将同步状态更新为 `ready`；
2. 递增 `history_revision`；
3. 更新按终端业务日汇总；
4. 写 `trade.history.changed` outbox。

失败状态只在状态首次转为 failed 时写轻量失效事件，避免每次轮询重复轰炸浏览器。实时帧仍只包含 status、history revision 和 fresh-through，不携带交易列表或原始证据。

## 6. 旧数据迁移演练

新增只读命令：

```powershell
pnpm run rehearse:trade-history docs/examples/trade-history-migration-rehearsal.example.json
```

输入按旧表和用户/账户分区提供 source/migrated/reconciled 行数，以及毛盈亏、佣金、swap、fee、净盈亏五项汇总。演练器使用八位定点比较，任一计数或金额差异都会返回 fail 和精确差额，退出码为 1；输入错误退出码为 2。工具不读取 `.env`、不连接数据库、不执行 DDL/DML，也不删除旧表。

真正迁移仍必须从冻结源快照按 checkpoint 分批执行，并在全部用户/账户对账通过、双读验收和回滚窗口结束后另行取得删除旧表授权。

本阶段没有新增或改写 SQL 迁移，运行时代码复用 Stage 12S 已登记但尚未执行的 `20260904_013_authoritative_trade_history.sql`。

## 7. 第一轮复审：架构与职责

复审重点：后台任务隔离、Bridge 最小职责、Redis 载荷、交易安全和过度设计。

发现并调整：

- 初稿曾考虑在 Gateway 建立定时器直接启动采集，这违反“网关不负责登记后台任务”的既定边界；最终改为独立 scheduler → MySQL outbox → BullMQ → Gateway 查询消费者。
- 没有新增通用 RPC、微服务或历史正文队列。Gateway 只增加协议已有的查询关联器，Bridge 继续只提供数据。
- 历史队列只携账户 ID，避免大 JSON 进入 Redis；分页正文从当前 socket 直接进入服务端短事务。
- 历史采集从未调用 command transport，离线测试明确断言发送的是 `query.request` 而不是 `command.request`。
- 真实 MT5 当前为用户正在使用的账户，本阶段没有启动服务、连接终端或发送任何交易指令。

第一轮结论：职责保持在既定模块化单体和独立 PM2 角色内，没有把策略、风控、交易规则或报表逻辑下沉到 Bridge。

## 8. 第二轮复审：正确性、并发与异常

复审重点：分页竞态、断线、迟到响应、时间、重复事实、财务精度、数据库锁顺序和旧数据保护。

发现并调整：

- 首次窗口原拟使用固定“最近十年”，可能漏掉更老账户；改为 2000 年固定起点。
- 超时后的只读响应可能在网络中迟到；由“未知 response 关闭 socket”改为安全忽略，只有已存在 pending 但 route/correlation 不一致才视为协议错误。
- Gateway 内查询限制为同连接一个在途，防止大历史页争抢连接；命令消费仍在独立 BullMQ Worker 中。
- 资金类 deal 不生成交易；MT5 反转型 `inout`、成交量不闭合或证据冲突保持未投影，避免伪造完整已平仓记录。
- Canonical evidence hash 遇到同账户同 ticket 不同正文会标记 `trade_history_fact_conflict`，不静默覆盖；同步状态转 failed 并通知页面回读。
- 收口复审发现 BullMQ 映射误把数字型交易账户主键套用到“至少 8 位”的通用资源 ID 校验；已改为 MySQL `BIGINT UNSIGNED` 范围内的正整数专用校验，并用短账号 ID `42` 和上界溢出值增加回归覆盖。
- 同一终端页内若出现相同 ticket、不同 canonical evidence，也会在写库前 fail closed，避免 `INSERT IGNORE` 掩盖页内冲突。
- 迁移演练把净盈亏和四个组成项分别比较，避免“总额碰巧相同”掩盖佣金或 swap 映射错误。

第二轮结论：离线链路具备 fail-closed 的路由、游标、事实、财务和迁移边界；任何不确定性都不会触发交易或冒充已对账记录。

## 9. 验证结果

- 服务端 typecheck 通过；V4 server build 通过。
- 历史采集、Stage 12S 交易记录、Gateway、Outbox、浏览器领域事件、V4 运行时与迁移演练定向测试：7 个文件、31 项测试通过。
- 服务端完整回归连同迁移演练：36 个文件、226 项测试通过。
- `.NET Framework 4.8` Bridge 离线冒烟全部通过，覆盖严格 query 合同、历史投影、分页游标、SQLite、断线恢复与命令隔离；没有连接真实终端。
- 示例迁移演练返回 pass，五项金额差额均为 0。
- `git diff --check` 通过。
- 根级完整测试共 247 个文件、3,603 项测试，其中 246 个文件、3,601 项通过；仅既有 `tests/bridge-release-tool.test.js` 的 2 项失败，原因仍是子进程 `powershell.exe` 环境无法识别 `Get-FileHash`，与本阶段历史采集代码无关。

以上均为离线源码证据，不等同于真实 MySQL/Redis/BullMQ、Bridge、MT4/MT5 或公网运行证明。

## 10. 未执行与剩余风险

- 未执行 `20260904_013_authoritative_trade_history.sql`，未读取或改写 `dev_vue` 数据库，未启动 PM2/服务，未连接 Bridge、MT4 或 MT5。
- 未执行旧 `bridge_v3_deals`、`signal_outcomes`、`signal_outcome_deals` 的回填；示例演练数据不是实际源库对账结果。
- 当前同 ticket 不同证据会 fail closed。经纪商合法补记/修订需要后续设计“保留旧版本 + 明确当前版本”的事实修订账本，不能直接覆盖原证据。
- MT5 `inout` 反转成交、复杂 partial close、close-by、费用单独记账和 MT4 经纪商字段差异仍需真实只读样本验证；未验证前保持不投影或 unknown。
- 系统/manual/other EA 精确归因尚未接通终端 ticket 与 execution/distribution/outcome 账本；页面会诚实显示 unknown，不把 Bridge command success 当成交证明。
- 首次全历史覆盖可能耗时较长；仍需真实账户分页、中断续传、百万级索引计划、队列长稳和 Gateway 命令延迟压测。

## 11. 结论

Stage 12T 已完成历史采集链路的源码接线和离线闭环：独立调度、ID-only 队列、精确 Bridge 只读查询、短事务权威投影、revision/outbox 失效，以及不会碰数据库的旧数据对账演练。它没有执行迁移、回填、实机连接或交易，也不宣称真实运行环境已经可用。
