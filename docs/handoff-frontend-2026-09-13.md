# 前端重构接手文档

日期：2026-09-13。工作目录：`D:\dev_codex\dev_vue`，当前分支：`dev_vue`。

## 1. 用户最新决定：下一会话开始前端

用户原话：“做一下交接文件，我会让下一个会话开始做前端”。本会话在此交接，不继续扩展后端策略语义工作。下一会话收到开工指令后，应进入前端设计、实现和逐功能验证。

后端模块化、数据库兼容升级及 API 主体已有可用基础。**不把旧策略完整运行等价、真实终端交易、可信休市区间或公网验收变成前端开工条件。** 某页面需要的后端能力有缺口时，按该功能补齐并验证；不要再次启动全库优化、全后端审计或无止境的策略细化。

用户长期要求：前后端及未来新增功能完全模块化；先完成核心需求，细节在前端和 Bridge 实际功能验收时解决；本地开发和测试，MySQL/Redis 使用虚拟机；当前开发不涉及公网。

## 2. 最先阅读的文件

按此顺序读取当前文件，不必通读全部历史阶段报告：

1. [仓库强制规则](../AGENTS.md)。当前指令和本次交接的范围优先于历史阶段“下一步”文字。
2. [产品范围](../PRODUCT.md)、[设计定义](../DESIGN.md)、[设计系统](../design-system/aurum-v4/MASTER.md)，以及对应应用的 `design-system/aurum-v4/pages/` 文档。
3. [前端规范](vue-frontend-requirements-standard.md)、[认证与子域](single-sign-on-authentication-architecture.md)。较早文档仅写三个前端时，以当前四应用 www/trade/admin/auth 为准。
4. [实验室功能盘点](ai-trading-lab-frontend-function-inventory.md)、[管理后台功能盘点](admin-function-inventory.md)、[全项目功能矩阵](full-project-function-migration-matrix.md)。这些是覆盖检查输入，不代表页面已验收。
5. [API 与实时协议](api-v4-and-realtime-protocol.md)、`contracts/http/manifest.json`、`contracts/http/domains/`，并查看当前消费者实现。
6. 有具体后端问题时再查 [核心包最新进度](backend-packages-1-2-progress-20260912.md)。顶部 2026-09-13 更新优先；下方历史“未完成”可能已关闭。

用户曾提供的方案比较输入：`D:\dev_workbuddy\.workbuddy\output\delivery\主方案概览.md`。本次交接未重新读取它，不把它当作未经核实的当前状态证明；不需要仅因换会话重新做一次总体方案比较。

## 3. 环境、启动和数据边界

| 项目 | 当前配置或证据 |
|---|---|
| 应用/Worker/测试 | 在 Windows 本地运行 |
| MySQL | `server/.env`：`MYSQL_HOST=192.168.1.254`，`MYSQL_DATABASE=dev_vue` |
| Redis | `REDIS_HOST`、`QUEUE_REDIS_HOST` 均为 `192.168.1.254` |
| 虚拟机 SSH | 既有别名 `aurum-vm`；本阶段无需为前端部署虚拟机应用 |
| 数据库身份 | 既有升级证据 UUID：`ac423207-6ef3-11f1-b302-000c29fda104` |
| 数据库版本 | 最新已执行证明：267 步、315 张表；执行 readiness 267 步/73 张所需表 |
| V4 HTTP/实时 | trade/auth 当前开发代理默认 HTTP `127.0.0.1:3010`；trade 实时代理默认 `127.0.0.1:3011` |

本交接核对了本地配置和报告，**没有重新登录虚拟机确认服务存活**。进程/端口由下一会话启动前检查，不能把上次验证当成仍在运行。不在 Windows 重新安装 MySQL/Redis，不切回 `192.168.31.254`，不为解决前端问题清空、重建或重置开发库。

最新升级证据：[entry-event-current-v1-20260913.json](architecture/entry-event-current-v1-20260913.json)。追加迁移 079 已应用，原业务数据行数/哈希、旧迁移校验值保持，重跑无 DDL。已执行 SQL 不得修改、重排或压缩；本阶段不用再次执行整套迁移。

现有 `.env` 保存凭据，不在交接、日志或截图中复制密码、令牌。受控备份与完整提示词在 `D:\dev_codex\.backup-core-20260910-01`，不得顺手删除或加入 Git。

启动最小所需进程，避免同时打开所有 Worker。开发服务器按项目规则使用可见控制台；后台辅助工具保持隐藏。真实模型调用、订阅激活、终端交易、迁移和发布有各自边界，前端联调不自动授权这些动作。尤其真实下单/改单/撤单/平仓需要明确测试账户授权。

## 4. 前端实际已有内容

当前已有源码，不是四个空应用；以下仅为本次文件/路由盘点，不是浏览器验收结论。

| 应用 | 技术与本地命令 | 当前起点 |
|---|---|---|
| www | Nuxt 4；`pnpm run dev:www`，3100 | 首页、登录入口、课程列表/详情、法律页面及学习服务端适配 |
| trade | Vue 3 + Vite；`pnpm run dev:trade`，4174 | 已有壳层、认证、概览、市场、Bridge、分析师、交易员、风控师、策略师、复盘师、交易记录、审计模块；模型配置路由仍为占位 |
| admin | Vue 3 + Vite；`pnpm run dev:admin`，4175 | 认证、概览、系统设置有模块；用户、内容、策略、模型、商业、通知、审计等许多路由仍为占位 |
| auth | Vue 3 + Vite；`pnpm run dev:auth`，4176 | 独立身份应用，必须结合 SSO 方案核查完整登录/回跳流程 |

trade 路由：`frontend/apps/trade/src/router/index.ts`；业务归 `src/features/<module>/`，路由通过模块公开入口加载。已有页面可能只是早期功能实现或接缝，先看源码和真实页面，再决定保留、重组或替换，不根据路由存在就勾选完成。

共享包：

- `frontend/packages/ui`：唯一基础组件源，shadcn-vue / Reka UI。
- `frontend/packages/design-tokens`：共享设计令牌。
- `frontend/packages/contracts`：生成类型及运行时校验，含历史归档等新合同。
- `frontend/packages/api-client`：统一 HTTP 访问、会话及错误处理；先找已有方法再加新方法。
- `frontend/packages/realtime`：实时传输基础能力。

必须遵守：四应用独立部署、应用间不共享业务页面/状态；共享 UI 不放业务、SQL、账户逻辑；同应用 feature 之间也只通过公开入口协作。不要新建巨型 View、万能 store 或另一个组件库。不要恢复旧 `public/` 页面或 iframe 用户中心。

设计/重构页面按 AGENTS 使用 `ui-ux-pro-max`；实现 shadcn-vue 组件时使用 `shadcn-vue` 技能和现有令牌。本次只是交接文档，没有重新执行设计技能或变更 UI。

## 5. 可供前端使用的后端基础

- V4 源码：`server/src/modules/`，按 domain/application/infrastructure/transport 划分；启动组装在 bootstrap/entrypoints。模块边界和 outbox 门禁当前通过，不能把扫描通过等同所有业务已经实测。
- 当前 14 个 HTTP 域源、109 项运行合同；`contracts/openapi-v4.json` 由域源生成。前端生成传输类型和运行校验必须同源，不手写一套与后端不同的返回格式。
- 分析→账户交易员→确定性风险→执行状态链、异步任务、复盘与记忆等已有主链实现及不同层级的验证。健康接口成功不证明完整模型调用、真实执行或全部页面可用。
- UTC 持久化及历史保留；已有 Bridge/账户/行情/持仓/历史证据入口。手工仓、旧仓或缺少精确归因的仓位可以返回“未知”，前端不得补造已确认状态。
- 已有个人历史只读 API：`GET /api/v4/history/signals`、`/signals/{legacy_id}`、`/executions`、`/executions/{legacy_id}`、`/executions/{legacy_id}/deals`。api-client 已有归档方法，待按页面体验接入。
- 旧归档使用原用户/账户身份命名空间，`executable=false`。禁止把旧账户 ID 当成 V4 执行账户 ID；`user_id=0` 不是普通个人访问入口。金额、价格、手数和 ticket 按合同保留字符串，未知值保持 null，不转浮点或显示成零。

API 新增/修改要改域源并同步生产者、生成类型和消费者；不直接编辑生成产物。页面遇到接口问题先确认当前路由与客户端，不回到旧 JS 后端新增功能。

## 6. 时间和市场状态：用户已确定，不再反复讨论

- 数据库存 UTC；旧表历史时间直接当 UTC 保留/迁移，用户已接受这一处理。
- AI 交易实验室显示终端时间；其它地方显示北京时间。
- 休市时 MT5 tick/终端行情时间可能不更新。UTC+3 可作为缺失时的显示默认，界面应区分估计与已校准；它不能成为可信交易时钟的替代证据。
- 时区按具体账户/terminal instance/broker/login 读取；切换账户不得复用别人的偏移。
- 市场交易状态只显示“开市”或“休市”，不增加“仅平仓”等市场状态标签。连接故障、数据未知应另行呈现，不能谎报休市。

## 7. 最近后端收尾做到哪里

最近工作的重点是旧策略迁移语义，不是前端开工必须等待的新基础设施：

1. 客观两根收盘突破/收回事件有稳定 ID，原分析输入冻结可重放；交易员引用同一份事件，不由模型造 ID。
2. 事件账本使用账户锁、事务和唯一键去重；风险拒绝释放，批准后保留，未知终端结果不重放。账本覆盖起点以前无记录为 unknown，不等于未使用。
3. 当前账户持仓创建分析通过 `accountPositionEntryEvidence` 提供；参考组合仍独立。创建分析证据不等于成交时行情，不授予管理权限。
4. `risk_budget` v2 已实现按原分析 `marketRegime` 选策略额度；H1/H4 候选默认0.5%、明确 h1_continuation为1%。动作漏填或提高额度不能放宽服务端限制，提交前重验。

最近验证：73项服务端定向测试、13项候选/转换测试通过；服务端类型、构建、模块边界、109项API合同及readiness通过。最后风控改动是源码/模拟端口验证，没有真实终端或真实账户分支风险验证。事件账本更早的真实 MySQL/Redis Worker 证据见 [worker-v3](architecture/entry-event-worker-v3-20260913.json)，行情与模型仍为测试夹具。

最新不可执行候选：

- H1/H4：[v5 报告](architecture/h1-h4-role-prompt-candidate-v5-20260913.json)，源1/version44。
- ATR：[v3 报告](architecture/atr-role-prompt-candidate-v3-20260913.json)，源3/version11。

两者均保留原文，`executable=false`、`semanticAcceptance=pending`；没有修改现有策略版本或启用订阅。不要让前端把“候选生成/编译通过”显示成“已上线策略”。

仍未完成、转入对应功能验收的范围：独立M15机会与M5触发组合、结构保护/目标证据及旧允许事件类型覆盖、分析场景分类等价性、ATR加速语义、可信休市区间、Bridge实机及真实账户端到端验证。它们影响自动交易策略的完整验收，**不阻止登录、页面壳层、行情展示、历史、配置及其它稳定API页面开发**。

原文“同方向独立新事件建议冷却15分钟”仅为建议。此前将其列为强制待实现属于范围误读，已纠正；下一会话不要再添加平台15分钟硬限制。

## 8. 下一会话怎么开始

用户尚未指定第一个应用/页面。建议默认先接手 trade，以已有模块为基础，若用户指定其它页面则服从其顺序。

1. 阅读第2节最小文件集，核查对应应用已有结构、设计和路由；建立简短页面清单：已有可复用、占位、合同缺口、待浏览器验证。不重新做全项目后端审计。
2. 先建立一条可验收用户路径：认证/登录回跳→实验室壳层→账户选择→概览或市场。先看已有实现再补齐；不要仅为了“重构”重写正常模块。
3. 只启动该路径所需本地前端、V4 API；需要实时再加 browser-realtime。先核对现有端口和配置，不启动调度、分析、交易、执行全套后台来验证静态页面。
4. 对当前页面完成真实 API 接入、loading/empty/error、权限拒绝、账户切换、请求竞态/晚返回、实时断线恢复、UTC格式化和响应式检查。无数据就显示真实空态；合成数据只能用于明确标记的测试。
5. 完成一项功能后更新功能矩阵及证据，再推进分析师/交易员/风控/策略/复盘/记录等模块。其它应用按需求推进，不先铺满大量未接通页面。

本节为交接建议，未声称用户已批准某个视觉稿或完成前端验收。下一会话用户的前端开工指令是新阶段范围依据，依 AGENTS 说明本阶段范围；已授权的页面实现、修复和定向验证不反复请求同一确认。

## 9. 常用命令和验收要求

在仓库根执行，先检查现有依赖，不因换会话默认重新安装全部依赖：

```powershell
pnpm run dev:trade
pnpm run dev:auth
pnpm run build:server:v4
pnpm run start:v4:api
# 仅需实时的时候
pnpm run start:v4:realtime

# 选择当前应用做定向验证
pnpm --filter @aurum/trade typecheck
pnpm --filter @aurum/trade test
pnpm --filter @aurum/trade build
pnpm run verify:frontend-boundaries
```

以上服务命令是独立进程，不在一个前台阻塞命令串里依次启动。根 `pnpm start` / `pnpm dev` 仍指旧 `server/index.js`，不要误当 V4 API 启动命令。开发代理端口只是本地约定，不替代生产 www/trade/admin/auth 独立子域方案。

涉及共享组件/令牌的改动验证所有实际受影响应用；API变更补 `generate:api-contract`、`generate:api-types`、`generate:api-runtime` 及对应 verify 命令。不为小改动反复跑全仓测试，但完成相关类型、构建、行为及浏览器验证。本次交接没有重跑前端测试或浏览器审查，下一会话应获取所选应用的新基线。

## 10. 工作区保全和交接复核

本次检查 Git 状态约2223条已修改/未跟踪记录，很多重构成果尚在当前工作区。**交接以现有工作区为准，不能仅凭提交历史恢复。** 不执行 reset、clean、覆盖checkout、整目录删除或把所有文件一把提交。最近后端改动与继承改动互相关联，尚未安全拆分，所以没有提交/推送；后续具备安全范围再遵守 AGENTS 的提交要求。

不要删除迁移历史、映射、回填/对账脚本、当前库证据、受控备份和用户文件。之前创建的事件测试临时库/队列已在相应报告中记录清理，本会话交接未创建运行服务或临时数据库。

复核一（需求/职责）：明确用户切换前端、复用四应用骨架，不把后端策略尾项变成前端前置门槛；保留完全模块化和页面逐功能验收要求。

复核二（证据/兼容）：区分本地配置、已执行数据库报告、源码测试与真实终端证据；记录未激活候选、遗留归档身份和UTC语义；未披露凭据，未运行迁移、删除或部署。本次仅编写交接并更新路线图入口。

## 可复制给下一会话的开工指令

> 读取 D:\dev_codex\dev_vue\docs\handoff-frontend-2026-09-13.md 和项目 AGENTS.md。现在开始前端重构，复用现有四应用与模块化骨架。先检查所选页面现状，再按设计规范实现、接真实API并逐功能验证。默认从trade的认证/壳层/账户选择及概览或市场路径开始；不要继续扩大后端策略语义重构。开发和测试本地运行，MySQL/Redis保持虚拟机192.168.1.254及现有dev_vue数据。
