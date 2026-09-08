# AURUM V4 Repository Guidelines

本文件只保存当前重构长期有效的强制规则。详细产品、架构和迁移设计以链接文档为准；旧版运行细节不得继续追加到本文件。

## 1. 当前代码边界

- V4 服务端源码位于 `server/src/`，按 `domain / application / infrastructure / transport` 组织；入口位于 `server/src/entrypoints/`，构建产物位于 `server/dist-v4/`。
- V4 数据库迁移只允许追加到 `server/db/migrations/`。旧 `server/migrations.js` 和 `server/routes/` 等 JavaScript 后端仅作为迁移与功能核对输入，不得承载新的 V4 功能。
- 前端工作区为 `frontend/apps/www`、`frontend/apps/trade`、`frontend/apps/admin`、`frontend/apps/auth`；唯一共享基础组件源为 `frontend/packages/ui`。应用之间不得互相导入业务页面或业务状态。
- HTTP、浏览器实时和 Bridge 的机器合同位于 `contracts/`。合同变更必须同步校验生产者、消费者、正反例测试和版本兼容边界。
- HTTP 合同源位于 `contracts/http/domains/`，域与文件由 `contracts/http/manifest.json` 显式登记；`contracts/openapi-v4.json` 是生成产物，禁止单独手改。修改域源后运行 `pnpm run generate:api-contract`、`pnpm run verify:api-generated` 和相关合同/消费者验证。生成一致不等于完整 API 验收。
- 前端 HTTP 传输类型由 `pnpm run generate:api-types` 生成到 contracts 包的 `src/generated/http.ts`，不得手改产物；`pnpm run verify:api-types` 验证源与产物一致。生成类型不代替运行时校验，页面转换后的模型与线上传输类型必须区分。
- 已接入服务端同源校验的操作在 `contracts/http/runtime.json` 逐项登记；使用 `generate:api-runtime` 生成运行Schema并以 `verify:api-runtime` 检查漂移。运行产物随server构建，不运行时读取仓库合同。当前适配范围见HTTP合同README，未接入操作不得宣称已自动校验。
- 当前 Win7 Bridge V4 候选实现与离线验收源位于 `bridge/prototypes/net48-win7/`。在正式提升目录前，不得恢复 Rust/Electron/WebView/Python GUI 为主客户端，也不得把原型测试结果表述为正式发布证明。
- 旧版功能需要参考时，只读查询 `D:\dev_codex\wall-street-skill-local`。禁止在参考仓库实施本轮重构，禁止把旧前端或旧后端整段复制回 V4。

## 2. 权威文档与冲突处理

- 总体顺序与阶段状态：`docs/refactor-master-roadmap.md`。
- 前端：`docs/vue-frontend-requirements-standard.md`、`design-system/aurum-v4/MASTER.md`、根目录 `PRODUCT.md` 与 `DESIGN.md`。
- 身份与子域：`docs/single-sign-on-authentication-architecture.md`。
- API 与实时协议：`docs/api-v4-and-realtime-protocol.md`。
- 服务端：`docs/backend-target-architecture.md`。
- 数据库：`docs/database-normalization-and-data-migration-plan.md`、`docs/database-table-migration-matrix.md`。
- 交易：`docs/trade-execution-state-machine.md`。
- Bridge：`docs/bridge-v4-win7-architecture-and-packaging-plan.md`、`docs/bridge-connection-quota-and-account-subscription-model.md`。
- 文档与当前源码冲突时不得自行猜测。先核实最近阶段验收记录、迁移和调用链；安全或数据语义仍不明确时停止实施并向用户说明。

## 3. 安装、验证与本地运行

```powershell
pnpm install
pnpm run dev:www
pnpm run dev:trade
pnpm run dev:admin
pnpm run dev:auth
pnpm run verify:frontend-boundaries
pnpm run test:frontend
pnpm run typecheck:frontend
pnpm run build:frontend
pnpm exec vitest run server/tests
pnpm run typecheck:server
pnpm run build:server:v4
pnpm test
powershell -NoProfile -ExecutionPolicy Bypass -File .\bridge\prototypes\net48-win7\test.ps1
```

- 从最小定向验证开始，按实际影响选择测试、类型检查、构建或视觉检查；只有新增改动、失败或未解决疑点才扩大或重复验证。业务逻辑、权限、并发和数据完整性缺陷应补能复现原因的行为回归；纯文案、间距等低风险改动不写只复述源码的断言，不默认跑全仓测试。
- 只有修改仍在使用的旧 JavaScript、Rust Native 或 MT5 Worker 时，才补充相应 `node --check`、Cargo 或 Python 测试；这些不是 V4 TypeScript/.NET 主链路的替代验证。
- 未经用户明确授权，不启动服务、连接数据库/Redis/Bridge/MT4/MT5、执行迁移、修改运行配置、部署或发布。
- 获准启动或重启本地项目时使用可见 PowerShell 控制台。先检查并释放目标端口，关闭旧承载控制台，启动后检查对应健康端点；禁止用隐藏进程掩盖错误。
- 真实终端交易测试每次都需要用户明确确认测试账户已经就绪。当前或已声明为真实使用账户时，禁止发送下单、挂单、改单、撤单、平仓等指令。

## 4. 编码与模块化

- TypeScript 使用严格模式、两空格缩进、无分号 ESM；变量与函数使用 `camelCase`，类型与类使用 `PascalCase`，模块文件使用 kebab-case。
- 业务域不得跨层取巧：`domain` 不导入 Fastify、Vue、BullMQ、MySQL、Redis 或供应商 SDK；应用服务通过端口调用基础设施；路由和 Worker 只编排用例。
- 修改一个功能模块不得依赖其它模块的内部文件。跨域协作使用明确的应用端口、版本化合同或 outbox 事件。
- 前后端采用同一模块化验收标准，适用于现有重构及所有后续新增功能：每个业务模块明确职责、公开入口、依赖方向、数据所有权和测试入口；页面、路由与运行入口只负责组装。按文件夹拆分不等于完成模块化。
- 模块公开业务端口与运行组装接口必须区分；跨域业务代码不得通过 barrel 导出间接取得其它域的 repository、SDK 或具体基础设施。前端同一应用内的功能模块也必须遵守公开入口约束，不能只检查四个应用之间的隔离。
- 新模块验收必须包含依赖边界检查和 API 生产者/消费者合同验证；现有未收口项见 `docs/backend-api-modularity-audit-20260908.md`。在自动检查补齐前逐项人工核对，不得把该规则已写入文档表述为自动门禁已实现。
- `verify:server-boundary-delta` 已接入服务端类型检查及构建，拒绝新增或陈旧的已检测越界记录；存量债务位于 `docs/architecture/server-boundary-debt.json`。修复对应依赖后同时删除精确记录；禁止自动重建基线、用通配符或删除一条来抵消新越界。该增量门禁不代表存量清零或扫描范围完整。
- `verify:frontend-boundary-delta` 每次先prepare主站Nuxt声明，再扫描前端精确依赖；已接入现有前端边界检查以及测试、构建、类型检查入口。存量位于 `docs/architecture/frontend-boundary-debt.json`，禁止新增、扩大或保留陈旧例外；跨应用/共享包反向依赖不得加入豁免。Nuxt server隐式依赖及动态组件覆盖仍需补齐，不把增量通过等同完整前端架构验收。
- 禁止新增巨型 View、巨型路由、巨型 repository、通用万能 RPC 或混合多个领域含义的状态枚举。复杂页面和用例按稳定业务职责拆分。
- 错误码使用稳定英文机器码；用户可见文案使用自然中文，不直接暴露堆栈、SQL、凭据或内部错误正文。
- 仓库没有统一自动格式化器时，修改必须匹配相邻代码，并通过 `git diff --check`。

## 5. 前端硬规则

- `www`、`trade`、`admin`、`auth` 的生产目标是独立部署应用，对应 `www.<domain>`、`trade.<domain>`、`admin.<domain>`、`auth.<domain>`。本地路径只用于开发代理，不得反向定义生产路由。
- `www` 使用 Nuxt 4 混合渲染；`trade`、`admin`、`auth` 使用 Vue 3 + Vite。全部使用 TypeScript、Composition API、Tailwind CSS 4、shadcn-vue（Reka UI）和 Lucide 图标。
- 通用控件优先组合 `frontend/packages/ui` 中已经批准的 shadcn-vue 组件。新增组件先查官方 shadcn-vue 文档并使用其 CLI；禁止引入第二套通用 UI 库，也禁止重复手写已有 Button、Dialog、Drawer、Select、Tabs、Table、Form 等基础控件。
- 设计、重构或审查页面时必须使用 `ui-ux-pro-max` 形成布局、层级、响应式和可访问性判断；实现阶段仍以项目 shadcn-vue 组件与设计令牌为准，不得让 Skill 生成物绕过组件边界。
- 共享 UI 包只包含无业务含义的基础组件与令牌。页面、API 调用、Query、Pinia store、路由和业务组件归所属应用；修改共享包先确认实际消费者并定向验证。公共导出、全局令牌、构建配置等跨应用变更需验证四个应用的相关类型、构建或视觉行为，不把每次局部修复扩展成四应用全量测试。
- 每个应用原生实现自己的账户与设置体验，禁止 iframe 嵌入通用用户中心、跨应用共享整页业务组件或用 `postMessage` 同步身份。
- 身份中心统一认证，但每个应用只建立自己的 Host-only、Secure、HttpOnly 会话；禁止父域共享 Cookie、浏览器长期 JWT、跨应用复制 Token 或把身份凭据放入 URL/本地存储。
- 页面首次和重连使用 HTTP 一致快照；真正需要秒级更新的账户指标、报价、当前 K 线、持仓、挂单和任务状态使用统一 realtime client。历史、列表、详情、筛选、配置和全部浏览器写操作走 HTTP，组件不得直接创建 WebSocket 或把 WebSocket 当 RPC。
- 账户切换是正常高频操作，不得人为限制。所有 Query key、缓存、实时订阅、表单和操作必须显式带账户作用域并防止串号。
- 设计面向普通外汇交易者：重点结论优先、渐进披露、状态可解释、危险操作二次确认。桌面、平板和手机均需验收，无横向溢出；交互目标、键盘焦点、非颜色状态表达和 `prefers-reduced-motion` 至少满足 WCAG 2.1 AA。

## 6. API、实时与后台任务

- 新接口统一使用 `/api/v4`。浏览器写操作必须有认证、授权、CSRF、幂等键、并发版本和审计；禁止为 V4 新增 `/api`、`/aurum-api` 或浏览器 WebSocket RPC 兼容入口。
- V4 是模块化单体：Fastify HTTP API、浏览器实时网关、Bridge 设备网关、调度器、Outbox Dispatcher 和各 Worker 为独立 PM2 角色，统一由根目录 `ecosystem.v4.config.cjs` 管理。宝塔只建立一个 Node/PM2 项目，实例数保持 1，禁止在启动入口自动迁移数据库。
- HTTP API 和浏览器实时网关不得启动业务定时器、数据库轮询或任务消费者。调度器只登记到期工作；Worker 执行业务用例；MySQL 是业务权威，BullMQ 只携稳定 ID 并负责投递/唤醒。
- Bridge Gateway 只允许消费必须访问本进程当前 WebSocket route 的 `bridge command` 与只读 `bridge history query` 队列；不得承担调度、AI、风控、复盘或其它后台任务。该例外依赖单实例 Gateway，扩容前必须先设计 route-aware 定向投递。
- 关键副作用采用“短业务事务 + MySQL outbox + 确定性 job ID + 幂等消费者”。外部模型、邮件、短信、链上、存储和 Bridge I/O 必须在数据库事务外。
- 浏览器 WebSocket 只推送小型增量或失效事件；大正文、历史和原始证据通过 HTTP 回读。断线、sequence 缺口、账户切换和权限变化时必须重拉权威快照。
- `AURUM_V4_RUNTIME_ENABLED` 默认保持关闭。离线测试通过不等于 MySQL、Redis/BullMQ、PM2、HTTPS/WSS、公网或长稳运行已验证。

## 7. 数据库与迁移

- 新代码统一使用 UTC 数据库会话与 `DATETIME(3)`；金额、价格、手数使用明确精度的 `DECIMAL` 或定点文本，禁止用浮点数承担财务真相。
- 路由、WebSocket 处理器和前端 BFF 禁止直接写 SQL；统一通过所属域 repository。新查询禁止 `SELECT *`，列表禁止读取无关大字段，并使用稳定键游标而不是大 OFFSET。
- SQL 使用参数占位符；动态标识符只能来自代码内白名单。事务遵守固定锁序、保持短小，不把网络或模型调用放入事务。只有完整幂等事务可以对死锁做有上限退避重试。
- 公网仍可能运行旧结构。迁移必须保留版本识别、checksum、checkpoint、legacy ID 映射、逐用户/账户计数与金额对账，以及可验证回滚路径。
- 迁移文件一经在任何共享环境执行，禁止修改、删除、重排、合并或压缩，只能追加纠正迁移。
- 未经用户明确授权，禁止执行 DDL/DML、真实回填、切换读写、清理旧表或删除用户数据。旧表只有通过备份恢复、代码引用、双读、逐项对账和用户确认的独立删除门后才能删除。

## 8. AI、风控与交易安全

- AI 分析师只负责市场分析、宏观判断、走势和机会识别；有机会时触发账户级 AI 交易员。AI 交易员结合账户、持仓、挂单和分析结果提出账户动作；确定性服务端风控独立审核。
- 策略分为分析策略和交易执行策略。服务端只提供客观数据、通用合同和工具，禁止针对策略 ID、名称或当前策略内容增加专属入场规则、指标权重或结论改写。
- 自动信号、人工交易、订阅者分发、分发平仓、持仓管理和管理员交易全部进入统一 `execution` 域，经过 operation、intent、risk decision、Bridge command 和 terminal outcome 状态链。
- 任何可能已送达终端但结果未知的命令必须标记 `uncertain` 并精确对账，禁止当作失败普通重放。Bridge accepted 或 command success 不能单独证明成交。
- 终端交易记录按账户、ticket/order/deal 精确归因；无法精确匹配系统、人工、其它 EA 或混合来源时保持 `unknown/unresolved`，禁止按品种、时间接近或备注猜测。
- 风控限制由服务端硬规则执行；手动放开也必须审计并重新校验不可绕过的平台停机、账户暂停、数据/时钟完整性和平台硬上限。
- 日/月/手动复盘使用冻结的账户、策略、订阅、时区、分析、风控、执行和终端证据。记忆更新必须人工确认；系统不得自动改写策略。

## 9. Bridge V4 边界

- Bridge 只发现用户已启动的 MT4/MT5，提供数据、维护可重建 SQLite 投影、执行服务端确定性命令并回传成功、失败、终端原始结果或 `uncertain`。不得自动启动、关闭、登录或改变终端账户。
- 连接额度、会员、策略、风险、允许品种、交易时段、仓位和业务权限全部由服务端控制。Bridge 只保留消息完整性、账户/终端/epoch、deadline、幂等和精确目标校验。
- 每个档案、Worker、SQLite 和 WebSocket 只服务一个账户；用户可新增、删除和更换档案，并按购买额度并行连接。删除本地档案不得删除服务器交易账户、历史归属或交易证据。
- MT4 使用精简 EA；MT5 使用固定、验签的 Python 3.8 x64 runtime、NumPy 和官方 MetaTrader5 Worker，不安装 MT5 EA，不依赖系统 Python 或联网装包。
- K 线、历史订单、历史成交和资金事件按档案有界分页缓存到 SQLite；报价、心跳和未收 K 线只保存在内存。缓存清理只能删除达到保留期且已确认可重建的数据。
- 跨系统排序和比较使用 UTC；交易业务时间使用对应 terminal instance + broker server + login 的可信终端时区。时区不可信时失败关闭，不得回退到固定 UTC+3、北京时间或用户级共享偏移。
- V3→V4 更新必须保留稳定原生 Launcher、P-256 清单/包签名、SHA-256、大小校验、原子切换、健康检查和 previous 回滚。未签 Authenticode 安装器不豁免应用层签名。

## 10. 工作流、提交与授权

- 阶段按一个可验收的用户流程划分。真正进入新阶段前说明范围、预期产物与授权边界并等待确认；同一已授权流程内的合同细化、实现、修复和必要验证持续推进，不为内部工作包重复确认。提交是保存进度，不是停工条件；完成目标、实际阻塞或需要新增授权时才结束当前工作。用户补充要求应归入当前范围或后续路线图，不悄悄扩大权限。
- 架构、迁移、身份权限、交易执行或重大跨模块正式方案，在执行前完成两轮不同侧重点复审并记录调整和剩余风险：第一轮检查需求覆盖、职责与过度设计；第二轮检查兼容、数据、并发、异常、安全、验证与回滚。已批准方案内的普通修复做定向复核；没有新风险或设计变化时不重复两轮正式流程。
- 工作区已有改动属于用户。修改前检查状态，提交前只暂存当前任务文件或区块；禁止覆盖、回退或顺带提交无关改动。
- 完成有文件变更的任务并通过相应验证后，创建单一职责 Conventional Commit，并推送 Gitee 当前 `dev_vue` 分支。测试失败、远端分叉、权限缺失或无法安全拆分时停止提交，禁止强推。
- “实现”不等于授权迁移、部署、重启、发布、上传、切流或真实交易。网站部署、Bridge 构建、安装器发布、七牛上传和更新清单激活是彼此独立的授权边界。
- 只读诊断不修改外部状态。删除、迁移、生产修复和交易动作必须精确确认目标，并按对应 Skill/运行手册执行。
- 验收报告必须区分源码、Mock、离线测试、本地真实依赖、真实终端、测试账户交易和公网生产证据；不得把低一级证据表述为高一级结论。

## 11. 旧版清理门

- 旧前端不得重新进入 V4。确认功能覆盖后直接删除旧业务页面；迁移文件、旧版本识别、legacy ID 映射、回填和对账工具永久保留为升级历史。
- 旧 API、Bridge V3 和旧数据库结构只有在 V4 完整功能、数据迁移、真实依赖、终端、回滚和公网验收后，才能进入阶段 17 的逐项删除门。
- 临时调试结论、某次测试账号、一次性端口或短期故障不得写入本文件；应写入对应阶段报告或运维记录。
