# 后端主流程收口证据

2026-09-11；本记录以当前源码和本轮测试为准。状态为待闭合，不能作为后端已完成证明。

| 环节 | 当前实际接线 | 当前证据限制 |
|---|---|---|
| 订阅到分析调度 | `scheduler-analysis.ts` 组装真实订阅窗口、账户、风险摘要、分析仓库与调度器 | 已确认生产入口存在；本轮没有运行真实 SQL 调度链。 |
| 分析到交易员任务 | `worker-analysis.ts` 使用真实分析仓库、上下文和模型 resolver；仓库承担完成事务 | 调度、订阅分发单元测试通过，不能证明 SQL/outbox/队列连续交接。 |
| 交易员到决策 | `worker-trader.ts` 组装真实上下文、订阅窗口、策略记忆及模型 resolver | Worker 行为测试通过；外部模型与终端证据尚未在本轮验证。 |
| 决策到风险 | `mysql-inference-repository.ts` 完成交易员事务时写 `trade_decision.created`；`bullmq-outbox-task-publisher.ts` 将其转成 `risk.review`；`worker-risk.ts` 消费 | 接线存在；仍需同一决策 ID 的真实数据库与队列贯通证据。 |
| 风险到执行结果 | 已有风险、执行模块与各自参考验证 | 本轮风险关联测试仅模拟 SQL 返回值，不能代替风险通过后执行和结果回读的贯通证明。 |

## 本轮验证

执行 `pnpm exec vitest run`，指定以下五个文件，43 项全部通过：

- `server/tests/inference-pipeline-vertical-slice.test.ts`
- `server/tests/analysis-scheduler-worker.test.ts`
- `server/tests/analysis-subscriber-dispatch.test.ts`
- `server/tests/trader-worker.test.ts`
- `server/tests/risk-decision-execution-writer.test.ts`

特别核对：名称含 `vertical-slice` 的测试使用 `MemoryInference` 和 `MemoryStrategies`，涵盖服务合同及 HTTP 行为，没有运行真实风险、执行流程。风险关联测试使用模拟连接。两者均不能升级为完整后端验收证据。

## 下一项交付的明确边界

复用生产组合与已有隔离数据库夹具，以同一组账户、订阅、分析、交易员、决策、风险、操作 ID 验证阶段交接。模型和终端保留可控测试替身，数据库事务、outbox、队列和结果读取使用实际实现，并明确记录替身边界。成功、重复投递和权限撤销至少覆盖主要副作用边界。先发现并修复接线问题，不新增复盘细节或新的通用框架。

这项证据补齐后仍需 D8 全域合同/路由/消费者与模块所有权对账，以及其余核心功能缺项检查；不能只凭交易主链通过宣布全部模块完成。

## 实际 SQL 验证发现与修复

`analysis-completion-v1-20260911.json` 在真实 MySQL 复现 `ER_TRUNCATED_WRONG_VALUE`：完成分析事务将 `analyzedAt`、`validUntil` 的 ISO UTC 字符串直接作为 DATETIME 参数。已改为复用 `inferenceSqlTime`，保留 UTC 原值及毫秒精度，HTTP 时间格式不变。

`analysis-completion-v3-20260911.json` 验证实际仓库事务通过：分析结果、交易员任务与 outbox 同时提交；UTC 时间准确回读；重复完成被拒绝；账户读取被撤销时回滚分析结果。V2 是测试夹具的未使用 clock 工厂配置错误，修正夹具后重跑。

该探针从 dev_vue 读取表定义，在随机隔离库运行，结束后删除隔离库，现有业务库写入为 0。保留列、CHECK 和索引，但移除外键；订阅候选和账户库存仍为测试端口，未消费真实队列，不能据此宣布 D3 完成。后续应替换这些端口并接通下游，保留本次真实错误作为回归证据。

## 订阅、归属与队列交接

`analysis-dispatch-v2-20260911.json` 已使用真实 `createAnalysisSubscriberReader`、`createAccountInventorySummaryReader`、`MysqlOutboxRepository`、`BullMqOutboxTaskPublisher` 和 BullMQ 消费端替换上一版对应替身。验证同一分析 ID 生成交易员任务，经持久 outbox 投递后消费端从实际仓库读回该任务；发布成功但 SQL 确认未写入时再次发布，仍只有一个完成的队列任务；重复确认返回 false。撤销实际账户归属后，新分析可以保存，但不会生成该账户交易员任务。它与 V3 模拟“已选中账户随后读取失败”的回滚场景含义不同。

V1 投递探针使用本机时间领取数据库刚生成的事件，未领取到事件；V2 使用数据库当前 UTC 作为领取时刻，消除跨机器时钟差对该定向验证的干扰。此调整只在夹具，不修改生产调度时钟政策。

该证据仍未运行 TraderWorker、风险计算或下单执行；队列消费者仅验证稳定任务 ID 与数据库回读。隔离数据库和随机前缀队列均已删除，现有业务库写入为 0。后续沿这条实际任务继续接通下游，不能把队列回读替代业务处理。

## 交易员处理与风险任务交接

`trader-pipeline-v4-20260911.json` 将消费端替换为真实 `TraderWorker`、`InferenceService` 和 MySQL 仓库。订阅窗口、执行偏好、账户/行情/风险修订读取也使用实际 SQL；模型响应、上下文构造和活动策略读取仍为明确列出的测试替身。

同一分析生成的交易员任务经 BullMQ 消费，完成冻结输入、模型任务及尝试记录、非空 `market_order` 决策和持久事件；最终以同一决策 ID 投递 `risk.review`。重复消费已完成任务返回 ignored，模型调用计数保持 1。实际风险 Worker 尚未消费，不能算风险审批或真实交易通过。

前三次探针定位到合成模型样本缺少止盈合同字段；按当前合同补齐推荐档位和三档价格后 V4 通过，没有放宽生产校验。每次均清理临时数据库和队列，现有业务库写入为 0。外键完整性仍不属于这份隔离事务探针的覆盖范围。

## 风险审批与执行准备

`risk-pipeline-v2-20260911.json` 使用真实风险 Worker、MySQL 风险仓库、决策写入端口，以及冻结策略证据和当前策略配置读取端口，消费同一决策并批准；重复处理返回 ignored。第一轮因模型样本缺少参考价格而得到 `RISK_REFERENCE_PRICE_REQUIRED`，仅补齐样本，没有修改规则。

`execution-pipeline-v1-20260911.json` 在该链上继续读取实际执行队列任务，调用真实 `ExecutionService`/`MysqlExecutionRepository`，生成同一审批对应的操作、执行意图和风险预留。再次准备返回原 ID，数据库只有一条对应意图。执行调用目前由探针驱动，尚未替换为实际 execution 队列消费函数。

仍未覆盖命令派发、终端结果处理及 HTTP 回读的同链验证；模型、交易员上下文、活动策略入口和品种读取仍是测试替身。不能将意图准备成功表述为交易成功。所有隔离数据库和三类队列均已清理，现有业务库写入为 0。

## 命令、模拟结果与 HTTP 回读

`execution-result-pipeline-v4-20260911.json` 在同一组分析/交易员/决策/风险/操作 ID 上继续调用实际命令源、命令服务和 MySQL 仓库。命令创建重放返回原 ID；模拟成功回执先持久化结果、更新执行状态，再返回 ACK；重复回执识别为 duplicate，错误用户回执被拒绝。实际 `/api/v4/operations/:operation_id` 路由及运行合同校验返回 200/succeeded，另一用户读取返回 404。

V1～V3 的 HTTP 探针错误是组装函数参数位置错误，修正夹具后通过；服务端原路由未修改。此前实际风险和执行验证已经通过，不能将该夹具错误解释为线上 API 缺陷。

目前完成的是有明确替身边界的服务端业务贯通：分析结果 → 真实订阅/库存读取 → outbox/BullMQ → TraderWorker → 决策 → RiskReviewWorker → 执行准备 → 命令 → 模拟回执 → HTTP。真实外部模型、Bridge 网络传输未调用；派发状态由探针调用仓库推进，执行准备尚未通过生产队列消费函数。活动策略入口、上下文构造和品种读取仍为替身；其它模块和分支不能据此自动关闭。接下来按这些具体差异核对生产组装，并进行 D8 全域收口，不继续新增交易边缘需求。

## 全域 API 和模块说明核对

本轮 `verify:api-contracts` 最初失败：检查脚本调用复盘基础 HTTP 工厂，漏掉生产 MySQL HTTP 组装已包含的六个历史读取接口。改为复用生产组装后，104 个合同操作与 104 个实际注册路由一一匹配，无缺失、未登记和重复；Schema 编译、生成消费者类型及协议例外测试通过。日志为 `architecture/api-contract-closure-20260911.log`。该结果不证明每个接口已用真实数据库和前端逐一验证。

14 个业务模块均已有 index/composition；补齐唯一缺少的 Bridge README。新增模块按 `backend-module-delivery-template.md` 记录职责、端口、逐表所有权、合同、消费者及完整流程证据。模板不代替现有各域数据所有权逐项审查，D8 仍需完成该审查及功能覆盖对账。

## 生产执行消费函数与实际策略读取

`execution-consumer-pipeline-v1-20260911.json` 将活动策略替身替换为 `createMysqlStrategyService`，并使用与生产入口相同的 `createExecutionProcessor` 消费实际执行队列的风险准备任务。队列完成后再次准备只回读原操作/意图，模拟回执和 HTTP 回读仍通过。剩余外部替身为模型、上下文构造与品种读取；意图到命令的准备分支和 Bridge 网络派发仍不是生产消费者完整验收。

生产入口原先将未知任务名且带 intentId 的载荷落入意图准备分支。现在处理器显式接受风险准备、分发目标和意图准备三种任务，未知名称或非法 ID/用户载荷在业务调用前拒绝。8 项定向测试涵盖拒绝路径、风险派发、busy 和依赖异常；源码构建和真实数据库/队列贯通通过。临时数据库和全部队列已删除。

## 生产意图消费者与账户租约

`intent-consumer-pipeline-v2-20260911.json` 继续消费同一执行意图的持久 outbox 事件，使用共用执行处理器、实际 `ExecutionPreparationWorker`、MySQL 命令源/仓库及隔离 Redis 账户租约生成命令。移除探针直接创建命令的步骤。其它所有者持有租约时返回 busy 且没有命令，错误 owner 不能释放租约；正确释放后队列生成一个命令，重放读取原命令，准备结束租约不存在。模拟回执和 HTTP 成功/跨用户拒绝验证继续通过。

随机数据库、三类队列、租约均已删除，现有业务库写入为 0。仍未用真实 Bridge 网络发送，派发状态由探针推进；上下文构造、品种读取和模型响应仍为测试替身。市价样本不证明挂单、分发或保护工作流全部验收。

## 实际品种读取接入主链

`instrument-consumer-pipeline-v1-20260911.json` 将风险阶段的品种替身替换为生产 `createMysqlInstrumentSnapshotReader`。隔离库写入合成用户、归属、终端绑定、连接和带 sourceEvidence 的品种快照；实际 SQL 联查能读取当前连接的品种，将连接 epoch 改变后返回 null，恢复后完整风险/执行/模拟回执/API 链通过。没有修改生产校验，也没有向真实终端请求数据。

剩余模型响应与交易员上下文为替身；Bridge 派发状态仍由探针推进，外键仍未在此探针验证。随机库、三个队列和账户租约全部清理，现有业务库写入为 0。该证据关闭品种读取替身这一项，不代表整体 D3 已关闭。

## 实际交易员上下文与在线账户来源

`context-consumer-pipeline-v2-20260911.json` 替换手工构造的交易员上下文，使用 `createMysqlTraderContext`、`createTradingReader`、实际偏好/风险/品种/记忆读取。隔离数据库补齐账户归属区间和三个资源的来源记录，隔离 Redis 使用生产网关租约类注册合成连接，实际 SQL 心跳及租约共同证明样本在线。模型入口断言账户在线且可交易、品种和空持仓/挂单、记忆 absent 状态来自实际构造；完整风险、执行、模拟结果及 HTTP 链通过。

V1 未接在线路由，V2 补齐，因此以 V2 为本项最新证据。连接是合成记录，不是实际 Bridge 在线证明。模型仍为替身；策略参考组合端口尚未接入本探针，非空记忆及人工确认后的使用仍不能由 absent 样本证明。外键、真实 Bridge 网络派发、调度起点仍按原剩余项保留。

临时数据库、三个队列、执行租约以及四个精确的隔离网关键均已清理并验证；现有业务库写入为 0。此次只修改集成探针和证据记录，未修改生产业务规则。

## 策略参考组合生产组装

`reference-consumer-pipeline-v2-20260911.json` 使用与 worker-trader 相同的 `createStrategyReferencePortfolioReader`，读取冻结分析输入及哈希、观察频道/来源、实际用户主体、账户归属、来源记录和 Redis 路由。当前合成样本为已确认空持仓/挂单；组合 ready 并进入真实上下文。禁用观察频道后构造上下文返回 `strategy_reference_inventory_unavailable`，没有调用模型；恢复频道后恢复正常，随后完整风险/执行/模拟回执/API 链通过。

至此该探针没有省略 TraderContextBuilder 的生产读取端口。报告字段改为 `omittedTraderContextPorts`，避免把这个局部结论误写成没有任何运行差异；新增 `remainingEvidenceLimits` 明确分析输入/模型与终端为合成证据、派发状态直接推进、HTTP 身份替身、空参考库存、无记忆库、未运行调度器。外键仍未验证。非空参考的逐 ticket 归因不能靠空样本关闭。

随机数据库、队列、账户租约和网关键已全部清理，现有业务库写入为 0；语法和改动格式检查通过。没有修改生产规则或调用真实终端。

## 调度起点与真实时间写入修复

`scheduler-consumer-pipeline-v1-20260911.json` 使用实际 AnalysisScheduler / MysqlAnalysisScheduleStore / InferenceService 后，在 queueAnalysis 的 INSERT 复现 `ER_TRUNCATED_WRONG_VALUE`。原因是 scheduleSlot/requestedAt 的 ISO 字符串未转成 SQL UTC 时间。生产仓库现在统一使用已有 `inferenceSqlTime`，手动任务的 null slot 保留不变，未修改已执行迁移。

`scheduler-consumer-pipeline-v3-20260911.json` 验证到期订阅创建实际分析任务和 outbox，推进调度后同一时刻无新增任务；模拟推进确认丢失后重调仍返回原 ID，只有一个 analysis.requested 事件，时间槽与创建时间 UTC 毫秒准确回读。beginAnalysis 使用实际事务冻结输入、建立模型任务和尝试记录，替换之前直接插入运行中分析任务的夹具。后续交易员到模拟结果及 HTTP 读取全部通过。

服务端构建及其边界/运行合同检查通过；调度、查询、订阅分发 16 项定向测试通过。临时库、队列和 Redis 资源全部清理，现有业务库写入为 0。调度 tick 已验证，但分析 Worker、其上下文及外部模型适配器尚未加入同链；报告明确记录此限制，不将服务方法调用等同完整分析 Worker 验收。原 SQL 人工审查文件的 inference 源哈希现已过时，引用时需重新核验，不能当作当前文件逐行证明。

## 分析 Worker 与市场上下文进入同链

`analysis-worker-pipeline-v4-20260911.json` 将分析开始/完成的直接服务调用替换为持久 analysis.requested → 实际 BullMQ analysis 队列 → AnalysisWorker。使用生产 AnalysisContextBuilder、市场来源读取器、交易账户/K 线读取、策略记忆读取和分析窗口守卫。四个周期各 300 根合成 K 线写入隔离 MySQL，实际上下文进入合成模型响应端；实际事务保存分析结果并继续交易员、风控、执行准备、模拟回执和 HTTP 回读。重复处理完成任务 ignored，模型调用没有增加；模型返回前撤销账户归属后分析可保存，但不分发账户交易员任务。

V1 是测试误用 outbox 字段/确认方法；V2 补充经过服务校验所需的模型结果字段；V3 是测试来源时间采用数据库时钟而消费者采用本机时钟导致时间差，V4 将合成来源时间与本机观测基准一致。没有修改生产校验。探针语法与改动格式检查通过。

该链现在覆盖调度和分析 Worker，但真实模型 resolver/用量结算尚未在此探针验证；行情、模型返回、终端连接和结果均为合成数据，派发状态仍直接推进，HTTP 身份为替身，参考库存为空、记忆库 absent、外键未验证。这些剩余限制保留在报告中。新增分析队列连同其余三个队列、隔离数据库及所有租约/网关键均已清理，现有业务库写入为 0。

## 模型网关与实际用量结算

`model-usage-pipeline-v2-20260911.json` 将两个 Worker 的直接模型方法替换为生产 HttpJsonAnalysisModelGateway / HttpJsonTraderModelGateway，使用实际 MysqlModelUsageLedger 和当前 dev_vue 的用量表定义。只有 HTTP fetch 返回合成响应，profile 仍由夹具配置；没有网络模型请求。每次模拟传输前断言已有 reserved 记录，三个实际 Worker 模型调用各结算 30 tokens，input/output 为 20/10；重复完成不能覆盖已结算数量。

同一隔离库还验证平台共享额度：并发两次 begin 在单次额度下仅一个成功，另一个 daily_request_limit；过期 reserved 由有界恢复改成 error / usage_unknown，重复恢复为 0，迟到结算不能覆盖恢复状态。完整调度到模拟回执及 API 链仍通过；所有临时数据库/四队列/租约已清理，现有业务库写入为 0。

本项证明实际网关与用量表事务及恢复，不证明 profile resolver、凭据解密、真实供应商、会员到期边界或全部配额政策已验收。下一步按既有核心缺项继续，不把本探针的合成 profile 写成生产配置证明。

## 实际模型配置读取和凭据解密

`model-catalog-pipeline-v1-20260911.json` 替换固定 RuntimeModelProfile，两个 Worker 通过实际 MysqlRuntimeModelProfileCatalog 读取用户默认模型、已验证供应商能力及运行策略访问。隔离库使用当前表定义保存随机 AES-256-GCM 密钥加密的合成凭据；实际解密成功，能力记录与模型不匹配时拒绝，个人模型归属改成其它用户时拒绝。恢复后调度至结果回读及用量/额度/恢复全部通过。

模型配置、凭据和行情均为合成样本；测试 resolver 包装器只负责将实际 catalog 结果交给生产 HTTP gateway 并注入假 fetch，未读取或输出现有模型凭据，未请求供应商或本地端口。这个包装器仍与生产 resolver 构造有一处测试传输差异，报告保留说明；不是生产供应商验证。临时库和四队列/网关键/租约全部清理，现有业务库写入为 0。语法与改动格式检查通过。

## 非空记忆暴露当前数据库缺失结构

`memory-consumer-pipeline-v3-20260911.json` 对当前 dev_vue 表定义运行非空记忆，实际 AnalysisWorker 失败 `ER_BAD_FIELD_ERROR: record_version`。历史 050 SQL 已描述该结构，但当前数据库未具有此字段；旧 memory-runtime-audit 的独立候选加载器不能当作当前 265 步完成链已经包含它的证明。

新增末尾纠正源 `inplace/078_strategy_memory_runtime_audit_completion.sql`，保留旧文件与完成 journal，不插入/重排历史。`memory-consumer-pipeline-v4-20260911.json` 仅在随机参考库先应用该追加 SQL，再跑完整链；非空分析与交易员记忆成功进入三个冻结输入，准备日志的快照哈希、记忆 revision 和估算 token 与输入完全一致。生产 memoryPreparation 工厂也已接入探针；之前 absent 样本不会触发它。

当前 dev_vue 尚未执行 078，这是明确的核心阻断，不能因为参考库通过而关闭。下一步将追加步骤接入当前升级注册链、完成旧记录保留/重复执行/DDL 确认丢失演练后升级当前开发库。此次参考库仍移除了其它表外键；078 新增的快照外键实际执行，但不代表全部外键验证。记忆内容由夹具 bootstrap，不是人工确认流程证据。

纠正范围复核：第一轮确认只补已有运行契约缺失列、索引、约束及 token NULL 语义，不增加新产品需求；第二轮确认旧记录默认 record_version=1 并保留 token 数，新增 v2 校验不改旧值，主要剩余风险是历史 schema 与 journal 分支不一致、DDL 确认丢失及父表外键；需由追加注册与完整恢复演练处理。现有业务库写入为 0，参考库/四队列/租约全部删除。

## 078 追加注册和恢复演练

`memory-completion-full-schema-v3-20260911.json` 从当前 dev_vue 314 张表完整克隆 DDL（保留外键），核对所有 265 条历史 checksum 和全库结构哈希后，仅执行 078。实际结果为一张日志表变更，快照外键存在。V1/V2 因参考工具只允许既有随机库名前缀而失败；V3 使用该工具允许的随机前缀，未放宽工具保护。

新增 `loadMemoryAuditCompletionUpgrade`，严格追加于现行 period-workflow 的 265 步后，得到 266 步；冻结历史 id/checksum 不变。`memory-completion-rehearsal-v1-20260911.json` 在完整 DDL+历史 journal 的隔离库使用现有升级协调器，模拟 DDL 已成功但确认丢失，验证 started 恢复为 completed，再运行无 DDL；DDL 总次数为 1。合成旧日志所有旧列原值保留（token_count=12），新增 record_version=1，其余来源列为 NULL。合成旧日志装载时关闭父外键检查，因此不将它视为旧业务完整引用证明；升级时外键检查开启。

这两项演练均无现有业务库写入，随机库已清理。当前 dev_vue 仍未执行 078，下一步执行前后旧数据对账和当前库升级，并同步运行 schema readiness，不能提前关闭该阻断。

## 当前 dev_vue 078 升级完成

`memory-completion-current-v1-20260911.json` 已在当前 dev_vue 执行一条追加 DDL：升级链 265→266，表数保持 314；旧表行数和内容哈希一致，变化日志表按全部原列独立计算内容哈希一致，新增列均为旧记录默认值；原 migration id/checksum/status 完整保持。现有业务行写入为 0，仅追加结构和迁移 journal；再次执行协调器不发 DDL。升级前数据基线保存于 `memory-completion-current-baseline-20260911.json`，备份 receipt 校验通过。

`memory-current-pipeline-v1-20260911.json` 移除参考库预先应用 078 的步骤，直接使用当前库定义，非空记忆、调度、两 Worker、风险、执行准备、模拟结果/HTTP 以及用量恢复全部通过。隔离库/四队列/租约清理完成。启动前 executionWorkflowSchema 已同步为 266 步/72 必需表，构建和内置边界/合同/生成一致性校验通过。

本次解除缺字段阻断；记忆仍为 bootstrap 合成版本，不能替代复盘生成→人工确认→后续使用验收。其余主链证据限制保持。

## 复盘确认、记忆接受与后续交易员输入

`confirmed-memory-pipeline-v6-20260911.json` 在当前结构隔离库种入待确认的合成复盘版本，调用真实 ReviewService/MysqlReviewRepository 确认，产生一个待确认记忆更新；确认重放只回读原结果。记忆接受前运行读取内容不变；另一真实存在的用户接受时返回 strategy_memory_update_not_found。本人接受后产生新记忆 revision，接受重放不再产生版本；该新内容随后进入真实 TraderWorker 冻结输入及准备日志，完整主链通过。

本次已验证“确认复盘→待确认记忆→接受→后续使用”，起点复盘版本仍直接种入，尚未接入 ReviewWorker 自动生成；分析策略记忆仍为 bootstrap。此前 V1/V2 是夹具缺少策略版本配对/周期/evidenceRevision，V4/V5 是跨用户样本与用户字段错误，均只修测试数据，未改生产校验。临时库/队列/租约全部删除，现有业务库写入为 0。

## ReviewWorker 生成到记忆后续使用

`review-generated-memory-pipeline-v1-20260911.json` 移除直接种入复盘版本，改为实际 createMysqlReviewWorker 领取复盘任务、读取哈希校验的非空合成交易证据、调用合成结果端、保存模型尝试和版本。完成任务重放 ignored，生成模型只调用一次。随后真实复盘确认、记忆接受/重放、运行读取、TraderWorker 冻结输入和后续主链全部通过，所有隔离资源清理，现有业务库写入为 0。

当前起点仍是种入复盘 case/job/evidence，并非周期自动收集器产生的账户历史证据；ReviewWorker 此处直接调用而非队列消费，模型 profile ID 为测试来源。已有自动队列/历史采集参考证据需对应到这一输入接缝，不能仅凭本样本宣称自动周期完整验收。分析记忆 bootstrap、空参考仓位、模拟派发/终端等限制仍保留。

## 生产 Bridge 派发处理器进入主链

bridge-dispatch-main-flow-v1-20260911.json 已移除探针直接 markDispatched，复用 bridge-gateway 入口使用的 createBridgeCommandProcessor 和 BridgeCommandService.dispatchQueued。只替换 transport.currentRoute/send 为合成终端路由与网络发送。send 时实际 SQL 状态已 dispatched；相同 dispatch job 再处理返回 dispatched=false，发送总数1。其后模拟终端结果和实际 API 回读继续通过。

此项关闭“主链绕过生产派发用例直接推进状态”，不代表真实 Bridge transport/Socket 或网关 BullMQ 投递已验收。行情/模型/终端响应、HTTP身份、空参考组合、种入复盘任务等既有边界保留；其它生产特例（保护/部分平仓/挂单）仍依据独立分支证据。主链使用隔离MySQL与Redis，当前业务库写入0，临时库、四队列及租约均清理。

## 非空自动日复盘采集到结果（本轮）

`period-nonempty-workflow-v4-20260911.json` 已通过。实际发现器登记已结束周期，Redis recovery/Worker 冻结历史时区边界并创建历史采集任务/outbox；实际 HistoryTaskWorker 持久化两笔合成成交及完整回执；实际系统单笔收集器生成来源证据；周期收集器从完整周期库存生成一个日复盘 case/job/evidence/outbox，再由实际 ReviewWorker 队列生成版本并经 HTTP 合同回读。重启登记、重复唤醒和生成重放不重复写入，异用户读取404，未确认复盘不写记忆。净利润10、成交数1。

当前业务库写入0，随机参考库已删除，隔离Redis队列已清理。源文件索引见 `period-nonempty-workflow-source-index-20260911.json`。本次只改验证夹具；未改生产时间校验，也未部署。V1误将实时仓位样本移到历史时间，V2响应时间在本地接收时间之后，V3复用的单笔库存断言范围包括其它场景记录；均修正夹具后重跑通过，失败轮次临时库亦已删除。

这是非空自动日复盘的真实SQL/队列接线证据，终端、模型、历史时钟和执行流水仍为合成输入，父表为最小结构。来源单笔收集器由探针显式调用，不能代替其生产调度全链验收。月复盘仍由独立真实writer/Worker参考链覆盖，尚非自动月边界的同链证明。确认→记忆接受→交易员使用沿用此前独立证据，未把本轮与其描述为一次连续运行。原“仅有空周期证据”的缺口已解除，实机细节随前端/Bridge逐功能联调。
