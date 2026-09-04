# 阶段 12S：权威交易记录与终端证据链验收记录

> 日期：2026-09-04  
> 状态：源码实现与离线验证完成；迁移、旧数据回填、Bridge 历史采集、真实依赖和实机联调未执行

## 1. 本阶段结果

本阶段为 AI 交易实验室建立了独立的交易记录模块。页面只展示服务端已经由 MT4/MT5 终端历史事实封口的已平仓交易，不把“模型建议成功”“风控通过”“Bridge 接收命令”或“命令返回成功”冒充为终端成交。

本阶段覆盖：

- 当前用户所拥有交易账户的历史列表、冻结游标分页和详情；
- 账户、终端业务日、品种、方向、来源、盈亏结果、订单号和持仓号筛选；
- 交易数、胜率、净盈亏、盈利因子和累计净盈亏图；
- 毛盈亏、佣金、库存费、手续费和净盈亏的独立精确金额；
- MT4/MT5 订单、成交、position episode 与系统决策/执行链路的分层存储；
- 系统策略、用户手动、其他 EA、混合来源、未知来源的显式归因；
- 从交易详情跳转到行情分析、交易员决策、确定性风控、执行、Bridge 证据和复盘 case。

## 2. 权威事实与归因边界

一笔交易的证据顺序为：终端历史订单/成交事实 → 账户级交易记录 → 精确来源关联。分析、交易员、风控、执行意图、Bridge 命令和执行 outcome 只是可追踪的上游证据，只有与终端 ticket、order、deal 或分发目标完成精确对账后，才成为交易归因。

来源判定规则：

- `system`：有系统执行账本和终端事实的精确关联；
- `manual`：终端明确证明由桌面、移动端或 Web 客户端人工发起，且没有系统执行关联；
- `other_ea`：终端明确证明为 Expert/EA，且无法与本系统执行账本匹配；
- `mixed`：同一交易生命周期的开仓、修改或平仓由两个及以上已证明来源共同完成；
- `unknown`：只有 magic、自由文本 comment、模糊时间邻近或证据缺失，不能可靠证明来源。

归因函数只提升明确证据。magic 和 comment 可以作为服务端证据保留，但不会单独把记录标为系统单或手动单。现金出入金、credit、balance correction 等不会进入交易盈亏记录。

## 3. 数据库与迁移

新增迁移 `20260904_013_authoritative_trade_history.sql`，只旁路新增 V4 结构，不修改、清空或删除旧表：

- `trade_history_sync_states_v4`：账户级采集状态、新鲜度和 history revision；
- `terminal_history_orders_v4`、`terminal_history_deals_v4`：不可替代的终端订单和成交事实，原始证据仅保存在服务端；
- `account_trade_records_v4`、`account_trade_record_deals_v4`：面向用户和复盘的账户级已结算记录；
- `account_trade_attributions_v4`：分析、交易员、风控、执行、Bridge 和复盘的精确引用；
- `account_trade_daily_summaries_v4`：后续采集器可维护的按终端业务日汇总；
- `trade_history_migration_checkpoints_v4`：旧数据有界回填、对账和恢复检查点。

金额、价格和手数使用 `DECIMAL`；终端 UTC 时间与冻结时区偏移同时保留，业务日由终端校准时区生成。写入约定固定锁顺序：账户同步状态 → 按 ticket 排序的终端事实 → 按稳定键排序的交易记录 → 按日期排序的汇总 → outbox。超时或死锁只允许在幂等事务边界内做有界重试。

旧库迁移必须按账户分批读取，保存 legacy table/id，逐用户核对订单数、成交数、毛盈亏、佣金、swap、fee、净盈亏和来源分类。完成双读对账和用户验收前，旧表不能删除。本阶段只写迁移文件，没有执行迁移或回填。

## 4. HTTP 与 WebSocket

新增 HTTP V4：

- `GET /api/v4/trade-history`
- `GET /api/v4/trade-history/{trade_record_id}`

列表查询先验证当前用户对账户的 owner 权限；详情查询同时以用户 ID 和记录 ID 收窄。分页 cursor 绑定账户、筛选哈希和首次读取的 `captured_end`，切换账户或筛选后不能复用旧 cursor。日期范围使用包含首尾的终端业务日，不在浏览器中转换 UTC 日界线。

浏览器实时协议新增 `trade.history.changed` 和 `trades/history` 订阅目标。事件只携带状态、history revision 和 `fresh_through`，用于让当前页面重新拉取 HTTP 快照；交易列表、统计、成交明细和证据正文不进入 WebSocket。

## 5. 前端工作区

`/trades` 已从占位页替换为独立懒加载功能模块，结构按普通外汇交易者的使用顺序组织：

1. 账户与筛选；
2. 净盈亏、胜率、交易笔数、盈利因子；
3. 按终端业务日累计净盈亏图；
4. 桌面表格与移动端记录列表；
5. 右侧交易详情 Sheet，展示参数、费用、终端成交拆分和决策执行链。

界面统一复用项目 shadcn-vue Card、Field、Input、Select、Button、Badge、Table、Sheet、ScrollArea、Alert、Skeleton 和 Empty 组件。盈亏使用语义颜色；加载、空态、错误、历史滞后和离线快照状态独立；移动端整行可点击，桌面表格支持 Enter/Space 打开详情。累计曲线同时提供屏幕阅读器表格。

## 6. 第一轮复审：业务与数据正确性

复审重点：成交定义、来源归因、费用、MT4/MT5 差异、时区和旧数据保护。

发现并调整：

- 初稿日期筛选曾把浏览器选择的日期转换为 UTC 零点，可能跨终端业务日；现改为服务端直接过滤 `close_business_date`。
- 初稿允许 `partial` 记录进入结算列表，后续成交可能改变同一行；现列表只读已经封口的 `closed` 记录，部分成交仍保留在终端 facts 中，待完整 position episode 封口。
- 初稿来源只有字段枚举，没有独立判定规则；现增加纯归因函数及回归测试，人工平仓系统单会形成 `mixed`，模糊证据保持 `unknown`。
- MT5 deal、order、position 与 MT4 历史 trade 不能直接同表等价；迁移结构将终端原始事实与账户级交易记录分离，再通过 mapping 表组合。
- 交易盈亏不再把 commission、swap 和 fee 隐藏在一个数字中；详情逐项显示，净盈亏仍作为最终统计口径。

第一轮结论：交易记录不会把上游任务状态当成终端成交，也不会用时区猜测、magic 或 comment 猜测来源。

## 7. 第二轮复审：并发、查询、安全与体验

复审重点：跨账户访问、分页漂移、查询成本、实时载荷、路由状态和移动可用性。

发现并调整：

- 账户切换最初只刷新内存，没有立即写回 URL；现同步 `account_id`，刷新和分享页面时不会回到另一账户。
- 初稿累计图只查询最近 366 个业务日，却会被误解为完整筛选范围；现按同一筛选条件返回全部业务日汇总，不静默截断。
- 业务日筛选缺少组合索引；迁移补充用户、账户、业务日、平仓时间和 ID 的索引。
- 交易详情引用曾预先 URL encode，再交给 Vue Router，存在双重编码风险；现使用 route location 对象和 query 参数。
- 移动端记录最初使用原生 button；现改为 shadcn-vue Button，统一焦点、禁用和触控语义。
- WebSocket 只做 revision 失效通知，并用 350ms 合并连续事件；请求代次和详情代次会丢弃迟到响应，避免账户切换后旧数据覆盖新页面。

第二轮结论：离线读模型具备明确的账户隔离、稳定 keyset、可索引筛选和响应式阅读路径；没有增加写交易、自动下单或终端控制能力。

## 8. 未执行与剩余风险

- 本阶段未运行迁移，未连接 `dev_vue` MySQL、Redis、Bridge、MT4 或 MT5，未启动服务，也未发出任何交易指令。
- Bridge `.NET Framework 4.8` 原型已经具备 `history.orders`、`history.trades`、`history.deals` 的本地查询与 SQLite 覆盖能力，但服务端 history collector、查询调度、事实入库和 revision/outbox 发布尚未接线；当前真实运行环境因此不会自动填充这些新表。
- 旧 `bridge_v3_deals`、`signal_outcomes`、`signal_outcome_deals` 等数据尚未执行逐账户回填和财务对账；迁移 checkpoint 只是结构准备。
- 当前 cursor 冻结首次请求时间和过滤范围，但封口后若发现经纪商补记费用，记录 revision 仍可能上升；采集器接线时必须采用不可变事实和可审计修订，不能静默覆盖已用于复盘的证据版本。
- OpenAPI 运行时 Zod 合同和 SQL 结构已离线验证；真实 MySQL 查询计划、百万级历史压力、断线恢复、MT4/MT5 对账和浏览器多宽度视觉验收留待后续竖切与集成阶段。

## 9. 离线验证结果

- 服务端交易历史、风控、执行与实时边界定向回归：4 个文件、42 项测试通过；交易历史自身 7 项通过。
- 前端合同：27 项通过；API Client：14 项通过；AI 交易实验室：15 个文件、57 项通过。
- 服务端、合同、API Client 和 AI 交易实验室 typecheck 通过。
- 静态 OpenAPI 与 realtime JSON 可解析；新增交易页面未命中禁用渐变、backdrop-filter 或衬线字体规则；`git diff --check` 通过。
- 服务端 V4 build、全部前端 typecheck/build、前端应用边界与全部前端测试通过；交易记录懒加载产物 33.46 KiB，gzip 11.00 KiB。
- 全仓测试 245 个文件、3594 项：244 个文件、3592 项通过；仅 Bridge release tooling 的 2 项环境用例因当前 `powershell.exe` 缺少 `Get-FileHash` 失败，与本阶段交易历史代码无关。
- 最终提交与推送结果由 Git 记录，不在提交前预写不可验证的 commit ID。

## 10. 结论

Stage 12S 已建立权威交易记录的规范化数据库边界、只读 API、轻量实时失效协议和 shadcn-vue 用户工作区。它完成的是可审计的离线竖切，不宣称 Bridge 历史采集、旧数据迁移或生产运行已经完成。
