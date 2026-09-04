# 阶段 12I：API V4 与浏览器实时网关运行时接线验收记录

> 日期：2026-09-04  
> 范围：API V4 组合入口、浏览器实时 WSS 入口、单次票据、Redis 已提交事件消费、revision 恢复、PM2 角色  
> 边界：只完成源码和离线验证；未启动正式进程、未读取真实 `.env`、未执行迁移、未连接真实 MySQL/Redis/Bridge/MT，也未执行交易

## 1. 结果

阶段 12I 已把阶段 10～12H 的 HTTP 与浏览器实时模块接入两个独立运行角色：

- `aurum-v4-api` 只处理短 HTTP 请求，统一挂载 SSO、应用会话、Bridge V4 凭据、交易工作区、分析/交易员、账户风控和 operation 查询。
- `aurum-v4-browser-realtime` 只消费短时单次票据、维护浏览器订阅，并把 Redis 中已经提交的投影事件推送给已授权连接。
- `aurum-v4-bridge-gateway` 继续独立承担设备长连接；API 和浏览器实时进程均未引入 BullMQ Worker、业务轮询器或交易执行逻辑。
- 宝塔仍只需管理一个 `ecosystem.v4.config.cjs`，其中五个 fork 角色可以被 PM2 分别观察和重启。

## 2. API V4 入口

`server/src/entrypoints/api-v4.ts` 建立独立 Fastify、MySQL 小连接池和缓存 Redis 连接。`registerApiV4Routes` 将当前已经实现的 V4 模块集中注册，避免每个入口重复拼装：

```text
SSO / app session
  + Bridge credential exchange/session ticket
  + trading context/account/market projection
  + market analysis/account trader decision
  + deterministic account risk
  + operation status
```

交易业务路由只接受精确 `TRADE_ORIGIN` Host。其它应用子域访问同一路径返回 `421 trade_host_required`；应用 Host-only Cookie、写请求的精确 Origin 与 CSRF 校验继续由阶段 10 的认证适配器执行。Bridge 凭据端点位于相同 trade 控制域，但仍使用独立设备凭据，不复用浏览器会话。

API 只有 `/health/live` 与 `/health/ready` 健康检查，不消费队列、不启动后台计时器。`ready` 同时核验 MySQL 与缓存 Redis。

## 3. 浏览器实时入口

连接顺序为：

1. trade 应用先通过 HTTP 取得快照和各资源 revision。
2. `POST /api/v4/realtime/tickets` 设置仅限 `/realtime/v4` 的 HttpOnly Cookie。
3. WSS upgrade 必须同时满足精确路径、无 query、精确 Host、精确 Origin 和 `aurum.realtime.v4` 子协议。
4. 网关原子消费 Cookie 票据，再从 MySQL 复核活动 trade 会话、用户状态与 session version。
5. 网关发送 `system.welcome`；浏览器只可发送订阅、取消订阅和 ping，不存在通用命令入口。
6. `BrowserRealtimeHub` 在订阅前再次验证账户归属或管理员观摩频道，并比较 HTTP revision；不一致时只返回 `subscription.resync_required`。

安全与流控边界：

- 浏览器上行帧上限 16 KiB，下行事件上限 64 KiB，关闭 per-message deflate。
- 单连接串行处理队列上限 8 条，待发送字节超过 1 MiB 时按慢消费者关闭。
- 25 秒 WebSocket heartbeat；进程停机使用 `1012`，不把正在重启误报成业务失败。
- URL 查询参数中的票据被拒绝，票据不会进入日志、localStorage 或业务消息。

## 4. Redis 事件与恢复

Bridge 投影仍以 MySQL 事务提交为权威。提交后才向固定频道 `aurum:v4:browser-realtime:events` 发布小型事件；发布失败不回滚数据库事实。

浏览器实时进程使用独立 Redis subscriber 连接。进入 Hub 前严格校验事件类型与资源的固定映射、用户/账户/终端作用域、UTC 时间、revision 和 64 KiB 大小。无效事件被丢弃并记健康错误码，不能构造任意频道或绕过 Hub 授权。

Pub/Sub 不承担永久重放。浏览器遇到以下情况都会先重拉 HTTP 快照，再用新 revision 和新的一次性票据重连：

- `subscription.resync_required`
- 连接内 sequence 缺口
- 网络断开或网关重启

重连采用带抖动的 1、2、5、10、20、30 秒上限退避，不刷新整个应用，也不重复拉取历史 K 线数组作为实时消息。

## 5. 配置与进程

新增配置：

- `V4_API_PORT`，默认 `3010`
- `V4_BROWSER_REALTIME_PORT`，默认 `3011`
- `V4_SECURE_COOKIES`，默认 `true`；只允许本地纯 HTTP 开发显式关闭

浏览器实时角色只读取 `TRADE_ORIGIN`、Cookie 模式及基础设施连接，不读取 SSO 私钥、CSRF secret 或 BFF exchange secret。API 角色才装载完整认证配置，降低长期密钥暴露面。

## 6. 离线验证

- `pnpm exec vitest run server/tests/browser-realtime-runtime.test.ts server/tests/v4-runtime-wiring.test.ts server/tests/trading-realtime-vertical-slice.test.ts server/tests/auth-sso-service.test.ts`
  - 4 files / 29 tests passed
- `pnpm run typecheck:server`：通过
- `pnpm run typecheck:frontend`：通过
- `pnpm run build:server:v4`：通过
- `pnpm run test:frontend`：8 files / 23 tests passed
- `pnpm run build:frontend` 与前端边界检查：通过
- `pnpm test`：232 / 233 files、3517 / 3519 tests passed；仅 `tests/bridge-release-tool.test.js` 两项既有失败，原因仍是其子 PowerShell 进程找不到 `Get-FileHash`，与本阶段改动无关
- `pnpm peers check`：仅保留既有 `ws@7.5.13` 要求 `utf-8-validate@^5.0.2`、仓库安装 6.0.6 的 peer 提示
- `git diff --check`：通过
- `pnpm audit --audit-level moderate`：npm registry 连续网络错误后中止，未获得新的审计结论；不以旧审计快照冒充本阶段结果

覆盖的关键回归包括：票据只消费一次且复核活动会话、跨 Origin 和 query credential 拒绝、欢迎/订阅 ready、revision 不匹配要求精确重拉、取消订阅、ping/pong、Redis 事件白名单、trade Host 隔离、五个 PM2 单实例角色和全部已实现 V4 路由挂载。

## 7. 两轮复审

### 第一轮：安全与职责边界

发现浏览器实时进程若直接创建完整 `AuthService`，会被迫装载并不需要的 ES256 私钥和两个认证 secret。已拆出窄 `RealtimeTicketAuthenticator`：它只依赖票据 Redis、活动会话和用户状态，完整密钥仍只属于 API 进程。

同时确认 Bridge ticket、浏览器 realtime ticket 和应用 session 是三套不同凭据；浏览器 WSS 不接收交易指令，Bridge WSS 不接受浏览器 Cookie。

### 第二轮：断线与部署边界

发现 trade 前端原先在收到 `resync_required` 后只重拉快照但不重新订阅，且网络重连固定 1.5 秒，可能持续携带旧 revision。已改为关闭旧连接、重拉快照并重新签发票据，再按协议退避重连。

确认两个新角色都保留独立健康检查、连接池和优雅停机；没有将 API、浏览器实时和 Bridge 合并为一个故障域，也没有改变宝塔“一项 PM2 项目统一启停”的运维方式。

## 8. 剩余风险与后续门

- 本阶段没有真实启动五角色 ecosystem；端口、反向代理、HTTPS Cookie、真实 Host/Origin 与 Redis Pub/Sub 仍需旁路环境联调。
- 当前长连接在建立时复核会话，绝对过期和已退出会话的主动断开还需在阶段 15 的真实会话撤销联调中验证并补充跨进程撤销事件。
- Redis Pub/Sub 短暂中断会由 revision 缺口恢复，但尚未进行断网、慢客户端、万级连接、重启和长稳压力测试。
- 管理后台专属实时事件、AI job、risk alert、operation 等后续领域事件尚未全部接入当前 trading 投影事件目录；应按竖切逐类增加，不能使用任意频道。
- 所有数据库迁移仍未执行；本阶段未改变或清理任何旧表、旧数据或生产结构。

因此，本阶段可以认定为“API V4 与浏览器实时入口源码接线完成并通过离线合同验证”，不能据此宣称公网、真实 Redis/MySQL、真实浏览器长连接或生产迁移已经验收。
