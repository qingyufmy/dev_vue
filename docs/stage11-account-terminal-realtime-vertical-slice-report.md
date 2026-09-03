# 阶段 11：账户、终端与实时行情竖切验收记录

> 状态：实现与离线验证已完成；真实基础设施、MT4/MT5 与浏览器联调验收延期
>
> 日期：2026-09-03
>
> 范围：账户归属、当前在线连接额度、终端档案、观摩上下文、Bridge 状态、账户快照、报价、K 线与成交量、持仓、挂单、浏览器实时恢复

## 1. 本阶段结果

- 新增独立 `trading` 业务模块，按 domain、application、infrastructure、transport 分层；账户归属在所有账户级 HTTP 读取和浏览器实时订阅之前统一校验。
- 用户交易上下文支持普通账户与独立观摩模式，使用 revision 乐观并发控制。普通账户可以随时切换；观摩源必须来自当前用户获授权且仍有效的观摩通道。
- 默认在线连接额度为 1，已购额度按有效 grant 求和；额度只统计当前在线的不同交易账户。相同账户的新连接替换旧 connection epoch，不额外占用额度。
- Redis lease 使用 45 秒 TTL 与原子 Lua 脚本完成过期清理、计数、同账户接管和容量校验。数据库只保存权益与连接审计，不把短时在线状态当作长期账户槽位。
- Bridge 投影统一承载 MT4/MT5 中立的账户指标、报价、K 线、持仓与挂单数据。投影数据和对应 revision 在同一 MySQL 事务中提交，提交成功后才发布浏览器事件；重复或过期 revision 不会覆盖新数据。
- 浏览器先并行读取 HTTP 一致快照，再订阅精确增量。每个订阅请求只允许一个交易账户，确认与重同步响应回显原始 `request_id`，并按用户、账户、资源和 revision 隔离消息。
- 浏览器检测 sequence 跳号或服务端 revision 不一致时，只执行精确 HTTP 重同步；重连和刷新期间保留最后一份有效快照，不再通过清空页面制造闪烁。
- AI 交易实验室首页使用唯一 shadcn-vue 组件源完成账户摘要、账户选择、实时报价、品种与周期切换、K 线与成交量、持仓和挂单列表。空值止盈止损显示 `--`，无账户、加载和错误状态均为明确组件状态。
- K 线使用 Lightweight Charts；HTTP 历史快照才调用 `setData`，秒级当前柱与成交量更新使用 `update`，避免每次报价都重建整张图。
- 最新 AI 信号卡明确标注为阶段 12 接入，不使用假信号、假价格或占位业务结论冒充真实数据。

## 2. 实际数据链路

```text
Bridge V4 精确查询/投影
  -> BridgeStreamProjector
  -> MySQL 投影数据 + revision（同一事务）
  -> BrowserRealtimeHub（用户 + 账户 + 资源过滤）
  -> /realtime/v4 增量
  -> trade 首页局部更新

浏览器首次加载/断线恢复
  -> /api/v4 HTTP 一致快照
  -> 保存各资源 revision
  -> subscription.subscribe(after_revision)
  -> ready 或 resync_required
```

HTTP 继续负责一致快照与用户写命令，WebSocket 只负责 Bridge 状态、账户指标、报价、当前 K 线/成交量、持仓与挂单的实时增量，符合“实时数据走 WebSocket，其它数据走 HTTP”的冻结原则。

## 3. 合同与模块边界

OpenAPI V4 已补充以下合同：

- 读取、选择交易账户、进入/退出观摩上下文；
- 交易账户、在线连接额度、终端档案和观摩通道列表；
- 单账户工作区快照、实时报价和有界 K 线历史；
- 账户、终端、快照、报价、K 线、持仓和挂单的 snake_case DTO。

浏览器实时协议继续使用阶段 4 的 `subscription.subscribe`、`subscription.ready`、`subscription.resync_required` 和统一事件包络，没有新增浏览器 WebSocket RPC。应用源码不直接创建 WebSocket；连接实现集中在共享 `@aurum/realtime` 包。

核心实现位于：

- `server/src/modules/trading/`
- `server/db/migrations/20260903_003_trading_context_and_market_projection.sql`
- `server/tests/trading-realtime-vertical-slice.test.ts`
- `frontend/apps/trade/src/features/home/`
- `frontend/packages/contracts/`
- `frontend/packages/api-client/`
- `frontend/packages/realtime/`
- `contracts/openapi-v4.json`

## 4. 数据库结构与迁移边界

新增迁移文件只面向空的 V4 旁路目标库，包含交易账户与归属、终端档案与绑定、在线容量权益与连接审计、观摩通道与授权、用户交易上下文、账户运行快照、报价、K 线、持仓/挂单快照和投影 revision。

结构采用 UTC `DATETIME(3)`、明确唯一键/外键和尾部查询索引。持仓与挂单使用账户级完整覆盖投影；覆盖和 revision 在同一短事务内完成，并按 ticket 排序写入，降低不稳定锁顺序风险。

迁移文件保留旧库到 V4 的 legacy ID map、checkpoint、每批最多 500 行和逐账户核对要求，但本阶段没有执行 DDL、DML、回填、修数或删除。公网旧库仍是迁移源，不能直接在原库套用此结构。

## 5. 第一轮实施复审

复审维度：需求覆盖、模块边界、最少代码、账户与终端语义、是否设计过度。

发现与调整：

- 连接额度没有实现为固定账户槽位，而是“当前在线不同账户数”；用户删除、更换或重新连接交易账户不会消耗永久名额。
- 没有在 Bridge 复制账户权限、观摩授权、容量权益或前端业务逻辑；Bridge 仍只提供数据和执行结果，限制集中在服务端。
- 账户切换不增加业务限制，只要求当前用户拥有该账户；同账户新连接使用 latest-wins connection epoch，避免重复计算额度。
- 观摩上下文写入前不仅由 service 检查，MySQL 保存事务内再次检查账户归属或观摩授权，关闭授权撤销与上下文保存之间的竞态窗口。
- 终端档案查询只选最近的活动连接，避免历史连接审计产生重复档案行。
- 前端不提前实现分析师、交易员、风控师等整页功能；首页只接入本阶段已具备真实合同的数据。

第一轮结论：账户、终端、额度和观摩边界完整，未把 Bridge 扩张为业务客户端，也没有为了“通用化”引入额外服务或事件总线。

## 6. 第二轮实施复审

复审维度：并发、一致性、重连恢复、跨账户隔离、响应式 UI 和连带 Bug。

发现与调整：

- 原投影实现存在“revision 先提交、数据后写入”的中断窗口，已改为投影数据与 revision 同一事务原子提交，成功提交后才发布事件。
- 投影入口新增 account/resource/data 三方身份一致性校验，拒绝把另一个账户的快照、报价、K 线、持仓或挂单写入当前账户 revision。
- 浏览器订阅从共享最大 revision 改为账户指标、报价、K 线、持仓和挂单各自 revision；一个资源缺口不会错误推进其它资源。
- `subscription.ready` 和 `resync_required` 改为回显真实请求 ID 与公共资源名；同一请求跨多个账户会被协议层拒绝。
- WebSocket 票据获取失败不再清空 HTTP 快照；账户、品种或周期切换使用 connection generation 隔离旧连接回调。
- sequence 跳号、断线和服务端 revision 不一致均进入恢复态并重新读取快照，不猜测丢失数据，也不回放未知增量。
- 共享边界检查确认 trade 应用内没有直接 `new WebSocket` 或散落原生 `fetch`，UI 没有新增原生 select/table 替代 shadcn-vue 组件。

第二轮结论：离线代码证据已覆盖原子投影、单账户订阅、精确恢复和前端稳定更新；真实 MySQL/Redis/Bridge/浏览器证据仍需后续联调补齐。

## 7. 验收证据

- 阶段 11 服务端定向测试：1 个文件、10 项全部通过，覆盖账户归属、观摩源只读授权、HTTP DTO、额度 latest-wins、原子投影调用语义、重复 revision、跨账户投影拒绝、断线 revision 恢复、公共订阅映射和迁移约束。
- 根测试：216 个测试文件、3407 项全部通过。
- 前端测试：21 项全部通过；trade 首页为 2 个文件、6 项测试。
- 服务端 TypeScript 类型检查通过；全部前端工作区类型检查通过。
- 前端边界检查通过；www、auth、trade、admin 四应用生产构建通过。
- 目标源码禁用样式、原生表单/表格、应用内直接 WebSocket/fetch 扫描无命中；`git diff --check` 通过。
- trade 首页构建为独立懒加载块，`HomeView` gzip 约 74.48 KiB，其中主要体积来自完整 Lightweight Charts；当前仓库尚未为阶段 11 冻结单页预算阈值。

```powershell
pnpm exec vitest run server/tests/trading-realtime-vertical-slice.test.ts --reporter=dot
pnpm run typecheck:server
pnpm run test:frontend
pnpm run verify:frontend-boundaries
pnpm run typecheck:frontend
pnpm run build:frontend
pnpm test -- --reporter=dot
git diff --check
```

全量测试在 Windows PowerShell 子进程可见标准模块路径后运行；此前仅有的 `Get-FileHash` 找不到问题属于测试子进程 `PSModulePath` 环境，而不是 Bridge 发布逻辑失败。修正测试环境后相关 24 项与全量 3407 项均通过。

## 8. 未执行与剩余风险

- 未执行数据库迁移或连接真实目标 MySQL/Redis，因此索引执行计划、真实锁等待、Lua 多进程竞争和旁路数据映射仍未验证。
- 新 trading 模块尚未接入最终 Fastify HTTP 进程、浏览器实时网关和 Bridge V4 公网网关；当前 HTTP 证据来自 Fastify 进程内注入，实时证据来自内存 sink。
- 未启动或修改真实 Bridge，未连接 MT4/MT5，未验证真实账户切换、终端断线、秒级报价、当前柱/成交量、持仓与挂单投影。
- 未进行桌面、平板和手机浏览器视觉验收；由于目标迁移和网关未接线，本阶段没有用假接口数据启动页面冒充真实联调。
- 未执行下单、挂单、改单、撤单或平仓；交易执行继续遵守阶段 6 状态机和单独授权边界。
- 首页最新 AI 信号、AI 分析师、交易员、风控师、策略师、复盘师、交易记录、系统审计、市场行情与设置属于阶段 12。
- 未提交、推送、部署、重启或发布 Bridge 更新。

真实 MT4/MT5、Win7、长连接、断网恢复、浏览器多终端与基础设施性能验收并入阶段 16；这不构成这些能力已经通过真实验收的声明。
