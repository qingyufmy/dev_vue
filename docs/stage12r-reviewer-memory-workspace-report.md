# 阶段 12R：AI 复盘师与策略记忆工作区验收记录

> 日期：2026-09-04
> 状态：源码实现与离线验证完成；迁移、真实依赖、周期证据生产和实机联调未执行

## 1. 本阶段结果

本阶段建立了统一的 AI 复盘与策略记忆边界，覆盖日复盘、月复盘、手动交易复盘、人工修订与确认、经验候选、长期经验累积、记忆合并和撤销。复盘结论不会直接修改策略、风控或触发交易。

核心边界如下：

- 复盘归属于系统用户；交易账户只用于确定证据范围和终端业务日，不成为用户归档主键。
- 日/月周期 case 冻结账户、品种、分析策略及版本、交易策略及版本、订阅 ID/revision 和终端时区。
- 分析师、交易员、确定性风控、Bridge/终端执行分别评价；事前判断质量与事后盈亏分开。
- 漏单、误报只允许作为确定性证据候选，不能把事后涨跌直接写成“当时必然可识别”。
- 模型结果、用户修改和确认版本均不可变；失败重试复用冻结证据，只有证据 revision 变化才允许重新生成。
- 每条策略只有一个记忆库。分析策略和交易执行策略本身是不同策略，因此自然分库。

## 2. 数据与并发设计

新增迁移 `20260904_012_review_memory_core.sql`，只新增 V4 表，不删除或修改旧复盘/记忆数据：

- `review_cases_v4`、`review_case_sources_v4`、`review_evidence_payloads_v4`：case 摘要、稳定来源引用和大证据载荷分离。
- `review_jobs_v4`、`review_model_attempts_v4`、`review_job_events_v4`：业务 job、provider 尝试和只追加事件分离。
- `review_versions_v4`、`review_version_payloads_v4`：不可变结果版本与完整正文分离。
- `manual_review_candidates_v4`：只纳入来源可证明为用户手动、已平仓、费用稳定且证据完整的交易。
- `strategy_memory_libraries_v4`、`strategy_memory_library_revisions_v4`、`strategy_memory_pending_updates_v4`、`strategy_memory_injection_logs_v4`：唯一记忆库、不可变版本、人工决策候选和实际注入审计。

写路径使用事务、行锁、CAS revision、幂等 scope key、租约和 fencing token。手动复盘候选在 case 创建事务内一次性标为已复盘，幂等重放仍返回原 case，不会把同一交易重复计入经验样本。模型 provider 尝试次数不等于业务 job generation；35 分钟租约覆盖三次、每次最多 10 分钟的模型尝试及持久化余量。有效租约内的任务不会被重复领取，过期租约接管会先把悬空 provider attempt 标记为超时，再递增 fencing token，旧 owner 不能写回。

## 3. 记忆治理

- 复盘版本必须由用户确认后，才会创建待确认的策略记忆更新。
- 短期建议仍需单独确认；默认库模式为 `shadow`，不会立即成为运行时权威。
- 长期候选使用稳定 `memory_key` 形成 `proposal_key`。同一策略下至少三个不同、已确认的复盘 case 提供支持后，才开放额外一次人工确认。
- 当前记忆 revision 同候选记录的预期 revision 不一致时，合并返回冲突，要求重新查看精确差异。
- 记忆 revision 同时保存展示文本和结构化内容块。撤销已合并建议时只移除对应块，追加新的 `revoke` revision；旧 revision 和来源仍保留。
- 平台策略对普通用户只读；当前服务只允许用户把建议合入自己拥有的策略，避免普通用户修改平台共享策略。

## 4. API、异步任务与实时消息

HTTP V4 已加入：

- `GET /review-cases`、`GET /review-cases/{id}`
- `POST /review-cases/{id}/generations`
- `POST /review-cases/{id}/versions`
- `POST /review-cases/{id}/confirm`、`POST /review-cases/{id}/return`
- `GET /manual-review-candidates`、`POST /manual-review-cases`
- `GET /strategy-memories`、`GET /strategy-memories/{id}`、`GET /strategy-memories/{id}/updates`
- `POST /strategy-memory-updates/{id}/decision`

浏览器实时通道只发送 `review.case.changed` 与 `strategy.memory.changed` 的小型状态/revision 失效事件，完整证据、完整 AI 正文和记忆正文仍按需通过 HTTP 读取。

复盘使用独立低优先级 BullMQ 队列和独立 PM2 Worker，默认并发为 1、独立健康端口为 3026。它不会阻塞 API、分析、交易员、风控或执行 Worker。

## 5. 前端工作区

AI 复盘师路由继续使用 `/reviewer`，工作区按普通外汇交易者的阅读顺序分为：

1. 日/月复盘：先看周期、账户和状态，再看指标、角色评价、反例与完整正文。
2. 手动复盘：从服务端已判定可复盘的候选中选择交易，填写可选的“当时想法”；该想法明确标记为未验证陈述。
3. 策略记忆：按策略查看当前版本、待确认差异和冲突；支持接受、拒绝以及对已合并更新执行可审计撤销。

界面使用项目唯一 shadcn-vue 组件源和语义令牌；异步提交有加载、错误、空态和 CAS 冲突恢复，不通过 WebSocket 承载大正文。

## 6. 第一轮复审：业务与数据边界

复审重点：归属、证据完整性、反事实污染、策略权限和历史可追踪性。

发现并调整：

- 原始草案只冻结策略版本，没有冻结订阅 revision；已补 `subscription_id` 与 `subscription_revision`，防止账户后来切换订阅后历史串线。
- 手动 case 曾准备使用固定 UTC 偏移；已改为候选交易采集时冻结的终端时区，case 使用最后一笔平仓证据对应的时区。
- 模型候选最初只校验证据引用；已增加冻结策略白名单，禁止模型把经验写入本 case 范围外的策略。
- 单次长期候选不应立即合并；已加入跨三个独立确认 case 的支持计数和额外人工确认门。
- 手动候选原先只校验是否可用，没有在创建 case 后一次性消费；现已在同一事务内切换为 `already_reviewed`，并保留并发幂等重放。

第一轮结论：复盘归属、策略范围、时间语义和长期经验门槛已经明确，不以单一盈亏或用户自述代替证据。

## 7. 第二轮复审：并发、失败恢复与连带风险

复审重点：重试、双写、撤销、队列隔离、跨账户泄露和大载荷实时传输。

发现并调整：

- 只保存拼接文本无法精确撤销单条记忆；revision 已增加结构化内容块，撤销通过新 revision 删除目标块，不覆盖历史。
- provider 重试若与业务 generation 混用会形成重复版本；现已独立记录 model attempt，并以 job claim/fencing token 拦截旧 Worker 回写。
- 运行中 job 原先缺少“有效租约不可接管”的显式判断；现已补租约门和过期 attempt 超时审计，避免队列重投造成并行模型调用。
- Outbox 任务和实时事件采用不同投影：任务只传 review job ID，浏览器只收到资源 ID、状态和 revision。
- Outbox 已生成复盘事件但浏览器订阅白名单最初缺少 `reviews`；现已补齐用户级 target、服务端解析白名单和重连后 HTTP 重拉约束。
- 用户确认、退回、编辑和记忆决策均使用 `If-Match` CAS；并发修改不会静默覆盖。

第二轮结论：核心写链路可以离线验收，且没有引入自动改策略、自动放宽风控或自动交易的隐式能力。

## 8. 未执行与剩余风险

- 本阶段未运行迁移，未连接 `dev_vue` MySQL、Redis、模型 provider、Bridge 或 MT4/MT5，也未启动新增 Worker。
- 周期 case/evidence 生产器和手动候选投影器尚未接入真实“已平仓、费用稳定、来源精确归因”的交易历史投影；在该权威投影完成前，不会伪造周期或手动复盘数据。
- `refresh_evidence` 当前明确返回 `review_evidence_refresh_requires_collector`；冻结证据重试可用，证据换代需由后续 collector 竖切完成。
- 旧复盘与记忆数据只写明迁移映射，尚未执行回填、逐用户对账、双读或切换；旧表仍须保留。
- 浏览器真实多宽度、网络中断恢复、真实模型长耗时和队列长稳压测留待阶段 15～16。

## 9. 结论

Stage 12R 完成的是复盘/记忆的规范化核心、API/异步/实时边界和真实前端工作区。它已经把“复盘建议”与“运行时策略权威”隔离，但尚不宣称真实周期数据生产、旧数据迁移或生产可用。

## 10. 离线验证结果

- 服务端复盘、Worker、浏览器实时和运行时接线定向回归：5 个文件、34 项测试通过。
- 前端合同：24 项测试通过；API Client：13 项测试通过；AI 交易实验室：14 个文件、53 项测试通过。
- 服务端 typecheck/build 通过；全部前端 typecheck/build 和应用边界检查通过。
- AI 复盘师独立懒加载产物为 74.74 KiB，gzip 20.25 KiB；仓库当前没有单独的 bundle budget 命令或阈值配置，因此只记录构建实测值，不伪造“预算通过”。
- 仓库全量测试共 3587 项，其中 3585 项通过；仅 `bridge-release-tool.test.js` 的 2 项环境型用例失败，原因是当前 `powershell.exe` 环境缺少 `Get-FileHash`，与本阶段复盘/记忆代码无关。
- 本次未执行迁移、真实 MySQL/Redis/provider 联调、服务启动、部署或 MT 指令测试。
