# 阶段 12H：Bridge Gateway、Execution Worker 与 Outbox 运行时接线验收记录

> 日期：2026-09-03
> 范围：Bridge V4 WSS upgrade、execution/outbox 独立进程、BullMQ 唤醒、健康检查、优雅停机与宝塔 PM2 配置骨架
> 明确不包含：执行数据库迁移、启动 V4 进程、连接 MySQL/Redis/Bridge/MT4/MT5、交易、部署或公网切流

## 1. 完成的运行链

```text
风险通过并事务创建 execution_intent prepared
  -> 同事务写 execution.intent.prepared outbox
  -> 独立 outbox-dispatcher 幂等发布 BullMQ job
  -> 独立 execution worker 按账户 Redis lease 创建 durable queued command
  -> 同事务写 bridge.command.queued outbox
  -> outbox-dispatcher 幂等发布 Bridge dispatch job
  -> Bridge gateway 进程只在 command 仍为 queued 时执行：
       MySQL 标记 dispatched -> 写当前 epoch 的本进程 WebSocket
  -> 写入结果不明进入 uncertain；重复 job 不重发 command.request
```

MySQL 是 intent、command 和 outbox 的权威；BullMQ 只负责持久唤醒。关键交易载荷不进入队列，job 只携带 `intentId` 或 `commandId`。

## 2. Bridge WSS 边界

- 正式路径固定为 `/bridge/v4/ws`。
- 只接受 `Authorization: Bearer <一次性 session token>`；URL 中出现任何查询参数都在 upgrade 前拒绝，长期 refresh token 不进入 WebSocket。
- 首帧必须在 10 秒内是 `session.hello`，随后才消费一次性票据并进入 Stage 12G 的安装、档案、账户、终端和 epoch 校验。
- 禁止二进制帧，单帧上限 512 KiB，单连接最多积压 8 条待处理消息；超过即关闭，避免慢 MySQL 或恶意上行形成无界内存队列。
- 同一 socket 的消息严格串行处理。被替换连接仍由 Redis/MySQL fencing 阻止继续提交结果或投影。
- 停机先停止领取 Bridge dispatch job，再停止 upgrade，向连接发送 1012；一秒后仍未退出的 socket 才终止，之后关闭 Fastify、Redis 和 MySQL。
- 若进程恰好在 MySQL 已提交 `dispatched`、但 socket 写入结果尚未确定时退出，重复 queue job 不重发；下一个合法 epoch 会先把旧 `dispatched/accepted` 转为 `uncertain`，随后只发送 `command.reconcile` 查询终端事实。

## 3. 独立进程与宝塔管理

新增三个可独立构建和启动的角色：

| PM2 名称 | 职责 | 健康端口 |
| --- | --- | --- |
| `aurum-v4-bridge-gateway` | `/bridge/v4/ws`、当前 socket、命令最终投递和 Bridge 回执/投影 | 与网关端口共用，默认 3012 |
| `aurum-v4-outbox-dispatcher` | 领取受支持的 MySQL outbox 并幂等写入 BullMQ | 默认 3020 |
| `aurum-v4-worker-execution` | 将 prepared intent 转成 durable queued command | 默认 3021 |

`ecosystem.v4.config.cjs` 使用一个 PM2 ecosystem 项目承载三项独立 fork 进程，均为 `instances: 1`、`watch: false`，各自拥有内存预算和 15 秒停机门。宝塔仍只需登记一个 PM2 项目；本配置当前只是未启用骨架，后续 API、浏览器实时、分析、复盘等角色完成后继续追加。

数据库迁移仍是独立部署步骤，不放入任何 entrypoint。三个新入口还要求 `AURUM_V4_RUNTIME_ENABLED=true` 才能启动，防止尚未迁移时误启。

## 4. 队列与资源隔离

- BullMQ 固定为 `6.3.4`，队列 Redis 必须使用独立的 `QUEUE_REDIS_*` 配置；默认 DB 号区别只是开发防误用提示，正式环境仍要求独立 Redis 实例、`noeviction` 与 AOF。
- `msgpackr-extract` 是可选原生加速包，仓库明确拒绝运行其安装脚本，使用纯 JavaScript 路径，避免扩张供应链执行面。
- outbox 使用 `FOR UPDATE SKIP LOCKED` 小批领取、30 秒 lease、指数退避和第 12 次 dead-letter；发布成功后才把 MySQL outbox 标为 dispatched。
- queue job ID 使用 outbox `event_id`。进程在“队列已收、MySQL 尚未标记”之间崩溃时，重领只命中同一 BullMQ job，不产生第二项业务工作。
- MySQL 每角色使用小连接池、UTC 会话、有限等待队列；具体总池预算仍需在真实部署拓扑完成后确定。

## 5. 健康与停机

- 每个角色均提供 `/health/live` 与 `/health/ready`。
- live 只说明事件循环仍响应；ready 还要求角色已接受工作且必要 MySQL、缓存 Redis或队列 Redis可用。
- Worker 停机先停止领取新 job，再等待当前 job 完成；outbox 停止新一轮并等待当前批次；网关停止命令 job 后再关闭 socket。
- 未处理异常仍使当前角色退出，由 PM2 只重启该角色，不吞掉未知进程级错误。

## 6. 第一轮复审：隔离与不重放

第一轮发现并修正：

1. 直接让独立 execution worker 持有进程内 socket 不可行；改为 command queued outbox，最终 socket 写入只在 Bridge gateway 进程发生。
2. 把完整命令放进 BullMQ 会在消费者崩溃后产生真实交易重放风险；队列只携带 command ID，网关每次先重读 MySQL，只有 `queued` 可以进入 dispatch。
3. execution intent 原实现没有对应 outbox 唤醒；在 intent 插入事务内补 `execution.intent.prepared`，避免提交成功但 Worker 永远不知道。
4. command 创建和 gateway 唤醒必须原子；在 command 账本同一事务写 `bridge.command.queued` outbox。
5. 进程可能在持久化 `dispatched` 后、socket 写入前退出；重复 job 仍保持 no-op，而新 epoch 将旧 `dispatched/accepted` 降为 `uncertain` 并只做精确 reconcile。
6. 不引入微服务、工作流引擎、远程 DI 或第二个业务账本；仍是同仓库模块化单体的独立运行角色。

## 7. 第二轮复审：鉴权、背压、资源与误启

第二轮发现并修正：

1. Win7 Bridge 原型实际使用 Authorization bearer；服务端严格沿用，不为浏览器方便增加 URL token 兼容入口。
2. 只限制 WebSocket 单帧仍可能被连续消息堆积耗尽内存；增加每连接 8 条串行积压门和 hello 超时。
3. WebSocket 正常 close 可能无限等待异常客户端；增加先 1012、后有界 terminate 的停机路径。
4. queue Redis 与缓存 Redis不能共用淘汰语义；配置明确拆为 `QUEUE_REDIS_*` 与 `REDIS_*`，缺任一必要配置即启动失败。
5. 直接提供可启动 PM2 文件可能被误认为已经可切流；增加显式总开关，并在文件名、环境样例和本报告中标明当前只用于后续验收，不自动替换旧 `server/index.js`。

## 8. 验证结果

- Stage 12H 定向：7 files / 40 tests passed。
- 服务端 TypeScript 严格检查：passed。
- V4 服务端构建：passed。
- 前端应用边界、全量测试、全量 TypeScript 检查和四应用生产构建：passed。主站补充显式 `vite@8.2.2`，避免 Nuxt Vite 8 与根目录 Vitest Vite 6 的提升类型发生漂移。
- 根测试：231 files / 3509 tests passed；仅既有 `tests/bridge-release-tool.test.js` 2 项失败，原因是子 `powershell.exe` 环境缺少 `Get-FileHash`，与本阶段代码无关。
- 生产依赖审计：0 high、0 critical；4 个既有 moderate 分别来自 `uuid`、`sanitize-html` 和 `qs` 链路，新增 BullMQ 链路没有命中。`pnpm peers check` 仍报告既有 `ws@7.5.13` 对 `utf-8-validate@^5` 与仓库安装的 v6 不一致。
- `git diff --check`：passed。
- 未启动任何新增 entrypoint，未读取真实 `.env`，未连接 MySQL/Redis/Bridge/MT，未执行交易。

## 9. 剩余风险与下一阶段输入

- 当前仅接好 Bridge gateway、outbox dispatcher 和 execution worker；API V4、浏览器实时 gateway、正式 scheduler 及其它 Worker 尚未进入 ecosystem。
- Bridge credential Fastify routes 仍未挂入正式 API V4 composition root，因此客户端还不能完成真实 session-token 全链路。
- 浏览器实时事件当前只发布到 Redis channel；浏览器实时 gateway 尚未消费和恢复 revision。
- Stage 12G 首版仍只把 positions/pending_orders 完整快照解码为可信交易投影；账户、报价、当前 K 线等流需在对应市场数据竖切中接完。
- 没有在真实 MySQL/Redis 验证 `SKIP LOCKED`、outbox lease、BullMQ AOF 恢复、进程崩溃点和长稳，也没有运行 PM2/宝塔启停演练。
- Gateway 仍为单实例；在没有完成 socket 定向分片以前不得把该 app 改成多实例。
- `ecosystem.v4.config.cjs` 不能用于当前公网切换；必须等剩余运行角色、迁移演练和最终发布门完成。
