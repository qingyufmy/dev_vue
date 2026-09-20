# dev_vue 开发交接（2026-09-20）

> 本文件用于下一会话接管 `D:\dev_codex\dev_vue`。以当前源码、当前 Git 状态和本文件记录为准；旧交接文件只保留历史背景，不再代表当前工作区状态。

## 1. 当前结论

- 仓库当前分支为 `dev_vue`，工作区在编写本文件前为干净状态。
- 本轮前端、V4 服务、统一运行入口、订单执行链路、通知设置和首页缠论图已经完成一轮集中开发，主要改动均已提交并推送到 `origin/dev_vue`。
- 首页缠论的关键计算问题已经修复：失效候选段会从破坏点重新锚定，结构按实际请求周期计算，形成中结构会连接最新已收盘 K 线，已确认历史结构不会被回写篡改。
- 当前本机 `full` 运行模式已启动 16 个角色，但不能认定交易链路可用：桥接网关和风控汇总处于“运行中/业务异常”。必须先诊断业务异常，再做交易验收。
- 下一会话优先处理桥接容量/查询拥塞、风控汇总数据源异常和 `worker-risk` 连接重置；随后做首页缠论动态更新及通知筛选的端到端验收。

## 2. 仓库与 Git 基线

工作目录：

```text
D:\dev_codex\dev_vue
```

当前分支和本轮交接前的基线提交：

```text
branch: dev_vue
HEAD:   58a7becff6f780ded69d522ae46609c9634b9a36
origin/dev_vue: 58a7becff6f780ded69d522ae46609c9634b9a36
```

本交接文件会在上述基线上形成单独的文档提交。下一会话应先执行：

```powershell
cd D:\dev_codex\dev_vue
git status --short
git branch --show-current
git log -5 --oneline --decorate
```

项目要求每次改动完成后使用单一目的 Conventional Commit，并推送当前 `dev_vue` 分支。不要把 `origin/main` 当作本仓库的同步目标；它目前指向另一条旧版/遗留开发线，未经用户明确要求不要合并或覆盖。

近期重要提交：

| 提交 | 内容 |
| --- | --- |
| `bd812e8f` | 集中落地 V4 核心交易工作区、前端、Bridge、通知、统一运行入口和执行链路 |
| `e2962e11` | 休市时暂停自动分析和自动交易 |
| `31a45fc8` | 优化首页缠论图信息层级 |
| `9da33239` | 修复活动缠论结构长期停留在旧日期的问题 |
| `5257ae2f` | 修复因果确认并按请求周期计算缠论 |
| `aa18327b` | 实时报价更新 K 线、自动重算结构并显示支撑/压力 |
| `4325414a` | 压缩首页图表控制区与参考价展示 |
| `723eade2` | 去掉首页 K 线图背景网格 |
| `8d3d3626` | 鼠标悬停显示对应 K 线时间与 OHLC |
| `58a7becf` | 保留缠论走势标签的关键状态，不再坍缩为泛化方向 |

## 3. 统一运行入口与当前本机状态

统一入口是唯一推荐的常规本地启动方式：

```powershell
powershell -NoProfile -File scripts/local-v4.ps1 check
powershell -NoProfile -File scripts/local-v4.ps1 status
powershell -NoProfile -File scripts/local-v4.ps1 stop
powershell -NoProfile -File scripts/local-v4.ps1 start
```

详细说明见：

- [`docs/local-service-startup.md`](./local-service-startup.md)
- [`docs/local-v4-runtime.md`](./local-v4-runtime.md)

`full` 模式当前管理 16 个角色：API、网页实时推送、桥接网关、公共行情、消息分发、历史同步、风控汇总、AI 分析、AI 交易评估、分析调度、登录页面、交易页面、逐笔风控、订单执行、执行恢复调度和复盘。

2026-09-20 本次交接前执行 `scripts/local-v4.ps1 status` 的结果：

| 状态 | 服务 |
| --- | --- |
| 就绪/可访问 | API、网页实时推送、公共行情、消息分发、历史同步、AI 分析、AI 交易评估、分析调度、登录页面、交易页面、逐笔风控、订单执行、执行恢复调度、复盘 |
| 运行中/业务异常 | 桥接网关、风控汇总 |

控制脚本明确报告：交易执行链路尚未就绪，原因是桥接网关业务异常。账户开关开启或端口健康不代表后台可以执行交易。

本地运行状态和分角色日志位于：

```text
D:\dev_codex\.local-runtime\dev-vue\unified\
```

不要输出、提交或分享其中的 `controller.json`，里面包含当前控制令牌。

当前日志证据：

- `bridge-gateway.log` 持续出现 `bridge_query_inflight`；本轮运行历史中也出现过 `bridge_capacity_exceeded`。
- `worker-risk-summary.log` 当前重复出现 `risk_summary_source_unavailable`，也出现过 `risk_storage_unavailable`。
- `worker-risk.log` 出现重复 `ECONNRESET`。
- `/health/ready` 返回 200 只证明进程/端口健康，不能替代 Bridge 会话、行情读取、风控和订单业务验收。

下一会话先读日志定位根因，不要靠反复重启掩盖问题。需要重启时，用统一入口，并在显式 PowerShell 控制台中运行。

## 4. 本轮已完成的开发

### 4.1 首页行情与缠论图

已完成：

- 首页 K 线图高度随右侧“最新 AI 分析”卡片区域自适应，减少下方空白。
- 实时报价会更新当前 K 线；收盘或历史修正后触发缠论结构重算。
- 图表默认展示分型，并展示笔、段、中枢、走势以及最新参考支撑/压力。
- 支撑/压力取最新分型和段/笔中枢的结构参考，属于行情辅助展示，不直接替代策略或风控结论。
- 去除图表背景网格，压缩结构控制和参考价信息层级。
- 鼠标在 K 线或空白处移动时，右侧价格轴显示鼠标位置价格；左上角显示当前悬停 K 线的时间、开盘、最高、最低和收盘。
- 走势标签保留“形成中/已确认”等关键状态。
- 休市时首页会显示历史快照；开市后的实时报价联动仍需做一次连续观察验收。

主要文件：

- [`frontend/apps/trade/src/features/home/MarketWorkspaceCard.vue`](../frontend/apps/trade/src/features/home/MarketWorkspaceCard.vue)
- [`frontend/apps/trade/src/features/home/TradingChart.vue`](../frontend/apps/trade/src/features/home/TradingChart.vue)
- [`frontend/apps/trade/src/features/home/chan-trend-presentation.ts`](../frontend/apps/trade/src/features/home/chan-trend-presentation.ts)
- [`server/src/modules/market/application/public-market-snapshot.ts`](../server/src/modules/market/application/public-market-snapshot.ts)
- [`server/src/modules/market/application/public-chan-chart.ts`](../server/src/modules/market/application/public-chan-chart.ts)

### 4.2 缠论计算修复

已修复的核心问题：失效候选段以前不会重新锚定，导致笔持续更新，但段、中枢和走势长期停留在旧行情。现在从破坏旧候选段的第一笔重新计算活动候选，同时保留已确认历史段作为历史证据。

周期规则已经改为按调用方实际请求的周期计算：

- 首页选择什么周期，就计算什么周期。
- 策略使用 `plan.timeframes` 中声明的周期，不再写死 M5。
- M1、M5、M15、M30、H1、H4、D1 已覆盖；引擎允许合法的通用周期。
- 只用于 EMA 等指标的周期不会无条件额外计算缠论。

因果确认约束：

- 已确认分型、笔、段不得使用未来 K 线改写过去的确认时间。
- 已确认段不因后续同起点延伸而改写终点。
- 形成中结构允许随着最新已收盘 K 线更新。
- 实时报价只能更新当前蜡烛，确认类结构要在收盘/历史修正后重算。

专项证据见：

- [`docs/chan-causal-confirmation-repair-20260920.md`](./chan-causal-confirmation-repair-20260920.md)
- [`docs/home-chan-live-levels-20260920.md`](./home-chan-live-levels-20260920.md)

已记录的验证结果：1704 个点的前后重放中，确认时间漂移从 73 降为 0，同起点已确认段终点回写从 1 降为 0，固定左边界 H4 已确认段撤销从 1 降为 0；6 组 33 个定向测试和 27 个外部重放边界检查通过。

外部复测产物：

```text
D:\dev_codex\aurum-local-backtest\artifacts\2026-09-20-chan-fix-review\
D:\dev_codex\aurum-local-backtest\artifacts\2026-09-20-chan-special-audit\
```

主要实现：

- [`server/src/modules/market/domain/chan-v8/segments.ts`](../server/src/modules/market/domain/chan-v8/segments.ts)
- [`server/src/modules/market/domain/chan-v8/compute-window.ts`](../server/src/modules/market/domain/chan-v8/compute-window.ts)

不要再次把候选段简化成只保留旧候选，也不要为了让图形“看起来更新”而改写已经确认的历史结构。

### 4.3 AI 分析师、AI 交易员与首页 AI 卡片

已完成：

- AI 分析师定位为纯行情分析，界面移除了入场、止盈、止损等执行信息。
- “市场方向倾向”明确表示方向分布，不表示置信度。
- 分析结论、方向倾向、关键依据和市场风险重新分层，去掉右侧列表已有的重复策略/时间信息。
- AI 交易员决策区重新设计为更直观的账户决策展示。
- 分析记录和决策记录：用户当前选中第一条时，新记录到来会自动跟随最新；用户查看旧记录时不会抢焦点。
- 首页“最新 AI 分析”卡片增加市场方向倾向，压缩重复的“偏多/偏空”文字。
- AI 交易员账户和浮动盈亏已接入实时刷新方向，仍建议在开市时做长时间观察，确认不会停止更新。

### 4.4 持仓、手动下单和止盈止损

已完成或已经调整：

- 持仓不再要求归属于某一条策略；当前账户的持仓只要品种符合策略品种即可参与管理。
- 修复了修改止盈止损时因页面快照更新导致持续 `user_command_expected_state_stale` 的问题，并保留用户输入进行重新确认。
- 移除了“移除止盈/止损”开关，空值保留原值。
- 操作提交后进入服务端异步执行链路，页面通过执行记录展示最终结果。
- `full` 统一入口已包含订单执行、执行恢复和复盘角色。

仍需注意：用户曾看到手动下单“未获通过”以及账户/持仓状态更新错误。下一会话要根据新的操作 ID 追踪模型任务、风险判断、执行意图、Bridge 账本和结果，不要直接放宽或绕过风险规则。

[`docs/modification-log.md`](./modification-log.md) 中部分旧修改记录声称手动 `user_command` 可以跳过风控，这不是当前可直接接受的执行策略。确定性风控仍应拥有最终执行权；任何进一步调整都要先核对当前源码和业务证据。

### 4.5 个人设置、通知和交互组件

已完成：

- 顶栏增加站内信图标和未读红色数字。
- 站内消息增加“全部已读”；此前接口失败后已修复，仍需要用当前账号再做一次端到端验证。
- 顶栏增加深浅色切换。
- 个人设置采用较大的 Dialog 交互，支持个人资料、通知偏好和不同消息类型的网页声音提醒。
- 通知渠道已实现飞书机器人和邮件配置。
- 分析记录、决策记录支持“全部推送”和“仅有效信息”；用户曾反馈仅有效筛选没有生效，代码已调整，但还需要用新产生的有效/无效记录分别验证。
- 分析记录和决策记录可以设置不同提示音并预览。

组件使用原则已经确定：

- 集中编辑和大块设置使用 Dialog。
- 高风险二次确认使用 AlertDialog。
- 就近、轻量操作使用 Popover。
- 短反馈使用 Alert 或 Sonner。
- 只有需要保留主页面上下文、展示较长侧栏详情时才使用 Sheet。
- 避免嵌套 Dialog，也不要把所有详情与确认都做成抽屉。

相关目录：

- [`frontend/apps/trade/src/features/personal`](../frontend/apps/trade/src/features/personal)
- [`server/src/modules/notifications`](../server/src/modules/notifications)
- [`server/src/entrypoints/worker-notifications.ts`](../server/src/entrypoints/worker-notifications.ts)

当前集成缺口：独立的 `worker-notifications.ts` 已存在，但统一入口目前运行的是 outbox dispatcher，没有为独立通知 worker 建立单独健康角色。下一会话先确认两者职责是否已合并；若没有，再把通知 worker 纳入 `full`，避免重复消费同一 outbox。

### 4.6 其他已完成调整

- 导航中的“市场分析/宏观研究”已移除，`/market` 兼容路由重定向首页；旧后端表或可选推理证据可能仍存在，不代表继续开发宏观研究。
- 休市时自动分析与自动交易暂停；手动分析保持可用。实现见 [`server/src/modules/market/application/automatic-market-session-gate.ts`](../server/src/modules/market/application/automatic-market-session-gate.ts)。
- 本地 Bridge 从源码和统一入口的启动方式已经写入运行文档。Bridge 不负责启动或关闭 MT5 终端。
- 管理员到期时间和 Bridge 连接额度曾做过调整，但当前日志仍出现容量相关拒绝，不能据此宣称额度问题已经解决。

## 5. 已知限制和未完成验收

1. **Bridge 业务异常**：当前最优先。排查连接额度、重复 Bridge 实例、会话释放、查询并发和管理员无限期配置的实际生效路径。
2. **风控汇总异常**：确认 `risk_summary_source_unavailable` / `risk_storage_unavailable` 的上游数据源、账号映射和存储连接。
3. **逐笔风控连接重置**：定位 `worker-risk` 的 `ECONNRESET` 对应服务和重连策略。
4. **订单业务链路**：进程就绪不等于可交易。修复上述异常后再用测试账户做业务验收；未经用户在下一会话明确授权，不发送真实订单。
5. **首页缠论实时更新**：当前最后一次视觉检查处于休市状态，需要在开市时连续观察当前 K 线、收盘切换、形成中段、中枢、走势和支撑/压力是否同步更新。
6. **首页最新样式**：`58a7becf` 后需要再做一次浏览器视觉检查，确认走势标签完整且信息密度合适。
7. **通知端到端**：分别生成有效/无效分析与决策，验证“仅有效信息”、站内未读、全部已读、网页声音、飞书和邮件。
8. **AI 交易员浮动盈亏**：在开市期间观察秒级更新的长期稳定性。
9. **类型检查边界**：本轮缠论相关构建和定向测试通过；完整 `server` TypeScript 检查仍会遇到仓库既有测试类型错误，不要写成“全仓类型检查已通过”。

## 6. 下一会话建议接管顺序

### 第一步：确认基线，不改代码

```powershell
cd D:\dev_codex\dev_vue
Get-Content AGENTS.md
Get-Content docs\handoff-dev-vue-2026-09-20.md
git status --short
git branch --show-current
git rev-parse HEAD
powershell -NoProfile -File scripts/local-v4.ps1 status
```

### 第二步：诊断当前业务异常

优先读取：

```text
D:\dev_codex\.local-runtime\dev-vue\unified\bridge-gateway.log
D:\dev_codex\.local-runtime\dev-vue\unified\worker-risk-summary.log
D:\dev_codex\.local-runtime\dev-vue\unified\worker-risk.log
D:\dev_codex\.local-runtime\dev-vue\unified\worker-execution.log
```

先建立以下链路证据：当前 Bridge 客户端数量和身份、连接额度来源、会话是否释放、哪个请求长期占用 `bridge_query_inflight`、风险汇总读取哪个账号/存储、`ECONNRESET` 的对端是谁。只有确认根因后再修改或重启。

### 第三步：浏览器验收

按顺序检查：

1. 首页 K 线悬停信息、鼠标价、默认分型、笔/段/中枢/走势、支撑/压力、走势状态标签。
2. 开市时实时报价与当前 K 线联动，收盘后结构重算。
3. AI 分析师/AI 交易员新记录到来时的焦点跟随规则。
4. AI 交易员浮动盈亏秒级更新。
5. 通知“仅有效信息”、全部已读、声音、飞书和邮件。

### 第四步：继续新开发

在业务异常和已有功能验收有明确结论后，再按用户下一条需求继续。每次改动完成后运行与范围相称的测试、`git diff --check`、单一目的提交并推送 `dev_vue`。

## 7. 不能跨越的边界

- 不把端口健康、页面可访问、开关开启当作交易业务就绪。
- 不为了解决手动操作失败而绕过确定性风控。
- 不在缺少当前授权时发真实订单、改真实持仓或修改真实账户保护价。
- 不提交 `.env`、控制令牌、邮箱凭据、飞书 webhook 等密钥。
- 不清理或覆盖与当前任务无关的用户文件。
- 不把外部旧仓库的缠论提交再次 cherry-pick 到 `dev_vue`；本仓库已经有自己的 V4 修复。
- 不直接把 `dev_vue` 推到 `main`，除非用户明确要求分支晋升。

## 8. 下一会话可直接使用的接管提示

```text
接管 D:\dev_codex\dev_vue。先阅读 AGENTS.md 和 docs/handoff-dev-vue-2026-09-20.md，核对 dev_vue 分支、HEAD、工作区和 scripts/local-v4.ps1 status。当前最优先是只读诊断 bridge-gateway 的 bridge_query_inflight / bridge_capacity_exceeded、worker-risk-summary 的 source/storage unavailable，以及 worker-risk 的 ECONNRESET；不要用健康接口代替业务验收，也不要发送真实订单。根因明确后再修复，并完成相称测试、git diff --check、Conventional Commit 和推送 origin/dev_vue。随后按交接清单验收首页缠论动态更新、通知仅有效筛选和 AI 交易员浮动盈亏。
```
