# 部分平仓后保护的串行工作流

状态：方案复核完成，分步实现中。当前运行没有自动执行后续保护；原同目标close/modify冲突规则继续保留。此方案只涉及本地源码、测试和开发库增量兼容，不授权真实终端交易或公网操作。

## 已核实缺口

risk/partial-close-actions已经按冻结持仓和合约精度计算比例平仓数量，并拒绝同目标的close_position与modify_position并行。Bridge命令仍是一条一条执行；persistResult保存回执和operation.changed，不能独自证明成交已经反映到新持仓。projection-absorption可核对剩余数量，但数量相等不能单独作为原命令成交归因。当前execution_intents没有依赖阶段，不能仅把保护动作附在close参数里然后忽略。

## 决定与模块所有权

采用execution拥有的持久化“平仓后保护”专用工作流，不新增通用任意DAG。原close继续经过现有risk→intent→Bridge链。冻结的后续保护意图只包含精确目标、保护价、父intent/command及期限；不是预先批准的第二条终端命令。比例和价格都来自用户/模型明确意图及risk确定性换算，不在服务端硬编码80%或入场价±1.00。

trade-history提供精确父命令/成交/position identifier关联证据；trading提供新完整仓位快照和当前route/合约；risk在同一短事务作用域复核当前授权、停机、账户、行情/合约、价格、目标、版本及保护权限；execution保存续作审核回执和派发状态。AI不参与回执对账，也不直接生成不可追踪的新trade_decision冒充原始模型结果。

## 顺序及恢复

1. 冻结workflow意图、原数量、已批准close数量、目标身份和期限，并绑定唯一父close intent/command。仅close进入可派发状态。
2. pending时等待；uncertain时只调用现有对账链，不重发命令；明确失败/取消则停止续作。
3. succeeded仍等待精确历史成交证明。必须匹配父intent/command、账户/终端/券商/login、symbol/side/position identifier及实际关闭数量。空历史或仅数量变化不算证明。
4. 等待比原revision更新、观测时间不早于成交完成时间的完整新快照。剩余数量用定点十进制核对；目标消失或外部修改导致不匹配时停止旧续作，不能按品种找另一个仓位。
5. 进入risk_review_required，重新审核冻结保护价与当前风险上下文，不沿用平仓前的expectedState或风险批准。审核通过后才创建保护intent、当前expectedState及outbox。
6. 保护命令结果未知只对账；只有自己的保护结果和后续快照证明保护生效后才算整个workflow完成。过期或拒绝必须呈现“平仓已完成但保护未完成”，不能合并为succeeded。

需要持久化workflow/attempt审计并复用operations、intent、Bridge ledger和outbox。续作使用明确的position_workflow来源，不能伪装为user_command或重用唯一trade_decision风险回执。SQL仅追加，枚举/来源分支和readiness须随迁移一并覆盖；所有current升级先在恢复副本验证。现阶段先实现步骤2-4的纯判定，不开放外部合同或派发。

## 两轮复核

第一轮：专用串行流程满足旧策略动作顺序，职责分属execution/trade-history/trading/risk；Bridge协议继续使用现有position.close和position.protection.set，不引入桥接端策略。拒绝放宽原并行动作冲突规则、生成假AI决策、将队列作为事实库。

第二轮：重点检查未知结果重放、父子身份、成交归因、旧快照重用、净持仓外部变化、数量舍入、期限、风险版本和崩溃恢复。资格判定仅返回“需要当前风险审核”，永不直接返回可派发命令。后续持久化必须同事务写workflow阶段/审核回执/唯一子intent/outbox，独立事件按ID唤醒；重复投递不能产生第二次平仓或保护。

## 验收与剩余工作

先覆盖确认丢失、迟到/错账户证明、重复ticket、旧快照、数量不符、仓位消失、换账户/终端、大小数精度与超时；然后实现持久化、原intent关联、事件唤醒、当前风险复核、子intent及结果归并。恢复副本必须验证开始/提交/派发确认丢失和重放零附加命令，现库旧表/旧行/历史必须保留。纯函数测试通过不是持久化/Bridge/真实账户验收。


## 首步实现证据（2026-09-10）

execution/domain/partial-close-protection.ts已实现步骤2-4的纯资格判定，24项相关测试和server类型/边界/合同生成检查通过。未知结果即使过期仍返回reconcile_close，续作不会因此恢复派发；成功仅返回risk_review_required。输入历史证明仍依赖后续适配器建立，当前没有运行调用者。持久化、风险复核和结果归并继续实施，不能据此声明工作流已完成。


## 注册持久化候选与复核（2026-09-10）

新增056候选partial_close_workflows_v4及partial_close_workflow_events_v4，均为追加新表。工作流ID、父intent、父command各自唯一；父级、用户、账户及事件外键保留，计划正文与摘要不可变。候选未登记当前升级日志、未应用dev_vue；后续必须单独完成父结构准入与恢复副本演练。

注册写入器只经execution/composition组装，公开应用端口不导出MySQL。它使用调用者事务，先锁账户，再锁父intent/command，核对用户/账户、原action及hash、Bridge request/hash、精确route/ticket/方向/品种、原数量、close数量和positionsRevision。新注册仅允许父intent仍prepared、命令queued且未过期；目标读取端口必须在同一事务锁定当前授权仓位并提供稳定identifier。现有Bridge expected_state没有该identifier，不能由ticket单独推出。接入点应在命令创建事务内、父命令及payload插入后、意图离开prepared与outbox提交之前；不能在命令已派发后补注册。

第一轮复核：写入器不自行BEGIN/COMMIT，必须由原命令创建事务组装；账户优先的锁顺序与执行模块一致。目标读取端口尚未绑定实际trading实现，不将测试注入的目标当成真实授权证明。外部合同、原意图解析和运行调用入口尚未开放。

第二轮复核：相同父级和正文允许重放，即使原命令已经完成；不同工作流ID/父级/价格/正文拒绝。重放同时验证持久计划及注册审计摘要，审计缺失不能回成功。原事务已提交而确认丢失不生成第二条计划或命令。后续owner必须遵循commit_unknown处理约定，不能把连接失败当成未提交。

strategy-write-reference-v73使用真实MySQL两会话验证竞争、计划/事件共同回滚、事件失败回滚、实际COMMIT后注入确认丢失、完成后重放、变更冲突、正文损坏、审计缺失和事件外键。056两张完整候选表及其外键实际创建；execution父表为最小查询支架，targetReader为注入端口，尚非完整执行DDL/授权链或恢复副本演练。随机库已清理、existingDatabaseWrites=0。v72为前一轮通过报告，保留原始证据。


## 当前目标端口与组装（2026-09-10）

trading新增ExecutionPositionReader及独立MySQL实现，不继续向大repository追加查询。先调用同事务TerminalFactRouteGuard锁定账户、归属区间、会员/设备凭据、绑定和精确连接，再检查暂停设置、会话心跳、投影来源/revision及观测新鲜度。读取整个仓位集合，任一混合revision、坏payload、重复ticket或重复非空identifier都会拒绝；目标ticket与identifier必须同时精确匹配，数量仍保持十进制字符串。调用者配置1至60000毫秒的新鲜度窗口，测试使用30000；这不是终端行情或交易权限批准。

bootstrap/partial-close-registration.ts将实际trading读取与execution注册写入器绑定同一连接。完整gateway route由调用者在短事务前取得并冻结，进入事务后重新核验当前设备/归属/会话；不在事务内请求Redis。注册端口新增command connectionEpoch，要求父命令表、冻结request及读取route的epoch一致。这里只是组装工厂，原命令创建入口尚未调用；未启动服务。

第一轮复核保留模块所有权：trading提供仓位事实，execution负责冻结计划和事务，bootstrap负责连接二者。第二轮补查新鲜度空值：NULL心跳不能经Number(null)误作零延迟，现已明确拒绝；数据库错误继续抛出，不伪装成空仓位。

44项定向测试、完整server类型/构建、模块和98操作合同/schema门禁通过。reference-v76在真实MySQL临时最小结构上执行现有完整route授权SQL、新仓位读取和实际注册工厂，29组目标检查通过，注册数据事务回滚、随机库清理、existingDatabaseWrites=0。涵盖撤销归属/会员/凭据、换安装/终端/连接、错broker大小写/login/epoch、暂停、缺失/过期/未来心跳或投影、identifier缺失/复用及混合集合。临时父表不代替完整DDL验收，未使用真实终端。v74夹具对同一临时表INSERT SELECT触发ER_CANT_REOPEN_TABLE；改显式独立行后v75通过，补空值验证后v76通过，原报告全部保留。


## 精确回执入口（2026-09-10）

已核对Mt5TerminalCommandSource→TerminalCommandSourceSupport.FromMt5→Python trade._result的实际结构：服务器结果包含raw_result与evidence，不保证顶层order/deal。新增closeReceiptTickets统一读取明确order/order_ticket、deal/deal_ticket及evidence数组，校验别名一致、position与目标一致、ticket为精确uint64。bare ticket/position、剩余数量、already_absent均不能证明本命令成交；不通过魔术号、注释、时间接近或品种猜订单。

execution新增PartialCloseReceiptReader及MySQL实现，绑定精确父intent/command、用户/账户、route、成功状态及当前result_message_id/result_sha256，重新核对命令请求正文/hash、参数/expectedState/epoch/issued时间与计划。结果完成时间必须与命令元数据一致，成功不得附带错误；回执摘要按原wire payload重新计算。terminal_code落库转为VARCHAR会失去原number/string/可选字段类型，读取仅尝试合同允许的编码且必须匹配原hash，不改写旧数据或放弃摘要校验。

第一轮复核明确此输出只是历史校验入口，尚不是PartialCloseHistoryProof；稳定identifier来自注册计划，实际成交事实与完整性还需历史域验证。第二轮覆盖现代嵌套结构、别名冲突、大ticket精度、already_absent成功、迟到/非当前回执、错误scope、错时间/hash以及可选terminal_code编码。34项定向测试、完整server类型/构建和模块/合同/schema门禁通过；reference-v77真实MySQL只读快照及25项scope/损坏/编码检查通过。父表为临时最小查询结构，非完整DDL/真实终端验收；随机库清理、现库零写入。

下一步读取该明确关闭订单的全部成交，要求任务完整覆盖和逐成交页面成员/来源摘要，匹配position identifier/方向/数量及回执中的成交编号，再生成历史证明。缺证据继续等待，不能把本轮回执入口直接作为保护派发许可。


## 完整关闭订单成交证明（2026-09-10）

trading-history新增ClosedOrderHistoryReader，按账户和明确关闭订单读取全部持久成交，不用时间、position或方向SQL过滤掉冲突行；复用已有(account,order,id)索引及1000条上限。逐行重新解码原文/hash，校验编号、订单和发生时间，再按稳定position identifier、相反成交方向、entry=out及命令时间窗汇总18位定点数量。明确零数量费用可以保留但不计入平仓量，回执锚点必须属于实际closing fill；in/inout/out_by、混入其它订单、重复编号、错误数量等均不生成证明。

同一完整历史任务必须覆盖命令窗口；复用HistoryWindowCoverageReader及HistoryTaskDealSourceReader验证完成回执、页面成员和逐笔来源。每笔成交的DB ID、fact hash、provenance hashes及task/receipt/completion hash都须一致。单纯累计数量一致仍不足；没有本任务来源的额外成交明确source_missing。

bootstrap/partial-close-history-proof.ts把指定原命令回执与该历史端口连接，按原关闭量重新核对输出，返回带resultHash、orderTicket、task/receipt/completion摘要和每笔来源的VerifiedPartialCloseHistoryProof。允许相同账户/终端在更高epoch重新采集历史；拒绝未来命令epoch或身份变化。实际工厂先调用同事务route guard，SQL错误保留；只生成证据，不创建命令。纯资格判定消费该证明后仍只返回risk_review_required。

第一轮复核：事实读取、确定性数量核对、任务来源完整性和execution命令归因分属各模块，bootstrap组装；不把Bridge原始volume浮点值或position消失当成关闭数量。第二轮：核对多成交、费用、反转、窗口错配、相等数量但缺页面、重新计算hash的错误内容及回执/历史scope一致性。79项定向测试、完整类型/构建和模块/98操作合同/schema门禁通过。

history-completion-transaction-reference-v45真实MySQL/Redis隔离链路通过：实际历史task/collector写入两页成交、完成回执和来源，再在只读快照读取关闭订单证明；坏正文hash、错误来源、额外无页面成员成交均拒绝。额外成交即使使数量等于请求值仍source_missing。历史表来自实际迁移；终端query与调用者权限仍为测试注入，命令编号为显式测试锚点，不证明真实终端或全部父命令调用链。随机库/自有队列清理、existingDatabaseWrites=0。v44为前一轮通过证据，均保留。

下一阶段应贯通现有父命令创建与持久化工作流推进，不继续把独立读取端口当成工作流完成：补显式后续保护意图合同、当前风险审核/回执、唯一子intent/outbox和保护结果归并，再验证完整DDL、故障恢复和现库增量升级。056仍为未执行候选。


## 2026-09-10：父命令注册编排已接入，运行能力仍关闭

显式合同见partial-close-intent-contract-20260910.md。新增执行域计划构造和同事务注册回调，普通close不查询056，带续作close在未配置能力时拒绝。父命令重放经repository重新核对，queued恢复也不能绕过尚未实现的子工作流能力。217项定向测试和类型/构建通过，父事务编排仅模拟连接；真实SQL整笔原子性、COMMIT未知处理与实际route捕获工厂是下一项验收，不将已存在的独立writer真实库测试替代新父事务验收。未修改数据库、未启用入口。之后继续持久阶段推进、当前风险审核、唯一子intent/outbox及结果归并。


## 2026-09-10：父事务真实库恢复证据

strategy-write-reference-v84已使用真实MysqlBridgeCommandRepository与writer，在隔离InnoDB库证明父命令、payload、计划、审计和outbox三处失败原子回滚；COMMIT已成功但确认丢失返回明确unknown并丢弃连接，原请求恢复不重复建命令或outbox。改变保护正文重放冲突，queued恢复仍被子工作流能力门拦截。父创建UTC SQL绑定缺陷已由真实库复现并修复、毫秒验证通过。bootstrap路由捕获工厂完成，未启用入口。94项测试及类型/构建通过。

数据库父表/权限表是查询脚手架，目标读取注入；未替代完整DDL和真实route授权联调。开发库无写入、056未执行。后续优先修正其余执行生命周期的同类SQL时间绑定，接持久阶段推进/风险审核/保护子intent/outbox/结果归并和完整DDL恢复演练。


## 2026-09-10：执行生命周期时间缺陷收口

主计划409完成命令repository其余UTC SQL时间绑定，v86实际InnoDB验证dispatch/accepted/result/outcome/风险reservation/operation/distribution及未知结果对账。dispatch和result COMMIT确认丢失返回unknown并能按持久状态恢复，不重复派发状态推进或插入回执。80项测试及类型/构建通过，SQL脚手架不等于完整DDL，无真实终端，现库无写入。回到后续持久工作流推进/当前风险审核/唯一子intent-outbox/结果归并及完整DDL恢复演练；入口继续关闭。


## 待审核阶段持久化设计与两轮复核（2026-09-10）

本步复用056现有表：awaiting_close在父命令状态、精确历史证明和新完整仓位满足后，单事务转risk_review_required，并写包含计划hash、历史来源证据和新仓位摘要的审计、仅携带workflow/account/user/revision的outbox。等待缺失证据时不重复写审计；明确失败/目标消失/数量改变转stopped，过期转expired。uncertain优先对账，即使过期也不得当作可重复平仓或已完成。已持久推进的阶段重放返回原审核请求，不据旧请求授权保护命令。

第一轮复核：execution拥有阶段/审计/outbox；应用端口接收同事务history和projection读取器，bootstrap必须在事务外捕获route。工厂不获取Redis、不自行下单；风险审核和子intent是下一步独立职责。恢复扫描及outbox消费者未就绪之前不接运行入口。

第二轮复核：采用账户→父intent→父command→workflow锁顺序；校验scope、计划摘要和注册/当前审计；阶段/审计/outbox同事务，revision和event唯一键约束重复投递。提交确认丢失沿用明确unknown和原ID重读，已进入待审核只重放原记录；后续审核必须再验证当前事实和期限。测试区分真实SQL存储和注入事实端口，不能将状态推进证据当作真实MT成交/保护成功。


## 2026-09-10：待审核持久推进实现证据

主计划410实现进度工厂：真实事务更新workflow、写完整历史来源/新仓位摘要审计及ID-only outbox；等待不重复写，unknown优先对账，明确失败/数量不符停止，过期不依赖历史。已推进重放原审核请求，后续必须重新校验父命令/期限/当前风险，不能将旧请求当批准。

v90真实InnoDB11组测试覆盖scope/plan/audit损坏、等待/停止/过期、事务故障、COMMIT确认丢失恢复和两会话竞争唯一推进。101项定向测试与类型/构建通过。history/projection端口仍注入、父表查询脚手架，实际projection/审核上下文/运行消费者和子intent未接；现库零写入、056候选不变。继续实际projection→当前风险审核→唯一保护子intent/outbox→结果归并/恢复扫描和完整DDL恢复演练。


## 2026-09-10：实际当前完整仓位事实接线

ExecutionPositionCollectionReader复用既有同事务权限/provenance/完整集合检查，原精确目标reader改为基于集合筛选。bootstrap最新目标projection与progress事实捕获工厂已绑定实际历史和仓位reader，不再需要调用者手工构造当前仓位projection。空的已验证集合可停止续作，来源缺失/目标identifier未知继续等待，同symbol其它仓位不能替代。

74项测试及类型/构建通过，v92实际MySQL31项授权/注册/最新仓位/空仓验证通过（历史proof在projection资格测试仍注入）。完整持久progress+实际history+实际projection同事务联合验收尚未完成，风险审核、子intent/outbox、归并和运行消费者仍未接；现库零写入、056候选状态不变。


## 当前保护风险审核合同与两轮复核（2026-09-10）

现有evaluateRisk对riskReducing提前返回，且UserExecutionCommandService使用用户命令身份/数据库记录，不适合直接伪装为续作来源。本步在risk新增独立PositionProtection审核端口，复用EffectiveRiskPolicy/AccountRiskSummary及统一RiskEvaluationResult，不伪造AI决策。输入明确workflow ID/revision、原目标、要求的新仓位下界revision、剩余量、期限和冻结保护价；当前上下文由调用者同事务读取并授权，输出保留input/context/policy摘要和当前expectedState。

第一轮复核：只支持已有冻结的设置SL/TP意图，不扩展删除保护或任意调整仓位；明确停机、发送开关、授权/暂停、账户scope、当前完整/新鲜数据、可信时钟、合约/quote一致与新目标/数量。保护不增加仓位，不套用新增仓位数/开仓频率/日开仓上限，不使用manual release豁免。SL不得放宽现有止损，TP必须在当前平仓报价正确一侧，价格按tickSize精确格点判定；不按strategy ID/旧策略数字硬编码。

第二轮复核：固定18位十进制BigInt完成价格/数量比较与spread/tick计算，禁止Number近似把相邻大价格视为相等；账户/终端/稳定identifier/ticket/方向/品种及现仓量必须精确，原仓位revision不能复用，expiresAt和数据时间使用调用者可信UTC now。审核通过仅返回modify_position action和当前版本，不直接创建/发送命令；执行域必须在同一事务写审核审计、唯一子intent和outbox，并在派发前再核当前权限/状态。实际上下文reader、联合事务和子命令尚未完成前不开放运行入口。经纪商其它约束仍以终端回执为准，本阶段不虚构缺失的stops/freeze level。


## 2026-09-10：独立审核与当前保护事实实现证据

主计划412完成独立保护审核与应用端口，完整集合读取保留SL/TP精确值、明确null与unknown区别。118项测试、类型/构建通过；v93真实隔离MySQL32项目标事实检查通过并清理，现库零写入。实际风险上下文/SQL clock绑定、审核与唯一子intent-outbox事务、结果归并和消费者未完成，056及入口未启用。继续实际上下文→子工作流→联合验收/完整DDL恢复→业务回填/canonical/记忆剩余项。


## 2026-09-10：实际风险汇总与SQL时钟输入

主计划413新增严格V4风险汇总事务reader及可信SQL clock。73项定向测试、类型/构建通过；v96真实MySQL目标/风险事实41项通过，临时库清理且现库零写入。v94/v95参考helper误嵌套事务的失败报告保留，v96修正调用位置。完整交易上下文/审核-子intent事务、结果归并与运行消费者尚未接，056未执行。继续账户/quote/合约事实与bootstrap组装，再推进子工作流、完整DDL恢复、业务回填/canonical/记忆剩余项。


## 2026-09-10：当前账户事实与行情来源缺口

主计划414新增同事务ExecutionAccountReader，104项测试、类型/构建及v97真实MySQL49项目标/风险/账户检查通过，现库零写入。核实行情尚无provenance，且现有CHECK不允许market.quote；下一步先追加来源约束增量与新quote同事务写入/readiness，保留旧记录且不猜测回填，再接可信行情/合约和完整审核上下文。审核子工作流、完整DDL恢复及业务/canonical/记忆仍待完成，运行入口不变。


## 行情来源增量设计与两轮复核（2026-09-10）

为现有trading_projection_provenance_v4追加057候选，仅以一个ALTER原子替换kind CHECK，允许既有三类和market.quote；保留表、PK、FK与现有行，不回填无法证明的旧quote来源。可信quote的snapshot/revision/provenance须在原applyTrustedProjection事务保存。阶段接入采用显式同事务writer能力，未完成完整升级readiness前不接运行入口；配置writer但schema不支持时明确拒绝并回滚，不能吞掉来源写入失败。

第一轮复核：应用端口只描述已锁定route/ownership与quote来源写入，基础设施实现DDL能力检查及SQL，已有repository拥有事务/授权/CAS；不另开事务、不从Redis读取新route。第二轮复核：验证旧三类行不变、旧CHECK拒绝quote、新CHECK接受quote且拒绝其它kind、FK仍有效；实际snapshot/revision/provenance写入失败回滚与重复revision不重写必须验收。旧schema下默认入口仍保持现状，保护上下文不信任无来源quote。现库升级协调器与准确表hash/readiness还需后续独立接入，候选DDL验证不等于现库已升级。


## 2026-09-10：行情来源候选实现证据

主计划415完成057候选CHECK增量与显式同事务quote来源writer；26项测试、类型/构建通过。v101真实MySQL实际020来源DDL/FK及057 ALTER验证旧行保留、类型约束、旧schema拒绝、真实repository quote/revision/source原子回滚和重放，权限SELECT仍注入。随机库清理，现库零写入。v98/v99元数据字符集/转义渲染失败已修复，报告保留。057正式升级协调器和启动profile/tablehash尚待接入，运行能力未启用；继续quote reader/合约锁/完整审核上下文、子工作流及其他核心剩余项。


## 2026-09-10：行情来源升级协调与启动版本

主计划416完成204→205计划、确认丢失恢复协调和生成式schema要求。trading readiness按准确journal切换新旧表hash，专用能力入口要求完整205步；32项测试、类型/构建通过。v102真实隔离MySQL开始/DDL/完成确认丢失恢复只执行1次ALTER，旧行保留；前204条history为fixture，未代替整库恢复副本演练。现库零写入，057未应用、运行入口未启用。后续补现库升级/恢复副本证据及quote reader/合约锁/完整审核、子工作流和其他核心剩余项。


## 057恢复副本与现库升级执行范围复核（2026-09-10）

新脚本仅允许现有已验证恢复库dev_vue_m1_source_20260910_02或专用现库脚本的dev_vue，分别prepare/apply/replay。绑定原加密备份校验、key存在、已执行055的冻结演练和204步history、057计划及脚本摘要；持同连接升级锁、检查UUID/UTC/非恢复模式/无其它客户端。每阶段比较270张表，除journal记录和唯一来源表已审核CHECK结构外，所有269张业务表结构/行摘要保持不变，来源表行摘要也必须不变。

第一轮复核：先恢复副本0/1/0，再现库只读核对与演练数据一致，之后现库单条ALTER及零DDL重放；不写行情、不回填来源、不启用运行能力。第二轮复核：源数据漂移、旧history变化、其它客户端、脚本变化、备份损坏/缺key和不符合已审核前后hash均停止；已存在报告及baseline用wx保护，不覆盖历史证据。现库升级证据必须读取实际三个报告后生成，不提前宣称完成。


## 2026-09-10：057恢复及现库0/1/0验收

主计划417完成恢复副本及现dev_vue的prepare/apply/replay，分别0/1/0 DDL。现库205 completed/0 started、270表，269张业务表338557行保持不变，来源表仍0行；权威证明quote-provenance-current-proof-20260910.json。首次预检误用恢复库原始DDL渲染hash，已按现库自身基线与跨库标准化结构/精确行摘要修正，失败报告保留且未执行DDL。未启用行情writer或保护运行入口，056未执行。下一步可信quote/合约锁/完整审核上下文→唯一子工作流→归并/消费者与业务回填/canonical/记忆剩余项。


## 2026-09-10：真实当前输入联合审核证据

主计划418新增可信quote与锁定instrument读口，bootstrap贯通同连接账户/持仓/行情/合约/策略/汇总/SQL时间。风险域最终重新检查账户和合约时效。91项测试、类型/构建及v103真实MySQL59项目标/风险/上下文检查通过；新增联合审核10项，全部输入SQL实际执行，表/事实仍为查询脚手架，未替代真实终端或父close-history-子命令端到端证明。现库205步不变、隔离库清理且现库零写入。下一步审核/唯一position_workflow子intent/outbox原子持久化与恢复、归并/消费者和完整DDL及其他核心剩余项。
