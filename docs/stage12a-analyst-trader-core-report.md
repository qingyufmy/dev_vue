# 阶段 12A：分析师与账户级交易员核心验收记录

> 日期：2026-09-03
>
> 状态：实现完成，离线验证完成；数据库迁移、模型调用、队列运行和真实交易均未执行

## 1. 本阶段结果

本阶段只建立 AI 交易实验室最核心的业务分层：

```text
系统用户的市场分析 market_analysis
  → 按有效订阅为每个交易账户建立独立 trader run
  → 账户级动作建议 trade_decision
  → 后续确定性风控
  → 后续统一 execution_intent
```

已经确认并固化：

- 策略只有 `analysis`（行情分析）和 `trader`（交易执行策略）两类；`trader` 只是账户动作规划者，不拥有执行权限。
- 分析记录按系统用户归类，不按 MT4/MT5 账户分类。行情来源账户只会进入冻结输入证据。
- 同一份有效分析可以按订阅扇出到多个交易账户，但每个账户拥有独立交易员任务、输入快照和决定。
- 手动分析只生成分析结果，不自动扇出；用户必须显式把仍有效的分析提交给当前账户评估。
- 风控仍是服务端确定性参数；本阶段没有第三次 AI，也没有从推理模块直接调用 Bridge 或创建执行意图。

## 2. 合同变化

HTTP V4 新增或重塑：

- `GET /strategies?kind=analysis|trader`
- `POST /analysis-jobs`
- `GET /market-analyses`
- `GET /market-analyses/{analysis_id}`
- `POST /market-analyses/{analysis_id}/trader-evaluations`
- `GET /trade-decisions?account_id=...`
- `GET /trade-decisions/{decision_id}`

旧 V4 草案中的 `/signals` 和混合 `SignalSummary` 已退出合同。手动分析请求不再接受 `auto_execute`。

浏览器实时协议只传小型增量：

- `analysis.job.changed`
- `market_analysis.created`
- `trader.job.changed`
- `trade_decision.created`

完整推理正文、完整账户上下文、K 线历史和提示词不进入 WebSocket，通过 HTTP 详情恢复。

## 3. 服务端边界

新增 `strategies` 与 `inference` 两个模块：

- domain 负责稳定名称、输入快照、置信度、动作合同和显式上下文限制；
- application 负责手动分析、分析完成、账户评估和交易员结果用例；
- infrastructure 负责 MySQL 事务、不可变载荷、账户级扇出和 outbox；
- transport 只负责认证、合同字段、幂等键和 HTTP DTO。

冻结快照不允许 `conversation_id`、`previous_response_id`、`thread_id`、`chat_history` 或供应商消息历史。快照使用确定性 JSON 排序和 SHA-256，因此同一显式输入可以复现。

手动分析 3 分钟节流在数据库中按系统用户原子加锁。相同幂等键先返回既有任务，不重复推进节流时间。账户评估同时冻结订阅 ID、订阅 revision、交易账户、分析内容哈希和交易策略版本。

## 4. 数据库迁移

新增迁移：`server/db/migrations/20260903_004_ai_strategy_and_inference_core.sql`。

迁移建立：

- `strategies`、`strategy_versions`；
- `strategy_subscriptions`、`subscription_schedules`；
- `inference_snapshots`、`inference_snapshot_payloads`；
- `ai_model_tasks`、`ai_model_attempts`；
- `ai_analysis_runs`、`ai_manual_analysis_cooldowns`；
- `market_analyses`、`market_analysis_payloads`；
- `ai_trader_runs`、`trade_decisions`、`trade_decision_payloads`；
- 通用 `outbox_events`。

迁移只允许用于空的 V4 旁路数据库，本阶段没有执行。旧数据通过 `legacy_source_table + legacy_id` 保留来源；旧 `ai_signals.user_id=0` 必须在后续回填中映射为 `owner_scope='platform' + owner_user_id=NULL`，不得伪造用户 0。回填仍必须由发布迁移 runner 以不超过 500 行的 checkpoint 批次执行并逐用户对账；未完成删除门前不删除旧表或旧列。

## 5. 验证结果

- Stage 12A 服务端定向测试：8 项通过。
- 共享前端合同测试：6 项通过。
- 服务端 TypeScript 严格类型检查：通过。
- 全前端测试：通过。
- 全前端类型检查：通过。
- 全前端生产构建：通过。
- 根测试：在修正当前进程继承给 Windows PowerShell 的模块搜索路径后通过；原始环境会使两个既有 Bridge 发布工具测试找不到系统 `Get-FileHash`，本阶段未修改 Bridge 代码。
- JSON 合同解析、前端应用边界和 `git diff --check`：通过。

## 6. 未完成与下一步

本阶段没有：

- 执行任何数据库迁移或旧数据回填；
- 调用真实模型；
- 启动 scheduler、analysis Worker 或 trader Worker；
- 接入确定性风控或统一 execution 状态机；
- 调用 Bridge，执行下单、挂单、改单、撤单或平仓；
- 宣称真实 MySQL、Redis、多账户或 MT4/MT5 已验收。

下一子阶段 12B 接入分析 Worker 与调度扇出：冻结真实行情和宏观快照、五分钟调度去重、model task/attempt、latest-wins 和账户目标冻结。它仍不连接 Bridge，也不执行真实交易。
