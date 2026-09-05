# 全量重构主路线图

> 状态：执行顺序已冻结，等待逐阶段确认
>
> 建立日期：2026-09-02
>
> 适用范围：www 主站、trade AI 交易实验室、admin 管理后台、backend、database、量见智桥

## 1. 文档定位

本文是本轮从零重构的唯一执行顺序。它负责回答“下一步做什么、完成到什么程度才能进入下一步”，不替代各阶段的详细设计。

以下文档继续作为强制输入：

- [全量重构需求基线](./refactor-requirements-baseline.md)
- [Vue 前端重构需求规范](./vue-frontend-requirements-standard.md)
- [单点登录与统一认证架构方案](./single-sign-on-authentication-architecture.md)
- [AI 交易实验室前端功能盘点](./ai-trading-lab-frontend-function-inventory.md)
- [管理后台现有功能盘点与目标能力建议](./admin-function-inventory.md)
- [全项目功能迁移总矩阵](./full-project-function-migration-matrix.md)
- [API V4、浏览器实时协议 V4 与 Bridge 设备协议 V4](./api-v4-and-realtime-protocol.md)
- [后端目标架构与异步任务隔离方案](./backend-target-architecture.md)
- [数据库规范化与全量数据迁移方案](./database-normalization-and-data-migration-plan.md)
- [数据库逐表迁移矩阵](./database-table-migration-matrix.md)

旧 UI 稿、旧前端实现方案和未标记为本轮权威基线的历史文档只可作为功能证据，不得覆盖本路线图。

## 2. 逐阶段确认规则

每个阶段开始前，主 Agent 必须先向用户介绍：

1. 本阶段为什么现在做。
2. 范围与明确不做的内容。
3. 将检查、设计或修改哪些模块。
4. 交付物和验收条件。
5. 可能影响的数据、接口、用户或客户端。

介绍完成后必须停下并等待用户明确确认，未确认不得开始该阶段。上一个阶段的确认不能自动延续到下一个阶段。

即使用户已确认某个阶段，下列动作仍需在执行前再次取得针对该动作的明确授权：

- 数据库 DDL、DML、回填、修数或删除。
- 删除旧代码、旧表、旧接口、旧安装包或用户数据。
- 真实 MT4/MT5 下单、挂单、改单、撤单或平仓。
- 提交、推送、部署、重启、发布 Bridge 更新或切换生产流量。

用户在任意阶段补充新要求时，先更新需求基线、迁移矩阵和本路线图，再判断是否影响当前阶段或后续顺序。

## 3. 冻结执行顺序

| 阶段 | 名称 | 核心交付物 | 进入下一阶段的条件 | 当前状态 |
| --- | --- | --- | --- | --- |
| 0 | 重构基线与数据库只读审计 | 总需求、Vue 规范、SSO 方案、AI 实验室盘点、数据库总方案 | 文档存在且两轮复审完成 | 已完成 |
| 1 | 主站现有功能盘点 | 页面、入口、API、权限、数据源、支付、内容、社区、会员、异常状态清单 | 功能迁移项无未解释入口 | 已完成 |
| 2 | 管理后台现有功能盘点 | 用户、会员、策略、模型、内容、订单、通知、Bridge、审计、TDK、域名和运营配置清单 | 管理能力和权限入口完整 | 已完成 |
| 3 | 全项目功能迁移总矩阵 | www、trade、admin、backend、database、Bridge 的功能去向、权限、合同和验收用例 | 每项现有能力都有保留、合并、重塑或候选删除结论 | 已完成 |
| 4 | API V4 与实时协议 V4 | OpenAPI、实时消息合同、统一错误、分页、幂等、版本、订阅、恢复和带宽规则 | 前端、后端和 Bridge 可共同生成或推导类型 | 已完成 |
| 5 | 后端目标架构 | 业务域、route/service/repository 边界、RBAC、后台任务、缓存、日志、指标和错误治理 | 禁止跨域直连和路由散落 SQL 的规则可测试 | 已完成 |
| 6 | 交易执行统一状态机 | 信号、风控、订单意图、分发、Bridge、MT 回执、成交、撤单、平仓、对账和审计状态图 | 每个状态转换有幂等键、权限、失败恢复和审计证据 | 已完成 |
| 7 | 数据库逐表迁移设计 | 165 张表逐表映射、时间语义规则、索引计划、迁移工具、对账和回滚设计 | 165/165 覆盖、两轮复审和静态验证通过；DDL 阻塞项明确 | 已完成 |
| 8 | Bridge V4 原型与技术冻结 | Win7 双原型结果、MT4/MT5 适配、精确查询、命令账本、时区校准、配对和更新方案 | Win7/10/11 原型及升级回滚实测通过 | 进行中 |
| 9 | 清理旧前端并建立三前端工程与设计系统骨架 | 删除 `dev_vue` 旧手写前端；建立 Nuxt www、Vite trade/admin、唯一 shadcn-vue 源、合同包、令牌、图标、图表库和 CI 边界 | 旧前端源码归零且三应用独立测试、构建，跨应用依赖检查通过；旧版只从参考仓库读取 | 已完成 |
| 10 | SSO 端到端竖切 | auth 中心、三应用独立会话、PKCE、CSRF、WebSocket 单次票据和退出范围 | trade 登录、HTTP、WebSocket 和注销真实链路通过 | 已完成（实现与离线验证） |
| 11 | 账户、终端与实时行情竖切 | 账户归属、单终端约束、观摩模式、Bridge 状态、报价、K线、持仓和挂单 | 真实 MT4 与 MT5 数据、断线和切换账户验收通过 | 已完成（实现与离线验证；实机门延期） |
| 12 | AI 交易实验室全模块迁移 | 首页、分析师、交易员、风控师、策略师、复盘师、交易记录、审计、市场行情和设置 | AI 实验室迁移矩阵全部关闭，多终端验收通过 | 进行中（12S 权威交易记录读模型与工作区已完成离线实现） |
| 13 | 主站全模块迁移 | 企业展示、课程、内容、社区、会员、支付、账户入口和公开页面 | 主站迁移矩阵全部关闭，SEO、性能和支付验收通过 | 未开始 |
| 14 | 管理后台全模块迁移 | 用户、会员、内容、策略、模型、商业、通知、Bridge、审计和系统配置 | 后台迁移矩阵全部关闭，权限矩阵验收通过 | 未开始 |
| 15 | 全量数据迁移演练 | `dev_vue` 到旁路目标库的重复迁移、逐表/逐用户对账、恢复和回滚演练 | 零未解释差异，备份恢复和回滚可重复 | 未开始 |
| 16 | 全系统非功能验收 | 安全、并发、死锁恢复、查询性能、带宽、长时运行、浏览器、Win7、MT4/MT5 和故障演练 | 所有质量门通过且剩余风险被用户接受 | 未开始 |
| 17 | 切换与剩余旧实现清理 | 发布顺序、灰度、监控、回滚窗口、旧 API/表/客户端候选清单，以及阶段 9 后遗留前端资产复核 | 用户逐项确认后才执行切换或删除；已发布迁移文件永久保留 | 未开始 |

## 4. 阶段通用完成门

每个阶段至少满足以下条件才能标记完成：

- 交付物写入仓库并链接到本路线图。
- 需求、权限、时间语义、数据范围和错误状态没有未说明的歧义。
- 需要正式方案的阶段完成两轮独立复审。
- 静态检查、定向测试、构建、真实依赖验证按阶段风险执行并记录结果。
- 未验证的真实数据库、Redis、浏览器、MT4/MT5、Bridge、支付或生产事实明确标记为未验证。
- 发现的新缺口进入迁移矩阵或路线图，不以“以后再说”静默遗漏。
- 开始下一阶段前重新向用户介绍并请求确认。

## 5. 第一轮路线图复审

复审范围：需求覆盖、业务边界、现有能力复用、最小实现和是否设计过度。

结论与调整：

- 原顺序只有前端、认证和 Bridge 摘要，缺少主站/后台盘点、API、实时协议、后端模块、交易状态机和逐表数据库设计，已补为独立阶段。
- 先盘点再冻结合同，避免按旧路由直接生成 API V4 后遗漏业务能力。
- 没有先搭建大量空前端模块；工程骨架放在合同、后端边界、数据库设计和 Bridge 原型之后，减少返工。
- Bridge 原型先于真实行情竖切，确保前端不会依赖一个尚未验证 Win7 和 MT4/MT5 的临时协议。
- 不引入微服务、事件总线或新数据库作为默认目标；后端仍可保持模块化单体。

第一轮结论：顺序覆盖当前已知产品与工程边界，且没有为了“规范化”提前引入无明确收益的复杂架构。

## 6. 第二轮路线图复审

复审范围：兼容性、数据与迁移、并发与幂等、异常恢复、时间语义、安全、测试、回滚和连带 Bug。

结论与调整：

- 数据库总方案不能代替逐表设计，已把 165 张表映射和旧时间语义冻结放在首个 DDL 之前。
- 交易业务不能只按页面迁移，新增统一执行状态机阶段，避免手动单、自动单、分发和平仓在不同模块产生重复副作用。
- SSO 与 Bridge 会话继续隔离；账户、终端、观摩源和实时数据在同一竖切中验收，防止跨账户缓存和消息串号。
- 数据迁移采用旁路目标库反复演练，结构实施、切换和删除分开授权，避免确认一个阶段后隐含授权破坏性操作。
- 自动更新必须在 Bridge 技术冻结阶段验证从旧版到新版的升级、失败回滚和配置保留，不能拖到最终发布才发现不兼容。
- 非功能验收单独成阶段，覆盖长连接、锁竞争、带宽、Win7 和故障恢复；单元测试通过不能代替这些证据。

第二轮结论：调整后的路线图可执行。路线图复审完成时，阶段 5 已完成，下一阶段为“交易执行统一状态机”；阶段 6 后续已按单独确认启动并完成，见阶段进度记录。

## 7. 阶段进度记录

### 2026-09-02：阶段 1 主站现有功能盘点

- 用户已确认开始，交付物为[主站现有功能盘点与迁移边界](./main-site-function-inventory.md)。
- 已覆盖路由、入口、账号、会员、TRC20 目标、课程、内容、社区、通知、工具、公开交易案例、API 业务域、数据表、后台任务、外部依赖、权限与异常状态。
- 冻结“共享身份和合同、各应用独立账户页面”的用户中心边界，取消通用账户前端和 iframe 嵌入方案。
- 当前证据来自源码、路由、测试清单和 `dev_vue` 数据库只读结构/估算行数；真实支付、短信、外部存储、视频播放和生产静态资源留待对应实施阶段验证。
- 阶段 2“管理后台现有功能盘点”其后已获得用户确认并完成。

### 2026-09-02：阶段 2 管理后台现有功能盘点

- 用户已确认开始，并新增“按页面配置 TDK”和“配置主域名及各应用子域名”两项目标能力。
- 本阶段先盘点现有管理能力，再对照成熟后台形成建议新增清单；建议项必须经用户确认后才能进入迁移矩阵或实施。
- 域名配置的应用数据与 DNS、证书、反向代理等基础设施变更分层设计，避免普通后台保存直接破坏登录、Cookie、回调或线上可用性。
- 已形成[管理后台现有功能盘点与目标能力建议](./admin-function-inventory.md)，覆盖当前导航、用户、商业、内容、AI、风控、通知、审计、配置、API、数据和后台任务。
- TDK 与域名中心已列为必做能力；用户确认 A1–A5、B2–B7 加入，B1 站点运营扩展暂缓。
- 阶段 2 已完成。阶段 3“全项目功能迁移总矩阵”仍未开始，必须先单独介绍范围、交付物和风险并等待用户确认。

### 2026-09-02：阶段 3 全项目功能迁移总矩阵

- 用户已确认开始，并补充“前端实时更新数据走 WebSocket，其它数据走 HTTP API”的传输要求。
- 本阶段将为每项功能记录所属应用、用户范围、权限、HTTP 快照或命令、WebSocket 增量、数据权威源、时间语义和验收条件。
- 本阶段不实现 API、不修改数据库、不开发前端、不改变 Bridge 协议，也不删除旧功能。
- 已形成[全项目功能迁移总矩阵](./full-project-function-migration-matrix.md)，覆盖 SSO、www、trade、admin、后端业务域、数据库数据域、Bridge、后台任务和旧实现候选。
- 矩阵采用“HTTP 一致快照/查询/写命令 + WebSocket 实时增量/结果事件”，不沿用旧版浏览器 WebSocket RPC。
- 阶段 3 已完成。全量旧源码测试为 244/245 个文件、3814/3816 项通过；2 项 Bridge 发布工具测试因子进程无法识别 `Get-FileHash` 失败，已在矩阵验证记录中保留，未在文档阶段修改发布脚本。
- 阶段 3 完成时尚未开始阶段 4；其后已按逐阶段确认规则取得用户确认并完成阶段 4。

### 2026-09-02：阶段 4 API V4 与实时协议 V4

- 用户已确认开始。本阶段只冻结 HTTP API、浏览器实时通道和 Bridge 设备协议，不实现路由、不修改数据库、不改 Bridge 客户端，也不执行交易。
- 现状审查确认：旧浏览器 WebSocket 同时承载查询、设置和交易写命令；V4 将其收敛为服务端到浏览器的实时增量与异步结果，所有浏览器写操作改用 HTTP 幂等命令。
- Bridge V3 的终端身份、账户引用、连接代次、命令截止时间、执行结果确认和 revision 连续性作为 V4 的保留约束；旧动作名称和消息包络不作为兼容目标。
- 已形成 [API V4、浏览器实时协议 V4 与 Bridge 设备协议 V4](./api-v4-and-realtime-protocol.md)，冻结 `/api/v4`、`/realtime/v4`、`/bridge/v4/ws`、统一响应/错误、cursor、ETag、幂等、异步 operation、订阅恢复、流控、精准查询和确定性命令。
- 已新增 `contracts/openapi-v4.json`、`contracts/realtime-v4.schema.json` 和 `contracts/bridge-v4.schema.json`；当前 OpenAPI 是公共包络与首个 trade 竖切骨架，后续领域只能扩展同一主合同。
- 两轮复审已写入正式方案。阶段 4 不兼容旧浏览器 RPC 或 Bridge V3，但未授权删除、切换或实现。
- OpenAPI 通过 Redocly recommended lint；两份 JSON Schema 通过 Draft 2020-12 元 Schema 检查，内部引用、负例边界、文档链接和 diff 检查均通过。
- 阶段 5“后端目标架构”其后已获得用户确认并完成；阶段 6 必须重新介绍并等待用户确认。

### 2026-09-02：阶段 5 后端目标架构

- 用户已确认开始，并补充“所有后台任务必须异步，不能影响主进程或其它任务”。
- 现状审查确认旧 `server/index.js` 在单一 Node 进程同时启动 HTTP、Bridge WebSocket、调度、AI、交易协调、支付、通知、复盘和维护任务；68 个 route 文件直接导入数据库能力，当前无 BullMQ。
- 已形成[后端目标架构与异步任务隔离方案](./backend-target-architecture.md)，冻结 Node.js 24 LTS + TypeScript + Fastify 的模块化单体，以及 HTTP API、浏览器实时网关、Bridge 网关、scheduler、六类 Worker 的独立进程边界。
- 关键交易、支付和会员任务采用 MySQL 业务事务 + outbox + 确定性 job ID + 幂等消费者；BullMQ 只负责可靠投递和唤醒。queue Redis 与 cache Redis 默认隔离。
- 已将旧后台任务逐项映射到 execution、analysis、review、payment、notification、maintenance 进程组，并把禁止 route SQL、网关启动任务、Worker 调用路由等规则写入项目标准。
- 两轮复审已写入正式方案；本地文档链接、必要章节和 `git diff --check` 通过。本阶段没有安装依赖、运行新后端、修改数据库、执行任务、提交、推送或部署。
- 用户确认继续使用宝塔 Node 项目界面统一管理；部署映射已补充为单个 `aurum_ai` PM2 项目加载 `ecosystem.config.cjs`，面板统一启停、PM2 按角色隔离和监控。
- 阶段 5 已完成。下一阶段为阶段 6“交易执行统一状态机”，必须先介绍状态范围、幂等、未知结果、恢复和审计边界并等待用户确认。

### 2026-09-02：阶段 6 交易执行统一状态机

- 用户已确认开始。本阶段只冻结状态、转换、幂等、权限、恢复和审计规则，没有实现后端、修改数据库、改 Bridge 或执行交易。
- 现状审查确认订单意图、Bridge 命令账本、自动信号分发、AI 持仓管理、管理员策略分发/平仓/撤单均已有局部状态机，但 `failed`、`skipped`、`uncertain` 和 `partial` 语义不一致。
- 目标统一为公共 operation、账户级 execution intent、Bridge command、终端资源投影、来源/批量分发五类关联状态，避免一个巨型枚举。
- 公共操作新增 `partially_succeeded` 供批量父操作表达部分成功；删除目标公共语义中的模糊 `skipped`，按事实映射为成功、拒绝、取消、过期或未知。
- 一旦 Bridge 命令已标记投递并尝试写出，禁止普通重发；超时、断线、回执落库失败和资源未确认统一进入 `uncertain` 对账。
- 策略分发冻结目标并为每个账户创建独立子 operation；分发平仓只按原 distribution/outcome/ticket 精确归因。
- 已完成两轮复审，正式方案见 [交易执行统一状态机](./trade-execution-state-machine.md)。
- 阶段 6 已完成。下一阶段为阶段 7“数据库逐表迁移设计”，开始前必须介绍表域、旧新映射、数据核对、双读切换、回滚和旧表删除门，并等待用户确认。
- 阶段 7 新增输入：每个用户默认 1 条 MT4/MT5 共用账户 WebSocket 并发连接额度，可购买额外额度；额度只统计当前在线连接。数据库需设计权益 grant、并发上限投影、连接会话审计、隔离终端档案和账户级策略订阅；实时 Gateway 使用带 TTL 的原子连接 lease，并保留所有既有账户与订阅数据。详见 [Bridge 并发连接额度与账户级策略订阅模型](./bridge-connection-quota-and-account-subscription-model.md)。

### 2026-09-02：阶段 7 数据库逐表迁移设计

- 用户已确认开始。本阶段只读取 `dev_vue` 元数据和聚合统计并设计迁移，没有执行 DDL、DML、回填、修数、建库或删除。
- 已形成[数据库逐表迁移矩阵](./database-table-migration-matrix.md)，逐一覆盖源库 165 张 InnoDB 表、271,007 行和约 682.50 MiB 数据；机器覆盖检查为 165/165、无遗漏、无重复、无未知表。
- 矩阵为每张表标记保留、重塑、拆分、合并、归档或候选删除，冻结目标实体、字段类型、UTC 分类、唯一键、外键、索引、分块回填、逐用户/全局对账、切换和回滚规则。
- 已纳入 Bridge 当前账户 WebSocket 并发额度、可自由新增/删除/更换 MT4/MT5 账户、账户级策略订阅和实时 TTL lease；没有建立持久账户槽位。
- 只读审计确认 1,015 条平台信号使用 `user_id=0`、4 条通知引用缺失用户，以及一个由两个旧账户 ID 表达的交易账户接管历史；最终方案均保留证据并给出显式映射，禁止直接删除。
- 两轮独立复审完成。进入任何 DDL 前仍需生成逐列时间语义 manifest、可恢复基线备份并取得用户对目标旁路库及结构实施的单独授权。
- 阶段 7 已完成。下一阶段为阶段 8“Bridge V4 原型与技术冻结”，必须先介绍 Win7 双原型、MT4/MT5 多档案、精确请求、时区、命令账本和自动更新验证范围并等待用户确认。

### 2026-09-02：阶段 8 Bridge V4 架构审查与原型准备

- 用户已确认开始，并明确要求重新评估 Rust 前旧版的 Win7 安装体验、打包方式、兼容性和杀毒误报；本阶段不发布、不安装、不连接真实交易。
- 已核查 Gitee 提交和标签：传统安装体验来自 Inno Setup；早期 Python/PyInstaller/Nuitka 可见版本绑定 Python 3.11/3.12/3.13，Rust 前 C# 版目标为 `net10.0-windows`，两者都不能作为受支持 Win7 运行时证明；当前 Rust 普通 MSVC 目标官方为 Windows 10+。
- 已形成 [Bridge V4 Windows 7 架构、安装与更新技术冻结方案](./bridge-v4-win7-architecture-and-packaging-plan.md)。初版双 EA/Service 在 MT5 实机前被纠偏：首选原型改为 `.NET Framework 4.8 + WinForms + MT4 精简 EA + MT5 官方 Python Worker + 命名管道 + Inno Setup`，Rust Win7 Tier 3 仅作对照；不恢复 Python GUI 或自解包打包器。
- 设备职责收敛为基础数据、确定性交易执行、诊断和更新；复杂快照、图表、统计、策略和风控组合由服务器完成。已有基础字段可由服务端重新组合，新增终端原始能力仍需版本化扩展。
- 第二轮复审发现 .NET Framework 公共 `ClientWebSocket` 在 Windows 7 不可用，已将独立 RFC 6455/TLS 传输、真实经纪商终端 build、无 Authenticode 时的 SmartScreen 边界和多档案故障隔离加入硬门。
- `contracts/bridge-v4.schema.json` 已删除通用 `select/filter/sort`，收敛为 14 个基础资源的专属 `params`、7 类窄实时资源和 6 个确定性命令；当前只作为阶段 8 原型合同，具体响应字段仍需结合 MT4/MT5 实机结果后最终冻结。
- 用户已确认首选技术方向，并补充 `.NET Framework 4.8` 依赖交付：前端下载页提供在线安装包与离线完整安装包，Bootstrapper 自动检测 `Release >= 528040`；普通用户无需预装或手动判断依赖，缺少 Win7 SP1/前置更新或需要重启时必须给出明确续装流程。
- 已建立 `bridge/prototypes/net48-win7/` 隔离原型：x86/x64 当前各 55 项离线冒烟通过，真实 TLS 1.2 WSS Echo 通过，MT4/MT5 共用窄命名管道合同与 SQLite 幂等账本通过；在线/离线 Inno 安装包均可编译，本机安装、Launcher 启动和卸载闭环通过。signed manifest V2/P-256、包大小与 SHA-256、安全解压、版本原子暂存、激活中断恢复、健康检查失败回滚和版本外数据保留已完成双架构离线演练。
- 当前 Win11 开发机的 MT5 官方 Python 路径已完成真实模拟账户探测、行情/K线成交量/账户/持仓挂单/历史只读验收，以及最小手数挂单、改单、撤单、开仓、保护修改、部分和全部平仓矩阵；清理后无测试挂单或持仓残留。
- `.NET Framework 4.8` 多 MT5 Worker 主机原型已接通现有 Python IPC v2：每个终端档案独立进程、管道、nonce、route 和 epoch；连接超时、空闲进程退出及“握手后立即退出”均会 fail closed，x86/x64 共 20 项冒烟及真实 MT5 只读探针通过，退出后无 Worker 残留。
- CPython 3.8.10 x64 embeddable、MetaTrader5 5.0.5735 cp38 x64 和 NumPy 1.24.4 cp38 x64 候选已完成固定文件/哈希解析，并在当前 Win11 由 x86 Host 驱动 x64 Worker 通过真实 MT5 只读探针；这仍不替代 Win7 SP1、Universal CRT 与 MT5 Build 5320 的实机兼容验证。
- MT4 V4 EA 已完成六类固定交易命令、严格预期状态和不确定结果处理，MQL4 编译与 x86/x64 离线合同测试通过；当前 `8950701 / DPrimeVU-Demo 5` 没有 EA 交易权限，只完成真实账户、时钟、品种、报价、K 线及成交量、持仓挂单、历史和诊断的只读探针。真实 MT4 交易矩阵按用户要求延期，旧版 EA 只作为源码与行为对照。
- 用户进一步冻结 Bridge 的最小职责：全部策略、风控、会员、额度、品种、手数、止盈止损和交易时段限制均在服务端；Bridge 只提供基础数据、调用终端并回传成功/失败/不确定结果。K 线和交易历史等大体量事实按终端档案缓存到独立 SQLite，以覆盖范围和稳定游标支持随时精确读取。
- SQLite 缓存边界已经补充并完成 Core 运行时接线：V1/V2 追加迁移、每档案 epoch 隔离、已收盘 K 线与历史事实、账户/持仓/挂单恢复投影、stream 状态、合约规格短缓存、同步任务租约、Outbox ACK、维护状态和分级小批清理均已落地；每档案 Runtime 现统一拥有 Store 与命令账本，覆盖命中直接稳定分页，缺口仅登记后台同步，终端读取不持有 SQLite 写锁。分批同步保存有界 cursor，旧 epoch 的同步任务和 Outbox 不进入当前队列；服务端 `persisted/duplicate` ACK 必须严格匹配 route/resource/scope/range/revision 才能推进清理证据。实时报价和当前 K 线仍以内存为主。
- V4 查询会话离线闭环已接入：严格解析服务端 `query.request`，核对 terminal/account/epoch，实时小查询走统一终端接口，范围查询走 SQLite 覆盖与快照游标；缺口只返回可重试刷新状态并由异步同步队列补齐。已增加 RFC 6455 消息通道适配和单步会话泵。查询响应不进入需 ACK 的 Outbox，避免协议无查询 ACK 时永久重发；分页中的部分覆盖不会提前冒充完整覆盖。
- 每档案独立会话 Worker 已加入短时单次 session 凭据 WSS 工厂、严格 `session.hello/welcome`、连接代次切换、心跳 ACK 半开检测、1/2/4/8/16/30 秒有界重连及跨 epoch 持久 Outbox 刷新。更新协议新增服务端 `restart_not_before_utc_msc`，包暂存后还必须等待本机命令、未知结果和关键写入空闲，才调用版本激活/重启边界；不在 Bridge 复制自动分析调度。MT4 管道与 MT5 `live/archive` Worker 的 K 线和历史原始响应已统一映射为投影批次：当前柱不落盘，历史中间页不发布完整覆盖，出金保留负号，票号按文本保存；MT4 EA 的范围 K 线已改为按请求窗口定位，不再只扫描最近 500 根。WinForms 已接入可新增、编辑、连接、断开和移除的多终端档案；配置原子写入，长期 refresh 凭据仅保存为当前用户 DPAPI 密文，建连前换取短时 session 凭据。每个档案独立 WSS、SQLite、epoch 与 MT5 `live/archive` Worker，移除配置不删除本地安全账本。离线冒烟计数以后续迁移批次的最新脚本输出为准，MT5 Worker 通过 67 项单元测试，MT4 MQL4 编译为 0 错误、0 警告。
- 确定性命令离线闭环已完成：`command.request` 先持久写入 SQLite 再回 `command.accepted`，响应成功发出后才调用终端；重复 command/idempotency 不会重放，过期命令不执行，已进入终端边界但结果未知时落 `uncertain`，只能经 `command.reconcile` 精确查询。最终或不确定结果在 `command.result_ack` 前跨重连保留；MT5 支持原生 Stop Limit 和显式移除止损、止盈、到期时间，MT4 对不支持的 Stop Limit 保持明确拒绝。当前仅完成模拟终端和离线适配验证，没有连接公网或执行新的实机交易。
- 自动更新本地闭环已完成：系统代理下载、最多 3 次逐跳安全重定向、严格 UTF-8/大小限制、固定 P-256 签名与 SHA-256 校验、分包原子暂存已串联；全部活动档案先检查命令账本，再暂停网络处理并等待关键操作归零，达到服务端 `restart_not_before_utc_msc` 后由固定 Launcher 等待旧 PID 退出、健康切换或回滚。健康、回滚和启动失败会写入版本外状态并作为 `release.status` 在 WSS 恢复后回传。x86/x64 已通过本地 HTTP 模拟、Worker 暂停恢复、状态回传和真实双版本 Launcher 进程演练；没有上传、发布、连接公网或证明 Win7 实机兼容。
- V3→V4 迁移第一批已完成：按当前实装目录和实际 `control_url/realtime_url` 合同实现只读幂等快照，只保留偏好与终端绑定，不复制旧 DPAPI 刷新凭据、不迁移缓存/日志/旧命令账本/游标；真实 V3 数据演练识别 2 个档案并核对 7 个源文件哈希未变化。V4 主程序已兼容 V3 Launcher 的健康、真实就绪和最小化参数，x86/x64 均通过 62 项离线烟雾测试，主程序与 Launcher 版本为 4.0.0.0。本轮没有安装、发布、改写旧目录或执行交易。
- V3→V4 迁移第二批已完成本地源码闭环：Fastify 5 + TypeScript 独立模块、OpenAPI V4 合同和显式 SQL 迁移文件实现 V3 refresh 到 V4 设备 refresh 的一次性交换；一个 V3 source session 唯一绑定一个 V4 安装/档案，同绑定重试只轮换 generation，V3 源会话保持不变。客户端在当前用户上下文解密旧凭据，全部档案交换成功后才原子写入 V4 catalog，并在每次 WSS 建连前换取最长 60 秒的单次 session 凭据。当前没有挂载到正式目标进程、执行数据库迁移、连接公网或投放更新。
- V3→V4 迁移第三批完成原生过渡入口和稳定系统入口的本地闭环：当前实装 V3 的桌面、开始菜单、HKCU 自启动和卸载项都固定指向根目录 `AURUMBridge.Launcher.exe`。第一跳由 V3 更新器启动并验证仍保留 V3 Launcher 的过渡候选；候选核心健康后，才把同目录无 .NET 依赖的 Win32 x86 入口原子提升为根稳定启动器。第二跳由原生入口安装/续装 4.8 并把 V4 激活交还旧 Launcher 验证。V4 首次健康启动后原子生成 `current.txt/previous.txt`，此后改由版本目录托管 Launcher 接管；系统入口路径无需重写。x86/x64 烟雾、V3 参数转发、真实 V4 核心交接、当前实装 V3 Rust Launcher 的失败回滚，以及在线 Inno 临时安装/启动/卸载均通过。实装目录、注册表、快捷方式和线上清单均未修改。
- V3→V4 迁移第四批完成隔离安装副本的临时签名两跳演练：三个版本包均按 signed manifest V2、大小、SHA-256 和 P-256 签名进入正式解析/验签/安全暂存路径，随后验证过渡候选健康、原生稳定入口提升、V4 健康接管、失败回滚及 `rolled_back` 恢复。当前实装 V3 的三个关键文件前后哈希一致。演练私钥不落盘，没有安装 Runtime、投放清单、连接公网或执行新增交易。
- 用户确认新版 Vue 工程不保留任何旧前端兼容代码；阶段 9 开始时从 `dev_vue` 清除旧手写前端，需要时只读参考 `D:\dev_codex\wall-street-skill-local`。数据库迁移不在清理范围：公网旧结构到 V4 的迁移文件、版本识别、legacy ID map、回填 checkpoint 和对账逻辑必须作为发布链长期保留并持续演练。
- 阶段 8 核心研发阶段性完成并冻结。Core 层 SQLite/同步/Outbox、查询响应、每档案 WSS 会话生命周期、MT4/MT5 原始只读数据到统一投影批次、确定性命令、WinForms 本地多档案/DPAPI 凭据/启停编排、旧 V2 清单验签、安全暂存、Launcher 健康回滚、V3 配置只读迁移、V3 refresh 到 V4 设备 refresh 交换，以及隔离副本 signed 两跳升级均有本地证据。后续 Vue 与服务端若需要新的基础数据、诊断或确定性操作，按版本化窄合同小步补充，不扩展 Bridge 业务职责。
- 阶段 8 的发布与实机验收门延期到最终打包前：目标 Fastify 进程和公网 Bridge 网关正式接线、真实终端多页与中断续传、公网端到端鉴权、正式发布密钥签名、缺少 .NET 4.8 的 Win7 SP1 安装/重启/RunOnce、断电/磁盘满/杀进程、Win7/10/11、固定 Python/MT5、代理/断网/Autobahn、长稳和杀毒矩阵。MT4 经纪商历史可见性及真实交易矩阵也继续延期；未经后续授权不执行。完成这些发布门前仍不得宣称 V4 已正式支持 Win7，或向 V3 客户端投放 V4 清单。
- 阶段 9 已完成：旧 `public/` 手写页面和仅绑定旧 DOM 的测试已退出版本树；主站、AI 交易实验室和管理后台分别建立 Nuxt/Vite 独立工程，共享唯一 shadcn-vue 组件源、设计令牌、V4 合同与传输客户端，并通过应用构建、类型、测试和跨应用边界检查。后端合同测试从混合旧 UI 测试中保留，数据库迁移和 Bridge 文件未作为前端清理对象。
- 阶段 10 已完成实现与离线验证，正式验收记录见 [阶段 10：SSO 端到端竖切验收记录](./stage10-sso-vertical-slice-report.md)。已建立 auth 身份中心、三个 Host-only 应用会话、Authorization Code + PKCE、CSRF、一次性 WebSocket 票据和三种退出范围；根测试 3397 项、前端测试/类型/构建与边界检查均通过。未执行数据库迁移，也未连接真实 MySQL、Redis、HTTPS 子域或 WebSocket 网关，相关证据明确延期到旁路迁移和联调阶段。
- 阶段 11 已完成实现与离线验证，正式记录见 [阶段 11：账户、终端与实时行情竖切验收记录](./stage11-account-terminal-realtime-vertical-slice-report.md)。已建立账户归属、当前在线连接额度、终端档案、观摩上下文、账户快照、实时报价、K 线与成交量、持仓、挂单和浏览器精确恢复链路；投影数据与 revision 原子提交，浏览器按单账户、单资源隔离订阅。迁移未执行，真实 MySQL/Redis/Bridge/MT4/MT5/浏览器验收明确延期到阶段 15–16，不据此宣称实机门已通过。
- 阶段 12A 已完成实现与离线验证，正式记录见 [阶段 12A：分析师与账户级交易员核心验收记录](./stage12a-analyst-trader-core-report.md)。V4 已把系统用户归属的不可变 `market_analysis`、交易账户级 `trade_decision` 与后续 `execution_intent` 分开，手动分析不再携带自动执行开关；策略固定为 `analysis` 和 `trader` 两类，交易员按账户订阅 revision 独立排队，完整正文走 HTTP，小型状态变化走 WebSocket。迁移未执行，模型 Worker、确定性风控接线、真实 MySQL/Redis、多账户和 MT 验收仍属后续子阶段。
- 阶段 12B 已完成实现与离线验证，正式记录见 [阶段 12B：分析调度、Worker 与条件扇出验收记录](./stage12b-analysis-scheduler-worker-report.md)。同用户、同分析策略版本、同品种、同五分钟槽只生成一份分析；行情、宏观和提示词被显式冻结；模型 task/attempt 有界重试并用 fencing 拒绝迟到结果；仅“有市场机会”或“已有持仓/挂单”的账户创建 `entry/manage/both` 交易员任务。迁移未执行，真实 provider、Trader Worker、确定性风控接线和实机验收仍属后续子阶段。
- 阶段 12C 已完成实现与离线验证，正式记录见 [阶段 12C：账户级 Trader Worker 验收记录](./stage12c-account-trader-worker-report.md)。单账户指标、持仓、挂单、目标报价、合约和风险摘要均显式冻结；同账户任务串行领取，模型 attempt 有界重试，迟到结果保存为 `stale`，且不接 Bridge、不创建可执行订单。
- 阶段 12D 已完成实现与离线验证，正式记录见 [阶段 12D：确定性风险策略与决定评审验收记录](./stage12d-deterministic-risk-review-report.md)。平台不可关闭边界、账户版本/CAS、账户风险摘要、减险例外和 `trade_decision` 的确定性批准/拒绝已独立建模；落库前复核全部 revision，完整结果走 HTTP，小型失效通知走 WebSocket。本阶段不创建执行意图、不接 Bridge，迁移未执行。
- 阶段 12D.1 已完成实现与离线验证，正式记录见 [阶段 12D.1：账户风控手动解锁验收记录](./stage12d1-manual-risk-release-report.md)。账户所有者可以对当前亏损、回撤、次数、连续亏损或冷却触发进行一次有限、审计化解锁；解锁绑定风险基线、业务日期和策略身份，指标恶化或策略变化后自动失效，且不能绕过平台绝对上限、全局停机、权限、数据完整性和单笔指令校验。迁移未执行。
- 阶段 12E 已完成本地实现与离线验证，正式记录见 [阶段 12E：执行意图与风险预留验收记录](./stage12e-execution-intent-reservation-report.md)。已批准风险决定会幂等转换为账户级 operation/intent；新增敞口动作建立 30 秒短期风险预留，同账户事务聚合活动预留以阻止并发超额，零动作保持 `noop`，过期准备记录释放预留。V4 表与旧 `order_intents`/`risk_reservations` 并存，迁移未执行，Bridge/MT 投递仍属于后续阶段。
- 阶段 12F 已完成本地实现与离线验证，正式记录见 [阶段 12F：Bridge V4 持久命令与结果对账验收记录](./stage12f-bridge-command-reconciliation-report.md)。每个 prepared execution intent 通过稳定的 intent+sequence 命令身份进入旁路 V4 命令账本；服务端先提交 `dispatched` 再尝试 WebSocket 写入，写入结果不明只进入 `uncertain`，不自动重放。Bridge 回执先持久化并推进 intent/风险预留，随后才生成 `command.result_ack`；冲突证据追加保存并转入人工复核。成功结果的 committed 预留继续占用容量，直到可信投影明确标记 absorbed。迁移未执行，正式 Gateway、MySQL/Redis、投影吸收、MT4/MT5 与公网端到端联调仍属于后续阶段。
- 阶段 12G 已完成服务端模块边界与离线验证，正式记录见 [阶段 12G：Execution Worker、Bridge Gateway 与可信投影交接验收记录](./stage12g-execution-worker-bridge-gateway-report.md)。V4 会话按单次票据、安装/档案、账户归属、终端实例和数值 epoch 授权；额度按 WebSocket/档案计数，当前 route 用 Redis fencing，执行用账户短租约及数据库活动命令门串行。重连每次只精确对账一条 uncertain 命令，不重发 command.request；持仓/挂单完整快照同时更新浏览器投影与 exact-state，并只在 revision、时间和 ticket/状态证据完整时吸收 committed 预留。阶段复用 010 迁移，不新增或执行迁移；正式 WSS upgrade 接线、真实 MySQL/Redis、Bridge/MT4/MT5 和公网联调仍待后续阶段。
- 阶段 12H 已完成本地运行时接线与离线验证，正式记录见 [阶段 12H：Bridge Gateway、Execution Worker 与 Outbox 运行时接线验收记录](./stage12h-v4-runtime-wiring-report.md)。`/bridge/v4/ws` 严格使用 Authorization bearer、首帧 hello、512 KiB 帧和有界串行背压；prepared intent 与 queued command 均在各自 MySQL 事务写 outbox，由独立 dispatcher 以确定性 job ID 唤醒 execution worker 和 Bridge gateway。重复队列投递只有仍为 queued 的 command 可以进入“先标 dispatched、后写 socket”，已跨边界的命令不重发。新增三个独立 PM2 角色、健康/就绪和优雅停机骨架，仍由宝塔一个 ecosystem 项目管理；显式 V4 总开关默认关闭，未启动进程、未执行迁移、未连接真实依赖或终端。
- 阶段 12I 已完成 API V4 与浏览器实时网关的本地运行时接线，正式记录见 [阶段 12I：API V4 与浏览器实时网关运行时接线验收记录](./stage12i-v4-api-browser-realtime-wiring-report.md)。API 统一挂载 SSO、Bridge 凭据和当前已实现的 trade V4 模块，并按精确 trade Host 隔离；浏览器实时网关只消费经活动会话复核的一次性 HttpOnly 票据及 Redis 已提交事件，保留账户授权、revision 缺口重拉、上/下行帧、慢消费者和心跳边界。trade 前端已改为断线前先重拉 HTTP 快照，再按 1/2/5/10/20/30 秒抖动退避携新 revision 重连。宝塔 ecosystem 增至五个独立角色；仍未启动真实进程、执行迁移或连接真实基础设施与终端。
- 阶段 12J 已完成 AI 异步运行链路的本地接线，正式记录见 [阶段 12J：AI 调度、模型 Worker、风控与执行运行时接线验收记录](./stage12j-ai-runtime-orchestration-report.md)。Analysis Scheduler、Analysis/Trader/Risk Worker 分离为独立 BullMQ/PM2 角色，任务型 Outbox 从分析请求一直唤醒到执行意图和 Bridge 命令；模型按用户与策略逐任务解析，平台共享请求在发网前原子检查每日额度并保留用量证据，崩溃遗留任务按绝对 deadline fail closed 回收且不重放 provider/终端。宝塔 ecosystem 增至九个角色；非任务领域事件实时投影、旁路数据库迁移、真实 provider/MySQL/Redis/Bridge/MT 和长稳压测仍待后续阶段。
- 阶段 12K 已完成 AI、风控与异步操作的小事件实时投影，正式记录见 [阶段 12K：浏览器领域实时投影与模型用量恢复验收记录](./stage12k-browser-realtime-projection-report.md)。分析记录保持系统用户级，交易员、风控和 operation 保持账户级；一个用户会话可订阅多个自有账户，观摩会话不能读取所有者专属领域事件。业务事务仍只写 Outbox，Dispatcher 在稳定 BullMQ 任务与 Redis 事件均成功后才完成该行；断线先 HTTP 重拉，完整推理、规则和快照不进入 WebSocket。遗留用量 reservation 只结算为 usage unknown，不重放模型请求。迁移、真实依赖、浏览器页面接线与端到端验收仍待后续阶段。
- 阶段 12L 已完成交易实验室首页最新分析与 AI 分析师真实前端竖切，正式记录见 [阶段 12L：交易实验室 AI 分析前端竖切验收记录](./stage12l-trade-analysis-frontend-report.md)。分析历史按系统账号归档，完整推理按需走 HTTP，手动分析固定使用已发布分析策略、独立幂等键和服务端 3 分钟冷却；首页复用单一实时连接接收用户级最新分析事件，断线先同步账户与分析 HTTP 快照。页面统一组合 shadcn-vue 与语义令牌，并保留后续 Astra 视觉换肤边界。真实服务、浏览器多宽度、MySQL/Redis/provider/Bridge/MT 仍待阶段 15～16 联调。
- 阶段 12M 已完成 AI 交易员真实只读账户工作区，正式记录见 [阶段 12M：AI 交易员账户工作区验收记录](./stage12m-trade-trader-read-workspace-report.md)。当前账户、持仓、挂单、账户级决定与完整推理已接入 HTTP 权威读取和账户级 WebSocket 小事件；指标事件不重复打 HTTP，账户快速切换采用串行 latest-wins，交易价格保留实际精度，交易时间按终端校准时区显示。手动下单、改单、平仓、撤单、策略分发和分发平仓因缺少统一 execution 用户命令入口而未伪造前端能力，须在下一服务端子阶段完成权限、幂等、风控、父子 operation、精确归因和只追加迁移后再接 UI。
- 阶段 12N 已完成统一用户执行命令与策略分发服务端闭环，正式记录见 [阶段 12N：用户执行命令与策略分发验收记录](./stage12n-user-execution-command-distribution-report.md)。手动市价单、挂单、持仓/挂单修改、平仓和撤单统一经过账户归属、观摩只读、精确 revision、确定性风控、风险预留、operation/intent、Outbox 与 Bridge V4；管理员分发在确认时按交易账户去重冻结目标，以独立异步子 operation 执行，并只按原 distribution/outcome/ticket 创建精确平仓。迁移仍未执行，真实 MySQL/Redis/Bridge/MT 与交易前端写操作联调属于后续阶段。
- 阶段 12O 已完成 AI 交易员写操作前端竖切与只读辅助端点，正式记录见 [阶段 12O：AI 交易员写操作工作区验收记录](./stage12o-trader-write-workspace-report.md)。页面使用 shadcn-vue Sheet、Field、Select、Table 与 AlertDialog 接入手动市价单/挂单、持仓和挂单修改、平仓、撤单、管理员策略分发及精确分发平仓；提交前读取服务端六类权威 revision 与目标资源 revision，危险操作二次确认，HTTP 受理后只展示 operation 状态，不推断终端成交。用户级分发父 operation 通过空账户 scope 的受控 WebSocket 目标更新；迁移仍未执行，真实 MySQL/Redis/Bridge/MT、浏览器多宽度和实盘行为仍待阶段 15～16 联调。
- 阶段 12P 已完成 AI 风控师真实前端竖切，正式记录见 [阶段 12P：AI 风控师前端工作区验收记录](./stage12p-risk-frontend-workspace-report.md)。当前账户风险状态、六项实时额度、账户规则编辑、服务端手动解除可用性、风控决定列表与逐规则详情已接入 V4 HTTP；账户级风险 WebSocket 只发送失效事件并回读权威资源。手动解除不能绕过平台停机、账户暂停、交易发送关闭、数据/时钟完整性和平台硬上限，且仍以摘要 revision、策略 revision、CSRF 与幂等键重新校验。观摩模式保持只读，迁移和真实依赖仍未启动。
- 阶段 12Q 已完成 AI 策略师与账户订阅真实竖切，正式记录见 [阶段 12Q：AI 策略师与账户订阅工作区验收记录](./stage12q-strategy-management-workspace-report.md)。平台策略对普通用户只读，个人分析/交易执行策略使用不可变版本、确定性编译、CAS 发布与退役；发布时原子推进尚未结束的账户订阅版本，普通开关不发生隐式版本漂移。不同自有账户可独立绑定分析和交易执行策略，同账户同品种只保留一个活动执行槽位。前端统一组合 shadcn-vue；迁移、真实依赖和模型/终端运行仍未启动。
- 阶段 12R 已完成 AI 复盘师与策略记忆规范化核心，正式记录见 [阶段 12R：AI 复盘师与策略记忆工作区验收记录](./stage12r-reviewer-memory-workspace-report.md)。日/月/手动复盘统一为用户级 case、冻结账户/策略/订阅/终端时区证据，不可变版本分别评价分析、交易员、确定性风控和终端执行；记忆只在人工确认后进入候选，长期候选需三个独立已确认 case 再额外确认，合并后可通过新 revision 撤销。复盘使用独立低优先级 Worker，浏览器实时只接收状态失效事件。周期证据生产、旧数据迁移、真实依赖和实机验收仍未执行。
- 阶段 12S 已完成权威交易记录结构、HTTP 读模型、实时失效合同和交易实验室工作区，正式记录见 [阶段 12S：权威交易记录与终端证据链验收记录](./stage12s-authoritative-trade-history-report.md)。只展示终端历史事实已经封口的已平仓交易，上游分析、风控、命令状态不冒充成交；迁移、Bridge 历史采集和旧数据回填当时尚未接线。
- 阶段 12T 已完成 Bridge 历史采集的本地运行时接线与离线验证，正式记录见 [阶段 12T：Bridge 历史采集、权威投影与迁移演练验收记录](./stage12t-bridge-history-collector-report.md)。独立 scheduler 只登记在线账户到期任务，MySQL outbox/BullMQ 只携账户 ID；Gateway 使用当前 route/epoch 发出 `history.orders/trades/deals` 精确只读查询，分页事实短事务入库，完成后递增 history revision 并发布轻量失效事件。迁移、真实 MySQL/Redis、Bridge/MT 和旧数据回填仍未执行。
- 阶段 12U 已完成系统审计与执行链路离线竖切，正式记录见 [阶段 12U：系统审计与执行链路工作区验收记录](./stage12u-system-audit-workspace-report.md)。审计页通过 HTTP 冻结游标读取当前用户的权威领域记录，WebSocket 只发送 `audit.changed` 失效通知；详情使用精确外键串联分析、交易员、确定性风控、operation/intent、Bridge 与终端结果，不下发原始模型、终端请求或内部堆栈。迁移、真实 MySQL/Redis、浏览器登录态和 Bridge/MT 仍未启动。
- 宏观看板 M0 和 M1 源码合同、双库结构演练已完成，见 [M1 宏观合同记录](./stage-m1-macro-contract-and-schema-implementation.md) 和 [中断恢复验收](./stage-m1-interrupted-schema-recovery.md)。独立基础安装及 001～017 在两个旁路库全部通过，各 102 表/18 文件，结构指纹和风控种子业务内容一致；011 采用追加纠正，A/B 原始失败证据永久保留，重复 apply 不重放。源库、应用连接和交易终端均未修改。2026-09-05 已完成 [源备份、字段映射与回填对账方案](./stage-m1-data-backfill-and-reconciliation-plan.md) 及 165 表只读差异盘点，源共 271,007 行；纠正旧矩阵重复条目和过时迁移目录。[B1 首批只读/离线工具](./stage-m1-b1-backup-verification-tooling.md) 已加入源码，包含观测、参数预览、文件 hash 和恢复观测比较；不是备份/恢复执行器。下一步确认存储、加密保管及精确恢复源库，随后实施并单独授权真实导出/恢复，不向 A/B 写业务数据。M1 全量旧数据迁移、供应商采集、应用切流、旧表清理仍未完成。
- B1 后续已完成 [服务器备份条件只读核验](./stage-m1-b1-server-backup-readiness.md)：MySQL 8.4.8 客户端、GPG/gzip、相关权限可用，当前约 37.85 GiB 空闲；备份/口令新目录及恢复源库均未创建。待用户确认精确路径、同机分离保管和无 DDL 窗口后，实施导出/恢复适配器与隔离演练；本轮无备份、建库或数据回填。
- 用户确认后，B1 [加密备份与独立恢复演练](./stage-m1-b1-encrypted-restore-rehearsal.md) 已实际执行到 SQL 审查门：工具源码 `96e18216`，15 files/115 tests 通过；165 表源备份加密为 177649476 B，解密 SQL 682966225 B 与导出 hash 一致。首版审查器不支持合法 DEFAULT/生成表达式，且两列 STORED GENERATED INVISIBLE 需要准确处理 INSERT 省略，故在建库前保护性停止。新恢复库仍不存在，A/B 未写，全部现场保留。下一步确认生成列适配及续接现有备份恢复；不重新导出/覆盖、不提升为 B1 完成或全量迁移完成。
- 用户再次确认后，B1 [冻结备份续接恢复](./stage-m1-b1-retained-backup-continuation.md) 已通过：工具源码 `c3ddf32b`，16 files/129 tests 通过；最终 SQL 全量审查后创建唯一隔离镜像 `dev_vue_m1_source_20260905_01`，165 表/271007 行完整结构指纹、逐表普通列 INSERT hash 和独立真实 COUNT 全部一致。原备份/失败记录/工具不覆盖，源未再导出、A/B 未回填、应用及终端未触碰。**B1 完成，下一确认门为 B2 精确字段映射与目标缺口复核**；异机容灾、V4 业务迁移、应用切流和旧表删除仍未完成。
- B2 [首批身份/账户映射评审](./stage-m1-b2-identity-account-mapping-review.md) 已完成：读取冻结镜像与目标 A 元数据，11 表/148 列显式处置清单及纯离线校验已加入。发现 274 段归属历史不能压入当前授权 PK、7 条旧终端缺安装标识且新账户读取依赖档案、公开观摩受众不能仅复制空 assignments，以及会员/验证/推荐等字段缺承接。没有回填或修改 schema/应用/终端。下一确认门为这些缺口的结构与读写合同设计；其它 154 张源表仍需后续 B2 精确审查，不能直接进入全量 B3。
