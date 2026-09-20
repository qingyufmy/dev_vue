> 2026-09-11 更新：dev_vue 完成 077 周期复盘工作项表升级，265 步 / 314 表；运行门禁 265 / 71，旧数据及旧迁移校验不变。周期状态机和持久化已验证，真实端口组装及到期调度尚未完成。

> 2026-09-11 更新：dev_vue 已完成 076 时钟观察表增量升级，264 步 / 313 表；运行门禁 264 步 / 70 表。旧数据及迁移校验不变。原始时钟观察同账户投影事务追加，历史边界读取和自然周期调度尚未完成。详见 clock-observation-current-v1-20260911.json。

# 核心重构当前状态

> 2026-09-11 最新数据库：dev_vue 263 步 / 312 表；系统复盘后台任务已接源码，集成范围与剩余核心项见 `docs/refactor-delivery-checklist-20260911.md` 的 D2 记录。

更新：2026-09-11。已按用户要求恢复核心实施，页面细节留到前端阶段；当前剩余顺序和D1最新进展以[统一交付清单](refactor-delivery-checklist-20260911.md)为准。本文顶部保留模块摘要，其后流水是历史证据，不再据其中的“下一步”安排任务。不以累计小阶段或测试数量表示整体完成率。

| 工作包 | 当前状态 | 下一项交付 |
| --- | --- | --- |
| 服务端模块边界、进程职责、API基础 | 已建立；当前检测范围越界清零，104项运行合同已接入 | 最终按功能矩阵核验完整业务覆盖，不能把扫描通过当成全功能完成 |
| 风险预算到准备/派发保护 | 本批源码及对应本地/真实MySQL参考验证收口 | 后续纳入完整账户运行联调，不继续扩展独立预算探针 |
| 策略与订阅数据切换 | 数据承接及本批策略/订阅API验收已完成；原策略完整运行仍未完成 | 回执表已纳入升级，真实API读写/权限/启用保护通过；原风险、记忆、模型设置的运行承接继续纳入整体流程验收 |
| 记忆与复盘基础 | 183历史案例、34版本、33已读状态已回填，当前API正文/原用户隔离通过；全部历史原文已归档；262步/311表 | Worker与全部版本/历史元数据API已验证；归档活动HTTP及API客户端已验证28作业/7208事件/18阶段；待页面展示及其余归档明细；记忆保留shadow/revalidating |
| 风险策略数据与读取 | 3组策略/10版本已承接；真实API读取、挂单创建/派发去重及MySQL命令事务通过 | 准备/命令创建/合成结果实际MySQL与Redis接线通过；真实终端及完整流程仍待验收 |
| 默认模型运行选择 | 已补齐个人默认缺省时的平台共享选择；当前数据库只读解析通过 | 用户1个人模型未验证；真实推理调用、用途配置与完整流程仍待验收 |
| 旧策略专项语义 | 尚有客观结构、事件身份/使用及提示词语义缺口 | 与架构主线分列；数据保留和迁移不能伪称策略已可执行，不按策略ID硬编码入场规则 |
| 服务端整体流程验收 | 尚未完成 | 真实SSO到账户/策略/风控/复盘读取与注销已通过；继续推理到执行及复盘生成完整连接验收 |
| 前端与Bridge完整重构 | 已有部分实现，尚未完成 | 后端核心和数据切换收口后，按完整用户流程交付 |

当前数据库：262步/311表，183历史案例和34版本已回填，当前历史详情API及用户隔离已验证。详见文末本批真实MySQL证据。

此前关闭：风险策略数据及读取。恢复库与dev_vue均承接3组/10版本，保留原始JSON、UTC、版本及当前指向；原表和旧账本对账不变。2组有效，用户29已失去账户2所有权，其策略保留为retired历史，当前用户28不继承。原账户0.5手、100%阈值和平台可编辑范围完整解析，交易发送/新增人工放行保持关闭。修复风控更新时间把UTC字符串当本地时间读取的问题。

本批证据：risk-policy-restored-v2记录整批回滚通过及提交，随后因探针预期错误码不符失败；v3独立重跑通过逐列/旧账本对账及真实读取。risk-policy-current-v1通过当前库13条业务记录写入及重放，risk-policy-current-api-v1通过.env应用账号、真实合同/SQL的2个成功读取和1个历史所有者拒绝，UTC返回正确。候选SHA256为2c6810bd766d957c212a1d8beb550f858212360f835590e9e4a1dedccd683d56。44项相关测试及服务端构建通过，98项运行合同、边界和schema校验通过。本批没有DDL，仍为254步/307表。未验证真实SSO、模型调用或交易。

前一批关闭：2个旧策略记忆库及20历史修订，已在恢复库及当前dev_vue完整承接为4角色库/40修订，原文SHA256、版本号、当前修订指向及UTC保持，源行成组归档，原数据和旧迁移账本不变。真实运行读取器返回disabled，防止尚未审核的角色记忆注入模型。当前库通过.env应用账号验证记忆列表及4个详情API成功。

同时补齐实际API暴露的复盘缺表：从既有012/049 SQL抽取缺失的13条DDL，排除已存在的记忆库/修订/注入日志表，追加12张复盘/待确认记忆/写回执表。两库现为254步、307表，原241步checksum及原业务数据保持；启动schema门禁覆盖254步、59张必要表。新复盘表为空，不代表旧复盘历史已经迁移。

本批证据：strategy-memory-restored-v1/v2、strategy-memory-current-v1验证回滚、独立重跑、逐列目标对账及旧数据/旧账本保全；review-runtime-full-schema-v1、review-runtime-restored-v1、review-runtime-current-v1验证完整参考外键、DDL回执丢失恢复、重放不建表及原数据不变；strategy-memory-current-api-v3验证真实合同/SQL读取。27项相关测试通过，服务端构建、98项运行合同、依赖边界和schema生成通过。当前库新增44条记忆业务记录，其余仅迁移账本/新增空表；无真实认证、模型调用或终端交易验证。

最新源码推进：新增事务内PendingCommandReviewer并接入公共命令运行组装。挂单派发前读取真实来源动作、原决策冻结分析ATR、当前有效平台系数及同route合约/挂单快照，调用既有live与dispatch占用检查；未知来源、缺失审核器、归属/版本变化或重复挂单在派发前拒绝，已识别的去重错误转为失败并释放预留。手工账户命令不虚构策略归属；手工策略分发保留策略身份，因没有AI分析而使用最小报价步长底限。严格要求分析symbol与动作symbol相同，未证明映射的券商别名不推测归一化。

本批源码验证：pending-command-reviewer、pending-dedup-guard、pending-dispatch-dedup-guard、pending-dispatch-occupancy-reader、bridge-command-state-machine共77测试通过；构建、边界、98运行合同及schema生成通过。覆盖当前风控系数改变去重结果、忽略模型ATR、历史来源错误、合约/route变化、在途占用及拒绝后不发socket。数据写入0，无真实终端交易。本批尚无真实MySQL完整命令派发事务证明；准备阶段还未提前调用去重，不把派发门禁当完整执行验收。

明确下一项：补准备阶段的提前去重，并在恢复参考库验证完整命令事务；随后把用户默认模型等接入统一流程，再处理旧复盘历史。当前3源策略model_profile_id及5源订阅risk_profile_id均为空，不能虚构逐策略模型或独立订阅风险配置；既有用户默认模型仍需后续实际运行验证。旧dedup_window_seconds只有配置定义、没有旧执行消费者，完整原值已归档，不作为新挂单保护的过期时间。

补充进展：命令创建事务已复用派发时的同一reviewOrder检查，位于源动作校验之后、命令/载荷/事件/outbox写入之前；拒绝整笔回滚，幂等重放仍返回原命令。创建检查通过不豁免派发复验。pending-command-creation、pending-command-reviewer、bridge-command-state-machine、bridge-command-transaction共52测试通过，构建和边界/合同/schema校验通过。这是命令创建提前检查，execution_intents生成阶段尚未提前检查；真实MySQL完整命令事务验收仍待完成。本批未写数据库。

最新MySQL证据：pending-command-mysql-v5-20260911.json使用当前27表原列/索引/CHECK建立隔离参考库，执行真实MysqlBridgeCommandRepository和PendingCommandReviewer；验证创建失败无部分命令、正常创建四表提交、独立事务幂等重放、真实历史命令占用拒绝、派发复验失败回滚、正常派发同时更新命令/意图状态。实际策略订阅/窗口/配置校验也经过MySQL。参考库已清理，当前业务库写入0。测试剥离外键，policy/analysis/instrument/pending-projection/historical-origin端口使用合成事实，尚不证明完整分析/行情链路；不能把本报告称为全业务端到端验收。v1-v3失败探针与v4首轮通过报告保留，v5增加真实命令占用场景。

最新模型进展：发现V4模型目录只读user_model_defaults当前用户，遗漏旧系统允许的平台共享缺省路径。现统一当前推理/冻结复盘选择逻辑：个人绑定优先，仅绑定不存在时读取owner=0的明确平台默认，并先校验手工/自动共享及当前套餐；个人配置失效、未验证或解密失败不静默改用平台凭据。7项定向回归和服务端构建/边界/合同检查通过。

model-default-current-v1-20260911.json使用.env只读连接实际数据库和解密密钥，在不调用模型、不写配置的条件下验证：真实草稿策略入口拒绝；隔离策略入口后用户28/29手工与自动用途都解析平台profile3，用户1个人profile1返回model_profile_not_verified。账户套餐读取和模型选择SQL真实，单独模型选择部分的策略准入被测试替身放行，不代表草稿策略可运行。尚未验证外部模型响应及完整推理链；未修改用户1的验证标记。

旧复盘清点：review-transition-inventory-v1-20260911.json确认183案例（155系统单笔、3人工、25周期）及33周期正文版本。当前kind缺少系统单笔；25周期案例引用7组未承接的历史策略版本；正文有3种旧结构，不能伪造为新角色评估。正式承接方案见review-history-transition-plan-20260911.md，含两轮复核；下一步先补单笔类型与历史正文合同，再做恢复库回填。本轮只读，无DDL/DML，尚未完成旧复盘迁移。

复盘类型推进：trade已贯通服务端过滤/结果校验、HTTP域合同及运行产物、前端共享解析和中文标签。11复盘HTTP+55共享合同测试、trade类型检查及服务端构建通过，API生成一致；准备069_review_trade_kind.sql但尚未进入升级链或执行。历史正文格式合同仍在下一步，数据库及业务数据未改。

前一批关闭：048策略写回执表SQL未进入240步升级链，导致写操作503；作为追加步骤inplace_067_01_strategy_write_receipts纳入第241步。订阅同策略ID启用时新增当前可访问active策略及绑定版本检查，草稿/退休/失去访问权限/版本不匹配返回409；暂停、结束仍可操作。

本批API证据：strategy-api-transition-v8-20260911.json完成36次真实HTTP合同→应用服务→MySQL请求，覆盖旧数据读取、删除/历史归属隐藏、平台策略只读、新建/发布/订阅/启用、幂等重放、退休后启用拒绝与结束。保存点模拟请求提交，最外层事务最终回滚，295表数据摘要不变；未验证真实SSO、真实COMMIT或终端交易。strategy-receipt-restored-v1、strategy-receipt-current-v1记录两库增量升级；strategy-current-readonly-v1确认现有.env应用账号可以通过新schema门禁、读取回执表，并经服务端看到3条当前暂停订阅，2条历史订阅隐藏。23项相关回归及服务端构建通过，98项运行合同、模块边界、schema生成校验通过。

上一批数据承接：3条旧策略拆分为6个角色策略及6个版本，5条旧订阅回填至canonical订阅、窗口、偏好表；8条原始记录完整归档，新增17条ID映射。4角色为draft、2角色保持retired；3订阅paused、2历史订阅ended，全部运行开关关闭。旧策略语义及订阅风险/记忆等设置的运行接入仍需验收，不把原文归档当作全部业务功能已迁移。

本批证据：strategy-subscription-transition-prepare-v4-20260911.json、strategy-subscription-transition-restored-v3-20260911.json、strategy-subscription-transition-restored-v4-20260911.json、strategy-subscription-transition-current-v1-20260911.json。先在带真实数据的恢复副本验证完整回滚、提交回执丢失恢复和独立重跑，再用同一冻结候选回填当前dev_vue；两个库均通过原数据摘要和目标逐列回读，旧迁移账本未变，重复执行无新增。22项转换及迁移写入回归通过。沿用已验证完整备份并核对备份后的增量迁移及现库全表摘要，本批未重新创建完整备份。

前一批关闭：模型动作可声明只能收紧的risk_ceiling_percent，固定手数与档位共同消费；API准备、执行Worker准备及Gateway命令派发复验冻结策略配置摘要；修复订阅偏好初始化、读取及执行检查仍使用旧_v4表名的问题，统一到当前subscription_execution_preferences。

前一批证据：138项相关回归通过，服务端构建、依赖/合同/schema生成检查通过；strategy-budget-mysql-v5-20260911.json在隔离MySQL库验证接受后的决策、同版本配置变化、active版本变化、历史缺失摘要、偏好表真实初始化/读取及双连接锁。保持原列/索引/CHECK，参考剥离FK，未覆盖全部运行进程或真实终端。该预算测试库已清理，该批当前业务数据写入0。

执行约束：应用与测试在本地；MySQL/Redis使用192.168.1.254虚拟机；现有dev_vue增量升级、历史UTC原值保留。公网、真实终端交易、删除旧数据不属于本轮动作。运行开关保持关闭。现有大量交错改动保留，尚未完成安全的提交/推送整理。

### 2026-09-11 历史正文读取合同完成（源码与本地测试）

- 新增 review.legacy.v1，保存来源表/ID、原摘要、原始正文及其 SHA-256；读取校验正文完整性。版本结论允许 null，并限制历史格式只能使用 null。现代写入合同仍只接受 review.v4.1。
- 历史案例通过 legacy_source_table 在事务授权入口禁止生成、修订、退回和确认；确认版本额外拒绝历史内容，避免派生新版记忆。原用户归属仍须校验。
- 前端展示“历史原文”，保留正文换行，不生成角色评估、指标或记忆候选，隐藏旧格式编辑/确认操作。未进行浏览器视觉验收。
- 追加待执行070_review_legacy_conclusion.sql；069/070尚未接入协调器、未执行，本批没有数据库写入。183案例及关联历史尚未回填，旧批准信息、历史策略引用和作业承接仍待实现。
- 验证：复盘HTTP12项、历史合同/写拒绝3项、写回执重放3项、事务结果15项、共享合同55项通过；前端复盘转换5项、风控账户作用域8项通过；服务端构建、模块边界、API生成一致性和trade类型检查通过。
- 扩大前端测试曾发现风控旧测试未提供Web Locks、遗漏幂等键及保存后刷新读取；仅更新该测试环境与断言，定向8项通过。未宣称全量前端重跑通过。
- 下一步：将历史元数据与069/070接入追加升级，完成历史引用/批准指针承接设计，在恢复库验证回滚与重复执行，再升级当前dev_vue。

### 2026-09-11 历史正文结构升级完成（真实MySQL）

恢复库和当前dev_vue已执行069/070，升级账本256步、307表。系统单笔trade类型及历史结论NULL已落库。307表DDL参考库验证通过并清理；恢复库注入DDL已成功但确认丢失的故障后续跑成功；两库重复执行均无新增DDL。所有业务表行数及内容SHA256、未涉及的DDL、原254条迁移记录保持不变。本批业务行写入0。

权威证据：review-history-full-schema-v1-20260911.json、review-history-restored-v1-20260911.json、review-history-current-v1-20260911.json。当前库完整快照摘要1c071c42b9ca838f40d0ddfce6eec6da9fa497ea0004ea2b7a0778778e5c2ae1；恢复库f565d0ef1b838761850245f1e0e8ec1444df583c6122eacb0ec30f563debbd6e。启动门禁同步256步/59张必要表，服务端构建通过；历史合同和HTTP15项通过。升级器单测确认原checksum保留、结构漂移写前拒绝。

pending-command-mysql-v6在升级后重验6项命令创建、回滚、幂等、占用去重及派发事务，通过并清理临时库；政策/分析/品种等仍为合成端口，不代表完整外部业务链路。183历史案例、原批准信息、历史策略引用及作业回填尚未完成，继续作为下一项交付。

### 2026-09-11 回填输入及版本转换验证完成

新增review-history-bundle模块：在一致快照中按案例读取全部原字段，数值和时间保持源字符串；建立稳定的表名+原ID目标标识，校验当前/批准/父版本、从属案例、作业、派生版本和已读版本引用；34个旧正文按review.legacy.v1转换，原始正文和原摘要保留、结论NULL、UTC原值不偏移。未知作者、悬空引用、跨案例版本或循环父版本拒绝。

review-history-bundles-v2-20260911.json实库只读通过：183案例/34版本/11批准指针，16张源表全部行归入案例；包括176周期来源、25周期作业、7208事件、12派生作业、8检查点、33已读状态，以及人工3来源/3作业/18阶段/27反事实点。原文转换通过服务端实际历史内容校验。纯转换与错误分支2项测试通过。本批数据库写入0，案例仍未回填。

载荷实测总115977423字节，最大单案例10828128字节。现有createFrozenSourceBatch限制2MiB，不能直接把案例包当一条普通回填请求。下一项必须增加有摘要及顺序校验的分块原文归档，在所有块验证完成后写入案例/版本及历史引用；保留现有小批次限制。原始批准没有批准人/时间字段，不推断补造；旧作业状态作为历史，不激活调度。

### 2026-09-11 分块原文归档完成（恢复库及当前库）

183案例、563个256KiB以内原始分块已归档到两库既有迁移账本，覆盖全部16源表关联记录，源载荷约116MB。每块独立事务写入、独立事务重放；全部案例从数据库分块还原，并与先前冻结sourceHash对比一致。业务表写入0，原业务数据、旧迁移账本及DDL保持不变；数据库仍256步/307表。不等于新版案例/版本回填完成。

runId：1c2e3dd7-afa6-f810-96a4-f5f97febc668；manifestHash：bfe22a5187d4836230ae62e8d2a35338ed167814786a2dfcf89cc2d109d4f5df。恢复库证据review-history-archive-restored-v2-20260911.json包含注入回滚及全量还原，afterHash=e3b3508e371fdbd0627836c61b68380079e2edfedf1cd47d954835ae5f022dcd。当前库证据review-history-archive-current-v1-20260911.json，afterHash=78c4fc89556056ef6567d3b3669ddeebb7a65523a2a995c3d917b3ccd3284508；实际使用归档读取器校验回执、源摘要、目标引用、完整清单后还原。

恢复库v1在写入前被schema门禁拒绝，原因是探针连接没有设置MySQL会话UTC；v2已设置+00:00并完成。失败报告保留，不改写已有报告。分块/读取器/原批次行为8项测试通过；原文转换2项在前批通过。现有2MiB普通批次上限保持，无新增表。

下一步：案例/版本及元数据回填。补充实库只读核实155个系统单笔均具备有效持仓起止时间，3个人工案例来源也具备有效起止时间；不需要伪造时间区间。历史策略版本引用、原批准信息、旧状态及任务的只读承接仍须落实，不能因已归档就标为业务迁移完成。

### 2026-09-11 新版历史案例及版本回填完成

071追加结构已在恢复库与当前dev_vue完成：259步/308表，新增review_case_history_v4，archived状态和未知trade_count=NULL；历史元数据通过复合FK关联归档checkpoint，未变更旧256步。两库DDL故障续跑/重放、原行摘要及旧账本校验通过。启动门禁259步/62张必要表；服务端构建、trade类型检查、HTTP13项、共享合同55项、API生成一致性、转换2项测试通过。

恢复库及当前库已回填183案例、183历史元数据、34版本/34正文、33已读状态，业务转换runId=d89adc13-bbac-b205-fff5-89e8d8ce2b2b。每个案例按旧账户ID映射回填、保持原user_id；从归档及旧源双重核验，事务内写版本后设置当前/批准指针，幂等重放逐字段验证。未生成新任务、模型尝试或outbox；所有旧案例status=archived，原状态及历史策略ID/版本保留在元数据。没有来源的批准人、批准时间、结论、指标为NULL。

权威报告：review-history-cases-restored-v1-20260911.json（含注入回滚，afterHash=cdae2d17e48ea97c863a4dbfc8c1ed83367d00baafe93f8990730a753a3a02fc）；review-history-cases-current-v1-20260911.json（afterHash=960e56967ffa0263d79aef4c0693ad3b96253fcd8268aa94e68477380f49db3d）。旧业务表及全部既有迁移账本不变。

review-history-cases-current-api-v1-20260911.json使用.env实际应用账号与真实路由/服务/SQL只读验证183案例及23当前版本，正文逐字等于旧源、UTC准确；另一用户28访问全部183详情均404，列表为空。鉴权入口为测试替身，不是完整SSO证明。历史用户29仍能读取自己案例，当前账户新所有者不继承。

剩余：全部版本列表、历史元数据及归档作业/事件/阶段/来源的正式读取合同仍须补齐；它们已完整归档但未全部进入新版业务API。真实复盘生成链路仍需验收。现场发现review_jobs_v4.status实际枚举是queued/preparing_evidence/waiting_model/validating/...，而MysqlReviewRepository.claimJob/assertClaim写/查running；这是已确认的新生成阻塞，下一步应按现有waiting_model合同修正Worker作业状态（不能改变案例running或模型attempt.running），并补真实MySQL租约接管与完成回写验证。

### 2026-09-11 复盘Worker状态阻塞修复

真实MySQL枚举不包含review_jobs_v4.running；Worker领取/断言原先使用该值会失败。已统一使用waiting_model，租约恢复识别preparing_evidence/waiting_model/validating，作业事件同步使用waiting_model。案例running和模型尝试running各自语义保持。历史案例仍通过状态及legacy来源在取任务入口拒绝。

review-worker-mysql-v2-20260911.json通过5项真实SQL行为：领取→完成并生成版本，活跃租约不抢占，过期租约接管并结束旧attempt，接管后旧Worker写入拒绝且仅1版本，archived案例不调用模型。测试克隆12张当前表的列/索引/CHECK及枚举，移除外键并使用合成模型，因此不声称外键/外部模型完整联调。临时库已清理，现有数据库写入0。v1因测试job fixture漏current_stage字段失败并清理，报告保留；v2补齐字段后通过。

服务端构建、模块边界/API/schema一致性通过；Worker/复盘HTTP/历史拒绝21项通过。下一项：全部复盘版本、历史元数据及作业记录的读取合同和消费者；新生成的完整真实模型路径尚待验收。

### 2026-09-11 历史版本及元数据API完成

新增独立ReviewHistoryReader应用端口及MysqlReviewHistoryReader，实现版本号游标分页、指定版本正文、历史状态/策略引用/显示时区来源读取；新路由模块只编排，版本载荷解码与HTTP响应/错误工具复用，未继续扩张原大repository职责。公开接口GET /review-cases/{id}/versions、/versions/{versionId}、/history，统一V4前缀，no-store，先鉴权再校验，数据读取始终同时绑定原user_id和case_id。

HTTP合同、运行Schema、生成类型、共享Zod和api-client三方法同步；运行合同由98增至101。服务端构建/边界通过，trade类型检查、API生成一致性通过；客户端25项、共享合同55项、历史分页错误分支1项（覆盖6种非法参数及私密SQL错误隔离）、原复盘读写16项通过。页面版本切换控件尚未接入，不把客户端方法完成当成UI完成。

review-version-history-current-api-v2-20260911.json使用.env应用账号及真实HTTP/服务/SQL只读验证：183案例、183历史元数据、34完整历史版本逐字核对；page_size=1分页无漏项/重复；34个版本各自验证异用户及同用户错误案例绑定拒绝，共68次404；原用户之外的183详情及元数据/列表拒绝。鉴权入口为替身，不代表真实SSO验收。无数据库写入。

下一项：归档作业、事件、阶段及来源读取合同；完整复盘生成的外部模型路径与整个服务端业务闭环仍待验收。


最新归档活动进展：新增独立的历史活动应用类型及基础设施投影器，将原作业/事件/阶段转换为只读摘要；保留originalStatus及UTC，按源表和源ID区分历史身份，不返回frozen_runtime_json或阶段输出正文。输入必须先完成归档回执、哈希及案例绑定验证；拒绝跨案例、跨复盘类型、缺失父作业、重复ID、缺失数据组及非法日期，缺失输出字段不能伪装成已有输出。

review-archived-activity-current-v1-20260911.json通过.env连接当前dev_vue，在READ ONLY一致性快照内从已保存的分块归档逐案恢复并核对冻结清单，183案例全部解析，得到28作业、7208事件、18阶段。数据写入0；3项定向回归及服务端构建/边界/101项运行合同检查通过。当前只完成归档数据到只读活动模型的验证，尚未接入运行时归档读取端口、用户授权、分页HTTP及前端，不计为历史活动API完成。下一步将归档读取从迁移脚本收口到运行模块，并避免每页重复解码整个大归档；原作业不会进入新Worker。


归档运行读取已推进：reviews新增独立ReviewArchivedActivityReader应用端口、MySQL读取适配器及review.history.chunk.v1运行解码器，通过composition组装，server/src不引用迁移脚本。数据所有权限定为review_case_history_v4引用的不可变review历史流，只读迁移归档/回执，不提供通用账本RPC。每页重新按case+user授权，缓存命中也授权；完整核验流身份、回执目标、分块与整包哈希、规范JSON及案例身份后才投影。只缓存摘要，32案例/8MiB有界LRU，原始大包不进入缓存，返回副本防止调用方污染缓存。

review-archived-activity-current-v2-20260911.json在当前dev_vue READ ONLY快照中通过真实运行适配器分页读完183案例的28作业/7208事件/18阶段，用户28对183案例全部拒绝；与迁移归档读取结果数量一致。5项定向测试覆盖损坏回执/内容/引用、缓存后越权与重复分页不重复加载，服务端构建和边界通过。数据写入0，数据库仍259步/308表；HTTP路由、合同及前端消费者尚未接入，不宣称历史活动接口完成。


历史活动HTTP及客户端已接通：新增GET /review-cases/{review_case_id}/history/jobs、events、stages三个只读接口，page_size 1..100、offset 0..10000，返回items/total/next_offset，拒绝未知/重复/非十进制查询参数，所有响应no-store；内部异常不泄露SQL。域合同、运行校验、生成传输类型、共享Zod解析和API客户端同步，运行合同增至104项。HTTP及客户端仍明确使用original_status，不把原作业状态当成当前任务。

review-archived-activity-current-http-v1-20260911.json以.env应用账号、Fastify实际运行组装/合同/SQL完成183案例全部分页，返回28作业/7208事件/18阶段，183越权请求全部404，数据库写入0。身份认证使用测试替身，不代表真实SSO验证。服务端构建/边界、HTTP参数与错误回归、API客户端26项及新增1项拒绝非法响应测试、共享合同55项、trade类型检查、API产物一致性通过。下一步页面展示与历史来源/反事实点/派生记录等剩余归档明细；本批未修改页面，不把客户端完成当作前端流程完成。


复盘Worker到期领取修复：领取事务此前没有读取next_attempt_at_utc，queued/retry_wait可被提前执行。现SQL加锁读取同时检查UTC到期边界，未到期返回ignored且不写任务/模型尝试/事件；成功领取清空已消费的next_attempt_at_utc，现有租约/fencing与归档隔离保持。review-worker-mysql-v3-20260911.json用当前DDL隔离库验证原5项并新增queued/retry_wait到期前逐列不变、无模型调用、到期等值可领取两项，共7项通过；8项Worker/写回放测试及构建/边界通过。测试模型为合成端口、外键未验证，临时参考库已删除，现有业务库写入0。

随后检查运行入口发现仍有恢复缺口：worker-review只消费BullMQ任务，未见数据库到期/过期租约恢复扫描；提前到达的任务返回ignored后，尚无本模块代码保证到期再次唤醒。上述领取修复不等于自动重试/崩溃恢复完成。下一项应补独立恢复应用端口与有界唤醒，验证重复扫描不重复执行、到期恢复、停机清理及归档任务排除，再接运行入口。


复盘自动恢复已接入：独立ReviewRecovery应用服务、MySQL候选读取、BullMQ唤醒适配器由composition组装到worker-review。启动及每15秒扫描，单批100条，按ID游标循环，发布失败不阻塞后续候选并在下轮重访；同进程扫描不重叠，停机清定时器并等待在途发布。队列按job/fencing生成稳定恢复ID，终态唤醒记录删除以允许后续恢复；数据库claim/fencing继续决定唯一执行。排除归档、终态、未到期及未过期租约任务。

真实参考测试v4/v5发现MySQL时间与本机时间不同，扫描已到期但claim仍ignored；改为领取到期、租约比较及新租约截止统一使用MySQL UTC，应用时间仅提供租约时长。review-worker-mysql-v6-20260911.json通过8项真实SQL检查，包含到期/过期候选重复扫描后执行成功及完成后不再被扫描。8项恢复/Worker单测和构建/边界通过。既有数据库写入0，临时参考库已清理；Redis发布使用替身、模型合成、外键未验证，运行进程未启动。本报告中的at-boundary旧标签仅指预设到期时间已被数据库时钟覆盖，不是数据库精确毫秒等值测试。下一步验证真实Redis隔离队列与恢复生命周期，再统一检查复盘完整运行链。


复盘恢复真实Redis联调通过：review-worker-mysql-redis-v3-20260911.json使用虚拟机192.168.1.254现有Redis随机独立前缀及MySQL隔离参考库，真实BullMQ Queue/Worker/QueueEvents接实际恢复服务和复盘Worker，重复扫描只保留两条待执行任务，到期retry_wait和过期validating各完成一次，完成后扫描为空；ignored任务完成删除后可用同一队列ID重新入队并处理。共9项检查通过，参考队列及参考数据库已清理，现有MySQL业务库写入0，无外部模型调用。

配置边界：当前server/.env只有REDIS_HOST/PORT/DB等通用配置，缺少V4运行必需的QUEUE_REDIS_HOST；本探针显式使用REDIS_*（独立随机前缀），runtimeQueueConfigurationVerified=false，未修改.env或启动正式Worker。v1因缺少QUEUE_REDIS_HOST在连接Redis前失败；v2首次真实联调通过，v3增加同ID重新唤醒完成断言。外键仍未纳入隔离DDL验证，模型为合成端口，不代表完整生产/SSO/模型验收。下一步应统一核对V4本地运行配置和核心流程接线，避免把单个模块通过当整套后端可启动。


本地队列配置已补齐：server/.env追加缺失QUEUE_REDIS_HOST/PORT/PASSWORD/DB及V4_QUEUE_PREFIX，目标为既有192.168.1.254 Redis、逻辑DB1、aurum-v4-dev-vue前缀；缓存仍使用原DB3，MySQL不变。只新增缺项，不覆盖现有配置，AURUM_V4_RUNTIME_ENABLED仍关闭。Redis实测noeviction、AOF关闭，属于本地开发共享实例，逻辑DB隔离不是独立实例或生产持久化验收。

v4-local-configuration-v1-20260911.json调用实际配置解析器：runtime及现有模型密钥环校验通过；API/实时缺AUTH/WWW/TRADE/ADMIN四个ORIGIN、CSRF/BFF秘密及身份签名私钥/key ID共8项，尚未具备完整启动配置。报告只列配置名与非秘密目标，不记录值或凭据，未验证运行进程覆盖。review-worker-mysql-redis-v4-20260911.json改为使用QUEUE_REDIS实际连接配置重跑9项恢复检查通过，隔离随机测试前缀/数据库已清理，现有业务库写入0。未启动正式V4进程；下一步按本地四应用入口补身份配置并验证实际认证链。


本地身份配置结论更正：现有run-local-account-api.mjs本就使用受限私有覆盖D:/dev_codex/.local-runtime/dev-vue/account-api.env。此前只查server/.env的8缺项不等于完整本地启动缺项。inspect-v4-local-configuration.mjs现支持传入该覆盖，并经实际localAccountEnvironment白名单/端点校验后执行runtime/API/realtime/modelKeyring解析，检查CSRF/BFF长度与真实ES256私钥曲线。v4-local-configuration-overlay-v1-20260911.json全部通过、missingKeys为空；未生成/替换密钥，未启动服务。ready仅表示所检查配置可解析，不是运行健康/认证业务/浏览器验收。

当前本地启动仍使用已存在的HTTP localhost分端口开发例外，不能当生产Host-only跨主机隔离证明。后续完整身份验收应复用已有私有测试账号与启动流程，而不是重复生成身份配置；先检查活跃进程和当前schema门禁，避免重复启动。


真实身份链增量验证：verify-auth-current-inprocess-local.mjs复用既有受限本地配置和local-account-fixture合成用户，真实MySQL/Redis及createAuthModule/createAuthHttp通过Fastify inject执行密码登录、授权码交换、会话读取、授权码重放拒绝，并分别注销auth/trade两会话，旧Cookie均401。auth-current-inprocess-v2-20260911.json通过，sessionsCreated=2/sessionsRevoked=2；有真实会话/授权码/认证历史写入，不能称数据库零写入。没有网络监听、前端代理或浏览器验证，也未验证完整API启动/schema门禁。

v1四项正向行为通过但探针注销错误发送{}正文，被合同拒绝；修正为无正文POST。遗留31/32两个会话按合成user、精确创建时间及父子关系锁定核对后撤销，auth-current-inprocess-v1-cleanup-20260911.json记录2条撤销，未清除其它历史。当前探针成功清理本轮会话；旧证据保留。下一步在真实身份绑定下复验核心业务API，优先账户/策略/风控/复盘完整连接关系，页面细节继续后置。


真实身份到业务模块读取已验证：auth-business-current-v2-20260911.json将实际AuthService会话适配器接入createTradingApiModule、StrategyHttp、MysqlReviewHttp和RiskHttp，使用真实dev_vue/Redis、既有合成用户密码登录。匿名5个业务入口401；登录后账户/策略/订阅/复盘/记忆列表200，两个合成自有账户风控策略读取200；其它用户复盘详情/版本/历史元数据及jobs/events/stages共6入口404；注销后账户/策略/复盘重新401。当前两会话均注销，保留真实会话/授权码/审计记录，未新增业务账户或执行交易。

此证据没有身份替身；Bridge全设备撤销端口仍为拒绝调用的替身且本测试未调用，不覆盖全设备注销。采用Fastify inject注册相应模块，未经过完整API顶层Host门禁/网络监听/前端代理/浏览器；列表成功不证明该合成用户具有正向策略/复盘内容。全链路尚需完成推理/风控/执行/新复盘生成与实际数据契约校验。下一步回到意图准备阶段提前去重及剩余业务接线，避免继续把单个只读探针视为核心目标完成。


意图准备提前去重推进：已新增独立checkPendingPreparation应用守卫，复用现有实时挂单/在途派发检查，同时要求PreparedPendingOccupancyReader提供尚无命令的prepared意图及queued命令占用，再按同一冻结ATR/最小报价单位比较本批动作，避免同一批相近挂单都通过。校验同一账户/用户/策略范围、唯一意图ID、来源快照时效和占用完整性；无证据不放行。3项定向行为测试及构建/边界通过。

本批仅完成应用守卫与端口，尚未实现prepared占用SQL适配器、准备证据装配或接入MysqlExecutionRepository事务，运行行为尚未启用提前去重，不计为意图准备保护完成。现有PendingCommandReviewer依赖已存在命令与意图，不能直接搬到insertBundle之前。下一步实现prepared/queued占用来源核验、组装冻结分析/合约/route证据，再在源/策略/容量复核之后、insertBundle之前调用，并以真实MySQL验证拒绝无部分写入。


准备意图占用SQL已实现：MysqlPreparedPendingOccupancyReader在调用方账户锁内读取prepared意图或有queued命令的pending_order，包含没有命令的意图；用EXISTS避免多命令重复行，1000条上限，LEFT JOIN保留缺payload并拒绝，核验action SHA/价格/类型及原始策略来源。未凭TTL消除占用；明确手工账户命令不虚构策略归属，跨策略历史保持原策略。readPendingDispatchOrigin改为只要求真实来源字段，避免为准备阶段伪造命令状态。

18项准备守卫/SQL适配器/来源测试及构建/边界通过。pending-preparation-occupancy-mysql-v1-20260911.json使用当前259步参考schema隔离MySQL验证无命令prepared计入、queued只计一次、派发后交给dispatch读取，并复跑原命令创建/派发回滚和幂等，共9检查通过；参考库已清理，现有库写入0，来源等端口仍合成，外键未验证。尚待当前动作冻结分析/合约/route证据组装及MysqlExecutionRepository事务调用，准备提前去重仍未在运行中启用。


准备提前去重已接源码运行路径：新增PendingPreparationReviewer应用端口与MySQL证据组装，核对原决策/分析用户账户策略、冻结分析symbol/ATR、实时路由及合约来源profile/instance/epoch/ownership/版本，确认bundle动作与批准动作哈希一致。bootstrap统一创建事务内pending/分析/来源/合约端口，API与worker-execution均注入MysqlExecutionRepository；账户锁及源/风控/容量复核之后、insertBundle之前执行，缺审核器拒绝pending准备，已有幂等operation返回不重新审核。后续命令创建/派发审核仍保持。

11项准备证据/占用/守卫/既有命令审核测试及构建/边界通过，覆盖模型动作内伪ATR不会覆盖冻结分析、route/symbol/action替换拒绝。没有启动Worker或交易；真实完整准备事务的回滚验证尚未执行，前一批MySQL报告只证明占用读取与命令事务，不证明本次准备事务。这一差距是下一项验收。


真实准备事务探针推进并发现结构阻断：新增verify-pending-preparation-reference-local.mjs及独立runner准备克隆当前DDL运行MysqlExecutionRepository，pending-preparation-transaction-v1-20260911.json在建参考库前SHOW CREATE TABLE失败（ER_NO_SUCH_TABLE）。随后独立只读核对39张依赖表，仅market_instrument_snapshots缺失，详见pending-preparation-required-tables-v1-20260911.json。该表由canonical 006定义，当前合约读取/风控/执行版本检查均引用，之前使用合成instrument端口的探针没有覆盖此问题；此前schema通过不证明交易完整结构就绪。

已追加候选072_market_instrument_snapshot.sql，精确复用006表定义/主键/索引/账户外键；未执行DDL、未生成行情或更改现有数据，当前仍259步/308表。下一步将072纳入顺序升级协调器及启动schema门禁，先恢复参考库验证再升级dev_vue，最后重跑真实准备事务。事务探针尚未通过，不能称提前去重整体验收完成。


合约快照缺表已完成增量升级：072精确复用canonical006定义，instrument-snapshot-full-schema-v1-20260911.json克隆完整308表DDL并验证新增表与账户外键，参考库已清理；instrument-snapshot-restored-v1验证恢复库DDL回执丢失恢复、重放0DDL和原数据/旧checksum保全；instrument-snapshot-current-v1验证当前dev_vue同样保全，现两库均260步/309表。当前新增一张空market_instrument_snapshots，业务行写入0，未伪造终端合约事实。恢复库afterSnapshotHash=8126f130c1f960dc2396b4f9ff29465ac6fd01025f84f3b249048819faea84e7，当前=9cd0ef234cdb832148c23c9f33db67dd8797a4c2c6b3aad984e5c1f0a2a73055。

升级协调器已增加instrument-snapshot层，执行工作流启动门禁生成260步骤/63必要表，构建/边界/104运行合同通过。新基线在各库升级锁内采集当前全量行哈希，允许此前授权的测试认证记录，并在升级后逐表逐行哈希保持；原备份receipt另行验证。准备事务v2/v3已越过缺表，失败于合成market_analyses默认夹具触发CHECK（build_inf_4ca8c4d56cafcd921f61d1cb），参考库均清理。下一步补齐满足正式约束的分析夹具继续事务测试，不修改正式CHECK或用删约束让测试通过。


准备事务真实MySQL验收推进：修正合成分析owner_scope/user配对和valid_until>analyzed_at，按真实账户策略打开合成账户tradeSend（平台不能代替账户开关），保留全部CHECK。v6证明去重拒绝八张输出表零行，但成功路径暴露MysqlExecutionRepository将ISO Z直接绑定DATETIME导致ER_TRUNCATED_WRONG_VALUE。新增execution-sql-time统一严格UTC写转换和dateStrings读转换，覆盖operation/intent/reservation/events及到期回收；分页LIMIT绑定标准字符串。未修改领域事件的ISO时间合同。

pending-preparation-transaction-v8-20260911.json通过真实MysqlExecutionRepository/ExecutionService：审核拒绝八输出表无残留，成功准备完整写入意图/预留/事件/outbox，幂等重放不新增审核或写入，到期operation与reservation转expired。4项时间回归及构建/边界通过，临时39表参考库删除，现有业务库写入0。该探针准备审核器/风险关联写端口/账户时钟仍受控替身、外键未验证；证明事务挂接与数据行为，不证明真实分析/行情/策略来源到去重的完整整合。下一步在同一参考事务接真实PendingPreparationReviewer和可核验的冻结事实，补并发准备相近挂单只允许一次。


真实准备审核器并发整合通过：pending-preparation-concurrent-v1-20260911.json在当前39表DDL隔离参考库，实际MysqlExecutionRepository账户锁/源复核/策略窗口/风控容量/写入事务接createMysqlPendingPreparationReviewer、实时/在途/准备占用守卫与真实prepared占用SQL。两笔不同risk/decision、同账户同策略同品种的2500与2500.001挂单Promise.allSettled并发准备，一笔成功、另一笔execution_duplicate_prepared_pending，数据库最终仅1个prepared意图/1个active预留；并复跑先前4项事务检查，全部通过。

报告仍明确合成route、冻结analysis、origin、instrument、live-pending-projection、risk-operation-link和account-clock端口；第一阶段拒绝注入审核器用于事务故障验证，新增并发阶段为真实审核器。外键未验证、无真实Bridge或下单，临时参考库删除，当前业务库写入0。这证明并发账户锁下的提前去重整合，不能替代所有外部来源SQL/完整交易流程验收。下一步优先替换冻结分析及来源读取替身，用正式冻结数据结构验证策略/分析来源绑定。


准备事务来源 SQL 整合进一步完成：pending-preparation-frozen-sql-v1-20260911.json 通过 7 项检查，实际读取交易决策、分析运行与冻结快照，校验分析策略与交易策略的不同归属，冻结 ATR=10；篡改快照正文未更新 hash 时拒绝且八张输出表计数不变。pending-preparation-instrument-sql-v1-20260911.json 通过 12 项检查，进一步接实际合约读取，验证用户、所有权、终端绑定、连接 epoch、断开状态与新鲜度；错误归属/epoch、断开连接和过期合约均拒绝且无部分写入。

pending-preparation-projection-sql-v2-20260911.json 在当前 260 步 schema 的 45 表隔离参考库通过 16 项检查，进一步使用 createTransactionPendingReader 实际读取所有权区间、挂单投影版本与 provenance；空挂单必须有完整来源，错误 epoch、混合版本、过期投影均拒绝。并发两笔相近挂单最终仍只有一个 prepared 意图和一个 active 预留。v1 的失败来自测试恢复时间改用数据库时钟后被应用侧未来时间保护拒绝；v2 恢复原合成快照时间，不修改运行时新鲜度规则。失败报告保留。

本批变更为验证脚本及记录，未修改正式运行代码。所有临时参考库已删除，现有业务库写入 0。真实 SQL 覆盖不等于真实终端证据：数据为合成夹具，参考表保留 CHECK 但移除外键，挂单正向样本为空，未覆盖非空实时挂单的完整归因。尚有 first-phase-reviewer（故障注入）、risk-operation-link、account-clock、route 替身；未启动服务或执行交易。下一步替换剩余运行端口并补非空挂单归因；整体核心重构仍未完成。


风险关联和账户时钟真实端口已加入准备事务参考验证。pending-preparation-clock-risk-sql-v1-20260911.json 暴露实际缺陷：createTransactionRiskDecisionExecutionWriter 在关联 operation 时递增风险 revision，而旧准备重放直接比较含 revision 的 sourceHash，导致成功准备后的正常重试 execution_persistence_conflict。此前替身未递增版本而漏检。MysqlExecutionRepository 现于已有操作分支重新锁定当前风险源，核对用户/账户/operation 关联及原版本恰好增加一次，再以保存版本复核完整源哈希；接受原请求或关联后的同内容请求，不跳过内容校验。

pending-preparation-clock-risk-sql-v3-20260911.json 共 21 项通过：真实风险写端口下正常重放无额外写入，改批准动作、额外增加风险版本、改 operation 关联均冲突；并发赢家关联且 revision=2，输家保持未关联 revision=1。第二阶段启用全天 terminal_server 订阅窗口及带所有权/provenance 的 account.metrics，实际 createTransactionAccountClock 读取 UTC+3 合成校准事实；stale/unavailable/observer_bootstrap 三种状态均 execution_schedule_closed 且输出表不变。UTC+3 是夹具校准输入，不是交易时钟兜底。

19 项执行状态机/持久化边界/风险写端口测试及服务端构建、边界、104 运行合同检查通过。本轮只改本地代码、探针及记录，所有临时参考库已清理，现有业务库写入 0，无服务重启或终端交易。准备验证仍有故障注入审核器及 route 替身，合成数据/未验证外键边界不变；实际网关路由、非空挂单归因和完整执行后续链尚需继续。准备 TTL 之后的重试目前仍先经过领域过期判断，尚未证明过期后重放语义，列为后续接线验收项。当前混合工作区无法安全拆分单一职责提交，本批未提交或推送。


过期准备重放语义已补齐：按交易状态机“重试只能读取或推进原记录”的规则，ExecutionRepository 增加必需 replayPreparedExecution 端口；ExecutionService 在创建候选/TTL 判断前回读，MySQL 在账户锁内复用同一所有权、风险关联、版本与源哈希审核。首次准备仍执行原 30 秒期限和事务完整复核，persist 内保留二次重放检查以处理并发。没有旧记录的过期决策仍 execution_source_expired，不生成新意图；已有 expired 操作返回原终态及已释放预留。

pending-preparation-expired-replay-v1-20260911.json 23 项真实 MySQL 检查通过，包含过期后原 ID/expired 意图和预留回读、八张输出表无新增、其它用户拒绝，以及从未准备的过期决策拒绝。18 项状态机/持久化边界测试和构建通过。worker-execution 风险准备分支仅读取 result.kind 后完成 job，不遍历返回意图派发；已有操作回读不会产生新的 outbox。真实 Worker/BullMQ 的该重放场景尚未运行，不提升为队列验收。临时参考库已删除，现有业务库写入 0。准备链剩余重点为真实路由与非空挂单来源归因；整体核心重构未完成。


非空挂单与实际 Redis 路由整合通过：pending-preparation-live-order-sql-v1-20260911.json 27 项检查覆盖完整挂单投影、实际 execution_outcomes/bridge command/intent 与决策来源 SQL；精确 order_ticket=9001、历史 epoch=2 在当前 epoch=3 下仍归属策略20并拒绝相近挂单。断裂运行/决策版本拒绝，挂单行 revision 混杂拒绝；未来 command epoch 不作为来源证明，返回 unresolved（不凭空归属策略）。历史行是专门合成的来源读取夹具，未经过真实 outcome 状态转换，不能作为完整历史执行流程证明。

pending-preparation-mysql-redis-v1-20260911.json 29 项检查通过，进一步使用实际 RedisBridgeGatewayLeaseStore 与 server/.env 指向的 192.168.1.254 缓存 Redis；随机 pending-preparation-reference 前缀，未写现有运行键。实际 claim/current/release 参与准备审核，路由不存在、Redis epoch 与合约证据不一致时拒绝且八张输出表计数不变；最后并发仍一笔准备、一笔拒绝。参考库 46 表与随机 Redis 键全部删除，报告 referenceDatabaseRemoved/referenceRedisKeysRemoved 均 true。现有业务库写入 0。

正常准备整合路径现无 route/分析/合约/挂单/风险关联/时钟端口替身；仅第一阶段事务故障注入审核器保留。MySQL 表保留 CHECK、外键仍未验证；Redis 内路由为人工合成而非实际 Bridge 握手，未验证身份凭证撤销、真实 Gateway 进程或终端下单。下一步按核心路线图核对准备后的命令/结果/复盘衔接，避免将本批局部通过视为完整重构完成。


准备到命令/结果链已完成本地真实依赖整合：pending-preparation-command-source-v1 验证实际 MysqlExecutionCommandSource 从并发赢家意图生成正确 order.place/buy_limit 参数、价格及截止时间，并过滤过期候选。pending-preparation-command-create-v1 使用真实时钟/策略/风险及 pending command reviewer 创建唯一 queued 命令并幂等重放。pending-preparation-result-chain-v1-20260911.json 共 32 项检查通过，47 表隔离参考库沿实际 markDispatched、BridgeCommandService.result、persistResult 更新命令/意图/操作为 succeeded，预留 committed，execution_outcomes 精确 pending_order/order_ticket=9100；返回 result_ack，重复结果为 duplicate，八输出表计数不增且 outcome revision=1，跨用户 scope 拒绝。

本批模拟派发状态及 command.result 信封，未调用 transport.send，未启动终端或发送真实指令。使用普通挂单路径；部分平仓/持仓保护专用 capture 未注入且未调用，不证明这些路径整合完成。参考库和随机 Redis 键清理完成，现有业务库写入 0。outcome 是合成终端输入的实际落库结果，不是实际成交证明。后续继续核验执行后复盘来源及生成链；不要将 command succeeded 当作完整策略运行或真实终端验收。


复盘生成接线审查发现：当前 runtime 的 review_cases_v4 新建 SQL 仅在 createManualCase；系统交易/日/月复盘自动建案、手工候选生产仍未完成接线。现有历史迁移与 Worker 成功不能证明这些生成入口已完成，下一工作包必须补来源收集与冻结，而非继续把已有 case 的 Worker 探针当完整复盘流程。

先修复冻结证据完整性缺陷：claimJob 原来仅比 j.input_sha256 与 e.evidence_sha256 两个存储摘要，未重算 evidence_json。新增 review-evidence-integrity，在任何任务状态修改前解析并校验正文；新手工建案使用字段排序稳定的 canonical SHA256，数组顺序保留。旧手工证据按已知 writer 的完整固定字段顺序复原验证，严格拒绝额外字段，原有摘要未重写；旧未知载荷无法验证时拒绝，不忽略 hash。归档历史仍不运行 Worker。

3 项正文校验回归覆盖 MySQL JSON 重排、新旧摘要、金额篡改、额外字段、非法正文及数组重排；5 项 Worker 测试和构建/边界/104 合同通过。review-worker-evidence-integrity-v1-20260911.json 10 项真实 MySQL/Redis 检查通过，篡改正文时模型调用数不变、job 仍 queued/fencing=0/attempt_count=0、无 model attempt 或 job event；原恢复与并发保护回归通过。合成模型，参考库及队列清理，现有业务库写入0。未跑真实模型、未新建实际用户复盘。


自动建案实施方案已落盘 docs/architecture/review-collector-implementation-plan-20260911.md，含五项交付及两轮复审：先 trade-history 证据端口/费用存在性，再手工候选、系统单笔、周期，最后 scheduler/collector/recovery。没有将命令成功当成平仓；历史时区、所有权区间、费用完整性与跨域 revision 复核列为真实资格条件。

第一项基础实现 readTradeCostEvidence 已在 trade-history 公开入口提供，重算原始终端 JSON 摘要后区分 profit/commission/swap/fee 的 explicit/missing/invalid，保留原十进制文本；新增 2 项测试覆盖明确零、缺失、空值、无效类型及原文篡改，构建/模块边界通过。该函数仅证明字段存在性，不证明费用最终稳定；尚未接入 ReviewTradeEvidenceReader 或候选生产器，不能据此宣称自动建案已完成。本批无数据库写入。


ReviewTradeEvidenceReader 应用端口与 createTransactionReviewTradeEvidenceReader SQL 适配器已实现，归 trade-history 所有，经 index/composition 分别公开业务合同与组装能力。调用方持有一致事务；读取复用 provenHistoryRecordSql 历史用户/所有权区间证明，校验 expectedRevision、closed、exact、system/manual、明确币种，再 LEFT JOIN 所有关联原始成交（不按平仓时刻丢弃晚到费用），1000 条上限。原文摘要、重复/缺成交、记录聚合摘要及费用字段存在性全部复核。

返回 captured 仅表示这些原始事实一致，不表示历史遍历范围已完整、费用已经最终稳定或已可自动建案。跨域采集完成回执/时区历史/资格复核仍需接入；未写候选或 case。5 项费用与 SQL 适配器 Mock 测试、构建/边界通过；本批未跑真实 MySQL 适配器，下一项是隔离库数据/查询验证，然后候选生产。无现有数据库写入。


复盘交易证据真实 SQL 验证已完成：新增 verify/run-review-trade-evidence-reference-local，按当前 260 步账本校验后克隆 5 张相关表，保留 CHECK、移除外键，仅写隔离合成数据。review-trade-evidence-mysql-v2-20260911.json 9 项通过：正向原文/UTC、跨用户、版本、所有权结束、缺关联成交、成交换账户、归因未决、聚合摘要不符、缺费用、正文篡改及成交号替换。

复核补强：reader 除 SHA256 外调用所属域 decodeTerminalHistoryPage 重新解码原始事实，要求成交号与关联 terminal_history_deals 行一致；缺身份/时间字段或不符抛 review_trade_fact_identity_invalid。3 项适配器测试及构建通过。参考库删除、现有业务库写入0；本批仍是合成 MT5 来源读取测试，未证明完整入场/出场手数守恒、费用最终稳定、历史遍历回执或 MT4 正向来源，尚未生成实际候选。下一步将这些资格条件接成整体读取/判断流程，再写候选，不跳过所缺证明。


复盘读取已增加原始平仓生命周期重建：reconstructReviewTrade 复用终端解码/投影，对 MT5 普通成交要求同 position、正手数、入出方向一致、逐时累计仓位不为负且最终归零；相同毫秒按数值 ticket 排序。reader 复核重建币种、首入/末出 UTC 和聚合摘要，返回重建 projection 供后续候选使用，不只信任记录 closed 标记。MT4 单记录路径复用 projectMt4Trade，尚无本批实库正向证明。

3 项生命周期行为测试、3 项适配器测试及构建通过；review-trade-lifecycle-mysql-v2-20260911.json 10 项真实 MySQL 检查通过，使用完整入/出两笔原始成交夹具，新增“closed 标记且摘要匹配但只平一半”返回 lifecycle_incomplete。临时库删除、现有业务库写入0。独立费用/余额修正事实暂不通过此普通成交重建，必须继续补精确费用归因和计算，不能将该限制作为最终功能范围；采集范围/回执完整性、费用稳定和候选生产仍未完成。


复盘重建已支持独立费用/更正：同一精确 position 的 fee/correction、零手数、非交易方向且时间不早于开仓可纳入；无法归属、跨 position、普通 balance 入金或带交易手数的伪费用拒绝。独立记录 profit 单独累计为 cashAdjustments，净收益=既有交易/commission/swap/fee 合计+现金调整，避免漏计与重复计；账户历史原表和原净收益字段未改写。读端返回 ReviewTradeProjection 供后续候选冻结使用。

7 项生命周期/读取回归及构建通过，review-trade-fee-mysql-v1-20260911.json 11 项真实 MySQL 检查通过：原始净收益9，平仓后独立profit=-0.30及fee=-0.05，重建净收益8.65，保留cashAdjustments=-0.3及原平仓时刻。晚到费用未被时间过滤掉；参考库删除、现有业务库写入0。仍未证明所有费用均已采齐。已定位可复用 HistoryWindowCoverageReader 和 HistoryTaskDealSourceReader，下一项将完整分页回执和精确原文 membership 接入复盘资格；现有 task deal source 仅支持MT5，MT4能力不得默认为已具备。


新增 HistoryTaskDealInventoryReader 与 SQL 适配器，复用实际任务 coverage 和 source readers，要求完整 history.deals pageMembership 的每个 fact hash 都能找到当前账户原始成交，并重新解码身份/摘要，再逐笔验证 task/receipt/completionHash/provenance。不是只校验已关联 record 的成交子集；缺其它 page fact 也返回 inventory_missing。1000 个不同事实的有界限制返回 inventory_limit，不截断后通过。仅 MT5，MT4 明确 unsupported_platform。

3 项定向 Mock 测试及构建/边界通过，覆盖完整清单、缺一笔、替换正文和回执变化；本批未做该适配器真实 SQL 组合测试，未写数据库。inventory_matched 只提升为该 provider 完成回执范围的清单一致，不是终端永远不会补费用的证明。下一项用完整采集夹具验证，然后将清单按精确 position 与 ReviewTradeEvidence 对比，补候选资格；自动候选/日月建案尚未完成。


完整成交清单已纳入现有真实队列采集参考链：history-deal-inventory-reference-v1-20260911.json 内 task queue/queued collection 检查 full-task-deal-inventory-requires-every-collected-page-fact 通过。实际两页 query→MySQL facts/provenance→完成回执→coverage/source/inventory 读取均执行；任一页成交 hash 缺失时 inventory_missing，恢复后再次通过。SQL 与 BullMQ/Redis 为真实依赖，终端 query、精确 route guard 为合成端口；参考库及队列已清理，现有库写入0。报告使用既有历史基线与 scaffold，不是当前全量 schema 外键验收。

新增 createReviewTradeReadinessReader 应用组合及事务 composition：比对用户/账户/平台/记录 revision，要求截止时间不在未来、交易已结束、完成采集覆盖开仓到截止时间，并以 id/ticket/hash 集合逐项核对该 position 在完整清单中的所有成交。漏关联晚到成交、覆盖不足、跨用户 route 拒绝。成功仅返回 ready_as_of 和 task/receipt/completionHash，后续更正必须形成新证据；不是费用永久稳定的承诺。3 项 Mock 组合测试及构建通过，组合后的实际 SQL 尚未跑；历史时区最终建案资格、候选 writer、MT4 路径和日/月建案仍未完成。


复盘资格组合已通过实际依赖验证：review-readiness-reference-v3-20260911.json 新增 review-readiness-composes-real-record-inventory-and-receipt-with-synthetic-classification，实际 BullMQ 两页采集→原始成交/关联记录→完整清单→完成回执→事务内 ReviewTradeReadinessReader 返回 ready_as_of，净收益10、两笔事实与 receipt/completionHash 一致。未归因记录、revision 过期、删除一条成交关联均拒绝；人工归因仅在隔离事务中合成，finally rollback，原采集快照最终复核一致。临时库已删除，现有业务库写入0。

前两次参考报告保留失败证据：夹具虽提供 account_currency，但没有 currency_evidence=explicit_record，因此正确被 record_not_eligible 拒绝；修正合成输入的显式来源标记后通过，没有降低生产资格判断。本次完成组合 SQL 证据验证，未实现真实人工归因、候选 writer、历史时区冻结或日/月建案。下一项仍是手工候选生产和消费闭环。


手工候选生产第一段已实现：reviews 应用层 ManualCandidateCollector 先要求 ready_as_of/manual，再通过调用方提供的当前授权与历史时区证明端口，最后写本域候选；使用消费方自有端口避免 reviews→trade-history→inference→reviews 模块循环，模块门禁0、构建通过。MysqlManualCandidateWriter 在调用方事务中通过唯一交易键写锁串行化，生成现有 id.revision.evidenceHash 选择令牌；完整原始交易、费用、task/receipt/completionHash 和 authority 以不可变候选版本冻结。相同证据重放不新增；令牌过期续期新增版本；旧 record revision/截止时间拒绝；already_reviewed 不重开。

追加候选迁移 server/db/migrations/inplace/073_manual_review_candidate_evidence.sql，尚未登记执行计划或升级 dev_vue。manual-candidate-reference-v2-20260911.json 在真实 MySQL/BullMQ 两页采集链中验证生成、完整载荷、重放、续期旧令牌失效、两版保留、旧截止时间拒绝及已消费不重开，候选表保留其用户/账户外键，证据表保留候选外键；用户/账户父表仍为隔离 scaffold，不能当作完整当前 schema 外键验收。写入在隔离事务 rollback，参考库清理，现有库写入0。v1 因参考快照不包含候选表而失败，v2 改用现有 canonical 候选建表 SQL；失败报告保留。

6 项 collector/readiness 定向测试通过。真实授权和历史时区适配仍未接入（参考测试明确使用 synthetic authority），运行入口未激活该 writer。现有 createManualCase 尚未消费新冻结载荷，因此生成→建案闭环未完成；下一项补冻结载荷消费、源/权限再校验、完整参考 schema 与并发验证，然后登记升级和接线。未提交推送，当前混合工作区无法安全切出独立提交。


手工建案已接入冻结候选载荷：新增 readManualCandidateEvidence，createManualCase 在候选锁内按当前 revision 读取载荷，重算 canonical hash，核对用户/账户/record、截止时间、ticket/position/symbol/side、定点金额、开平仓 UTC 和终端偏移；缺载荷不能退回摘要建案。新建 case evidence 为 review-evidence.v4.2，保留原 trades 摘要并增加 frozen_candidates 完整载荷；已有 case/版本/幂等回放未改写。该源码现在依赖 073 表，升级完成前不得将此构建提升为已就绪运行版本；没有给旧候选伪造冻结证据。

manual-candidate-consumption-v1-20260911.json 真实 MySQL 验证通过：正文被改而 hash 未改→corrupt；正文/hash 一起换成其它账户→scope_mismatch；当前候选版本载荷缺失→unavailable；三种失败后 case/job/receipt/outbox 均为0。并发手工建案返回相同结果，生成证据完整保留 candidate_id/revision/payload，后续六类 review 写入、commit ACK 丢失重放和所有者撤销回放拒绝仍通过。此消费参考证据/authority 为合成，不是实际终端/历史时区证明，尚未将真实采集和完整建案放进同一参考流程。6 项原手工写入回归、构建/模块门禁通过。

manual-candidate-full-schema-v1-20260911.json 完成当前 dev_vue 260 步/309 表全部 DDL 的隔离克隆，追加 073 一张证据表且保留到 manual_review_candidates_v4 的真实外键；原表无删除。隔离库删除、现有库写入0，无数据复制。新增 source loader 和完整 schema 验证脚本；升级注册、恢复库演练及 dev_vue 升级尚未执行，当前仍260步/309表。下一步据该报告追加261步升级计划，再做恢复库/当前库升级，随后补实际历史授权与时区适配、候选源更新复核和运行接线。


073 冻结候选证据表已完成升级：新增 loadManualCandidateUpgrade，将当前260步追加为261步，引用完整309表参考报告及源文件 SHA256，旧步骤不变。manual-candidate-restored-v1-20260911.json 记录恢复库升级、DDL实际完成后注入ACK丢失并恢复、重放零DDL、原数据逐表行数/内容hash不变；manual-candidate-current-v1-20260911.json 记录 dev_vue 同计划升级和相同数据/旧checksum保护。两库现均261步/310表，只新增一张证据表，业务行写入0。沿用已验证备份receipt并核对SHA256，未重新创建全量备份。

计划hash ba5726467ee7d4d0c00b1028856e64a8e5b34bdd6c2079d4e3a798454ddabc4d；当前升级后快照hash 7cd7007509eb0380044c67c8ee82454bd0464adbbd4d1392bd64d35a40616d03，恢复库 c87e6cbd695caff4d1ceef0e562260ef4dce24b7f718f51c859134bd7bad9826。运行schema生成门禁同步为261步/64张必需表，服务端构建、104项运行合同、模块边界通过；两个读取当前库的参考脚本同步使用新计划，旧升级证据/脚本不改写。上一批“073尚未升级”的条件已解除，未重启服务或激活候选生产入口。

剩余仍为候选来源/历史时区与当前授权实际适配、建案时源更新再校验、完整采集→候选→建案单链证明，以及系统单笔/日月自动采集与运行接线；本次追加表不等于自动复盘已完成。


真实归属端口已实现：trading/OwnedHistoryAccessReader 与 createMysqlOwnedHistoryAccess 由交易账户域拥有，经 index/composition 分别公开。调用方事务中先通过 auth ActivePrincipalAccess 锁定活跃主体，再核对当前 ownership/revision/interval/granted 时间和历史精确 interval，拒绝跨平台、账户删除、当前其它所有者、历史区间冲突；历史证据不得越过所有权结束边界。输出当前 ownership revision/current interval 及 historical interval，供复盘冻结。当前用户重新取得账户时可以查看其原有历史区间，不把其它用户的历史转移给当前所有者。

review-owned-history-v2-20260911.json 在当前261步 schema 相关7表的隔离克隆执行实际 SQL/ActivePrincipalAccess，当前/历史正确归属通过，撤销、revision变化、用户/账户删除、平台不符、历史区间重叠拒绝，并保持原交易证据/费用11项检查通过。参考父表保留原定义但本脚本移除FK，不能作为全外键验证；临时库删除，现有库写入0。v1 因合成重叠区间复用 origin_ref 触发唯一约束，修正fixture为独立origin后v2通过；失败报告保留。构建/模块门禁通过。

已检查的 AccountClockReader/readTransactionAccountClock 仅提供当前快照与其当前 provenance，不提供开平仓历史区间的时区有效范围。本批没有用当前 calibrated 偏移补历史，也未实现历史时区来源。新增归属端口尚需在 bootstrap 接入 ManualCandidateAuthority；历史时区真实保存/读取及源更新再校验仍是下一步，候选运行入口仍未开启。


候选事务组装已新增 createTransactionManualCandidateCollector：在 bootstrap 连接实际 trade readiness、auth ActivePrincipalAccess、trading OwnedHistoryAccess 和 reviews writer；调用方必须显式提供 HistoricalClockReader，不提供当前时钟或固定偏移默认实现。createManualCandidateAuthority 冻结实际归属读取结果，并要求历史clock的用户/账户/平台/interval/task/receipt/completionHash全部匹配、有效区间覆盖开平仓（结束半开）、偏移与交易证据一致、摘要和终端身份非空；授权已撤销时先拒绝，不再读时钟。

6 项组装 Mock 测试覆盖正向、无归属、无历史clock、回执不符、偏移不符、结束边界和无效日期；构建/模块门禁通过。新增 HistoricalClockReader 仅为交易域公开合同，尚无历史区间持久化/真实读取实现，不把组装测试当成真实历史时区证明。本批未连接或写入数据库，候选运行入口未启动；完整SQL组合验证和历史clock来源仍待完成。


人工单笔时间语义已纠正：按用户“数据库UTC，实验室显示终端时间”要求，精确交易ID的人工候选不涉及自然日/月分组，不能额外强制历史时区区间才能建案。实施方案已补两轮复审：历史归属、完整UTC成交/费用/采集证明保持，终端偏移标为 collected_record_offset/display-only/historicalIntervalVerified=false；日/月周期仍需要历史边界证明。删除上一批未使用且无真实来源的 HistoricalClockReader 空合同；bootstrap ManualCandidateAuthority 改为真实归属加UTC生命周期/偏移合法性，完整事务组装不再注入时钟替身。没有改动073或任何已执行迁移。

manual-candidate-real-authority-v3-20260911.json 已在真实SQL/BullMQ两页采集→完整成交/回执→ReviewTradeReadiness→真实ActivePrincipalAccess/OwnedHistoryAccess→候选writer链路验证；生成、重放、续期、已消费不重开继续通过，撤销当前ownership时组合直接返回review_ownership_unavailable。明确冻结UTC时间语义和显示偏移用途，不宣称该偏移为历史夏令时证明。归因manual和终端query仍为合成；账户父表为最小scaffold，非全量FK业务验收；临时库清理，当前业务库写入0。v1因夹具重复ADD已有deleted_at_utc失败，v2修正后通过，v3追加授权撤销组合验证通过。6项时间/授权测试、构建和模块门禁通过。

后续人工链路重点为真实归因生产、创建case前源revision再校验、采集→候选→完整建案单链验证、scheduler/worker接线；人工单笔不再被无关历史时区门阻塞。系统单笔、日/月复盘及整体运行验收仍未完成。


人工归因生产已接入采集器：新增 terminalManualAttribution，对同精确position、不同ticket、存在入场和出场且全部为普通交易事实的集合，要求每笔明确DEAL_REASON_CLIENT/MOBILE/WEB（含MT5数值0/1/2）才返回manual/exact；不使用magic/备注推断。费用/余额的CLIENT不能证明人工来源；SL/TP/EA或不完整原因保留unknown/unresolved。依据MetaQuotes成交属性定义 https://www.mql5.com/zh/docs/constants/tradingconstants/dealproperties 。这是明确人工来源路径，不是系统执行/自动止损/独立费用的完整归因实现。

MysqlTradeHistoryCollectorRepository 在MT5持仓重建后写入上述归因，并在原文或归因改变时推进record revision，MT4原有更新行为保持。manual-attribution-collection-v1-20260911.json 使用合成终端reason=0/1的实际两页采集，通过实际SQL生成manual/exact，再进入完整回执/readiness/真实归属/候选写入；移除之前测试直接UPDATE manual/exact的做法。终端query本身仍为合成，不能称为真实MT5验证。参考库清理，现有业务库写入0。2项分类边界测试、构建/模块门禁通过；其它来源精确映射、建案前源再校验及自动调度仍待完成。


建案前源复核已接入实际API组装：reviews新增消费方ManualCandidateSourceVerifier端口；bootstrap createTransactionManualCandidateSourceVerifier 在当前建案事务复用真实ReviewTradeEvidenceReader和OwnedHistoryAccessReader，要求当前记录revision、完整重建证据canonical值及当前/历史归属与候选冻结内容一致。api-v4显式传入该事务工厂，reviews不跨模块访问其它域内部。新建案未配置工厂时返回manual_review_source_verifier_unavailable，不默认放行；既有case幂等回放继续按已提交回执与当前case权限检查，不重新消费候选。

manual-source-revalidation-v1-20260911.json 在实际两页采集→候选生产链中调用真实source verifier：相同源通过，record revision推进或当前所有权撤销返回manual_review_source_changed；隔离库清理，现有库写入0。7项原建案事务回归通过，新增source拒绝时case/job/outbox写入0；构建、104合同、模块门禁通过。manual-source-case-transaction-v1-20260911.json 继续验证实际MySQL建案/回执/版本事务，但其中source端口为显式替身（报告scope已标注），不能与前一报告合称单次全链实际验证。下一步将实际采集候选和实际source复核连接到同一次createManualCase事务，再接自动候选调度；系统单笔/SL/TP/费用归因与日/月仍待完成。本批未迁移或启动服务。


人工采集到建案单链参考验证已完成：新增 history-manual-case-reference，并接在实际两页history task采集链之后。候选使用 createTransactionManualCandidateCollector 实际读端/归属/写端提交，再由 ReviewService + MysqlReviewRepository + createTransactionManualCandidateSourceVerifier 在独立事务建案，源复核端口没有替身。manual-collected-case-chain-v1-20260911.json 的 manualCase 子报告记录：源revision变化拒绝且case/job/receipt为0；恢复源后两条并发请求返回同一case；仅1case/1job/1receipt/2outbox；冻结payload保留原task/record、两笔成交、净收益10和实际ownership；原请求回放不新建，换key再次消费拒绝。

参考MySQL/Redis与仓储为真实，Bridge query仍为合成、策略及账户前置域为最小scaffold，复盘表来自012和049并保留对应外键，不是完整当前schema的全功能验收；未调用模型、终端或公网。候选与case为隔离库实际COMMIT，整个参考库结束后删除；现有dev_vue业务写入0。脚本语法、diff检查通过，未改服务端源码所以不重复构建。下一项是自动候选任务的持久化/扫描与worker接线，同时继续补系统单笔、SL/TP/费用来源及日/月采集，整体目标仍未完成。


自动候选批处理入口已实现：trade-history/ManualCandidatePageReader 在所属域读取 succeeded task 的冻结route、重算route摘要，并复用实际completion/receipt coverage校验。按历史所有权、账户/平台、UTC开平仓范围、manual/exact筛选，以record UUID稳定键游标读取limit+1，每页上限20；bootstrap createManualCandidateBatch 在短事务逐项复用真实候选collector，返回每条结果和下一游标，不把unresolved当成功候选。提交ACK不确定销毁连接并返回manual_candidate_batch_commit_unknown，重跑靠候选唯一键和证据版本幂等。

manual-candidate-batch-chain-v1-20260911.json 将完整采集→建案参考链的手工指定record生产替换为实际batch发现：从taskId找到记录、提交候选；重跑unchanged；随后实际source verifier并发建案；消费后重跑already_reviewed。真实MySQL/Redis通过，临时库删除、当前业务库写入0；仍为合成终端query和最小前置域，不是全量运行验收。服务端构建/模块门禁通过。本批仅实现并验证批处理函数，尚未增加outbox完成事件、持久任务游标/失败重试记录或注册BullMQ Worker，不能称为自动调度已经启用；下一步补这些队列生命周期能力和多页/重启验证。


候选任务持久化已实现（074候选迁移，尚未登记或升级共享库）：manual_candidate_tasks_v4 按history_task_id唯一，保存pending/waiting/succeeded、页游标、成功提交的page_attempts、逐项结果和数据库UTC重试时间。MysqlManualCandidateTask 使用短事务任务行锁，调用相同connection的page processor，候选与游标一起提交；有unresolved则保持本页并延后60秒，已完成任务重跑不处理；不额外引入长lease。bootstrap createManualCandidateTaskRunner已组装真实page processor；旧batch入口复用同一实现。

manual-candidate-durable-task-v2-20260911.json 真实SQL完整采集/候选/建案链通过：候选写入后故意抛错，任务行和候选均回滚为0；授权撤销进入waiting且游标null；实际COMMIT后注入ACK丢失抛review_commit_unknown，重读仍为waiting；恢复授权并到期后双并发run仅完成一次，page_attempts为2（一次等待、一次成功）；后续实际source复核建案链仍通过。v1记录未注入ACK丢失版本，v2追加通过。参考库清理、当前业务库写入0，终端query及前置域仍为合成/scaffold，非真实终端验证。构建/模块门禁通过。

下一项仍需074完整schema与恢复/当前库升级、完成事件outbox及BullMQ Worker/恢复扫描接线、多页恢复验证。当前只具备持久任务run函数，没有自动触发；异常整页回滚交由后续队列重试，尚未增加独立异常次数/最后错误的持久失败记录。整体目标继续保持。


074候选任务表已完成升级：candidate-task-full-schema-v1-20260911.json 基于当前261步/310表完整DDL克隆，验证新增表及到history_collection_tasks_v4外键，旧表无删除。candidate-task-restored-v1-20260911.json 恢复库完成实际DDL后ACK丢失恢复及重跑零DDL；candidate-task-current-v1-20260911.json 当前dev_vue同计划升级通过。两库现262步/311表，原业务逐表行数/内容hash、旧步骤checksum均不变，业务行写入0。沿用已验证备份并核对receipt hash，未重复制作全量备份。

计划hash 7dfe11729f9203c6f8328f1c5cc72a8e8be8c23b9d31b0494dd7825900919ca7；运行schema门禁更新为262步/67张必需表（含新增任务表的外键依赖），构建/104合同/模块边界通过，当前库参考读取脚本跟随最新计划。最初生成升级loader时误替换报告日期，预检读文件失败、未连接执行DDL；修正后才完成演练和升级。没有重启服务、开启自动任务或调用终端。下一项为完成事件、outbox到队列、Worker及恢复扫描接线，自动候选尚未启用。
