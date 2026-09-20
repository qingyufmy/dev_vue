# HTTP 合同源

`domains/<domain>.json` 是业务合同的唯一编辑入口；`base.json` 仅拥有 OpenAPI 元信息、服务器和标签。`manifest.json` 显式登记全部域文件，未登记文件、缺失文件、重复域、重复路径或组件均拒绝生成。

执行 `pnpm run generate:api-contract` 生成 `contracts/openapi-v4.json`；`pnpm run verify:api-generated` 检查逐字节一致。生成时递归排序对象键、保留数组顺序，不修改引用和业务字段。聚合路径继续供现有工具与消费者读取。

| 合同域 | 所有权 |
| --- | --- |
| common | 通用标量、时间/精确数值、分页、revision、幂等、ETag和错误结构；无业务路由 |
| auth | 身份中心、应用会话、CSRF、实时票据 |
| bridge | Bridge配对、设备凭据与会话令牌 |
| trading | 账户、上下文、观摩管理、连接额度/终端档案读取、行情、宏观和经济日历 |
| execution | 执行命令、分发、operation与仓位合同 |
| inference | 分析任务、分析结果、交易员评估与决策 |
| risk | 风控规则、摘要、手工解除和决策 |
| reviews | 复盘、手工复盘候选与策略记忆 |
| strategies | 策略、版本和订阅 |
| trade-history | 终端历史、归因及详情 |
| audit | 审计查询与执行追踪 |
| learning | 课程、访问及学习完成 |
| commerce | 推荐规则；其它商业功能随全功能矩阵补齐 |
| settings | 管理设置 |

域划分对应当前服务端职责，不按 URL 前缀机械划分：例如 `/bridge/connection-capacity` 属 trading，`/trading-accounts/{account_id}/execution-commands` 属 execution。跨域复用保留明确的组件引用，不复制模型，也不把业务模型全部塞入 common。这里只确立 HTTP 合同所有权，不替代数据库表写入所有权或源码依赖验收。

拆分时聚合合同与上一版本逐字段相等；后续合同语义调整按域记录。没有删除8项尚未实现的路由。Schema可编译、生成一致、运行注册对应、生产者/消费者行为分别验证。

## 前端传输类型

运行 `pnpm run generate:api-types`，由固定版本的 openapi-typescript 从聚合产物生成 `frontend/packages/contracts/src/generated/http.ts`。文件只包含类型，不加入浏览器运行代码。`pnpm run verify:api-types` 检查聚合和类型产物均未漂移，已接入根 `typecheck:frontend`。

contracts包公开ApiWireSchemas、ApiPaths、ApiOperations供业务使用；登录请求/响应、授权参数和应用会话的现有公开类型已切换到生成来源，API客户端相应输入/输出使用这些类型。其它域的现有类型与转换仍需逐项迁移，不直接替换经过camelCase转换的页面模型。

生成类型不能表达长度、正则、日期合法性、oneOf排他性或权限；保留现有运行时校验。当前认证Zod解析结果与生成类型具备编译期双向结构检查，但这不证明两套运行时约束完全等价。客户端解析迁移及其它业务域仍待接续。

## 服务端运行校验

设置读取readAdminSystemSetting和写入updateSystemSetting已接入请求、成功与problem响应校验。鉴权和CSRF验证仍由认证端口负责，配置策略和事务仍由settings应用及基础设施负责；写入后的成功DTO损坏返回setting_commit_unknown/503，客户端保留同一请求编号与正文。当前运行登记98项，登记本身不代表所有接口或真实依赖已经验收。

runtime.json显式列出已接入操作，完整清单以该文件和生成一致性检查为准。generate:api-runtime按合同提取参数、JSON请求体、各明确状态码下的JSON/problem响应及引用模型闭包，输出server/src/transport/generated/http-contracts.ts；verify:api-runtime拒绝漂移，已接入服务端类型检查和构建。Ajv和格式库是生产依赖；部署产物不依赖仓库contracts目录。各模块只编译自己选择的操作，登记缺失直接失败。

连接额度与终端档案读取先认证，随后校验请求、成功和400/401/403/503错误响应；非法提供者数据收敛为api_response_invalid，未知错误不暴露内部正文。trading-client-contract.test.mjs用真实API客户端经Fastify inject消费成功/失败响应；独立运行测试避免混用前端Bundler与服务端NodeNext类型图，两侧类型检查仍分别执行。这不是浏览器或真实依赖联合验收。

账户工作区快照getTradingAccountSnapshot已登记。请求账户/观摩参数及成功、400/401/403/404/503错误同源校验；处理器先认证，成功和失败均no-store。传输revision为字符串，客户端模型按现有schema转换为数字。路由匹配前的原生错误（例如超长路径414）不属于处理器合同校验覆盖，业务ID语义仍由用例校验。

当前适配器支持GET/PUT/POST/PATCH/DELETE的path/query/header、单一application/json请求体及明确状态码的application/json、application/problem+json响应。写请求体须明确禁止未知字段；其它媒体类型、default状态和空响应需先扩展并验证，生成器不会猜测。header使用Fastify提供的小写键，字符串头不做数字转换。路由先认证和CSRF授权，再校验输入，再调用应用用例，最后校验DTO。整数query只接受规范非负十进制字符串并在校验副本上转换；原请求不修改，不删除字段、不填默认值。审计未声明query保持既有忽略语义，学习完成保持既有全部query拒绝规则。

审计分页HTTP上限调整为实际用例上限100；非法分页现在返回400而不静默截断。接口内部其它调用仍保留原有用例归一化逻辑。审计错误媒体类型对齐application/problem+json，认证错误保留401/403；非法响应以不含原始数据或Schema详情的api_response_invalid/503结束。

学习完成已接入请求头幂等键、CSRF格式、路径、严格JSON请求体和响应校验。域用例仍负责revision范围、幂等重放、冲突、权限重查及事务；Schema不代替这些规则。提交后成功响应若不合规，必须返回learning_commit_unknown/503，让客户端保留同一key/body确认，不能返回普通输入失败或自动发新写入。错误响应补齐problem字段与媒体类型，既有机器错误码保持。

当前不是Fastify默认schema编译器挂载：为保留先认证顺序，路由明确调用共享校验器；检查器中“显式Fastify schema数量”不能包含这些显式调用校验器的操作。审计及学习完成错误响应按状态码与媒体类型校验，正文status必须等于HTTP状态；非法错误替换为经过合同校验的固定503，重新生成关联ID，不递归重试或携带原始值。其它域、空响应、统一错误适配器和全量注册覆盖继续推进。


账户入口读取已接入上下文、账户列表、观摩列表的参数和成功/错误响应校验。先认证再校验access枚举；未声明query沿用忽略语义，不能覆盖认证userId。AuthError保留401/403；非法输出返回经过校验且不带原值的503。快照、行情、终端与额度的后续接入范围见上文。


上下文PUT与观摩退出DELETE已接入运行合同，先assertWrite再校验CSRF格式、严格目标组合和必填revision。版本必须是规范非负十进制字符串且小于Number.MAX_SAFE_INTEGER，为递增保留空间；NULL、空串、指数、小数、重复query拒绝。PUT只允许与mode对应的唯一目标，另一目标可省略或为null。用例完成后DTO校验失败返回trading_context_commit_unknown/503，客户端必须保留原请求键与正文，查询回执后再读取当前上下文，不能据此断言写入失败。PUT/DELETE现在强制小写UUID格式的Idempotency-Key；同键同体重放历史结果，异体409，新键旧revision仍409。GET /trading-context/commands/{request_id}按当前用户查回执，200/null仅表示未见已提交回执，不证明失败；成功及错误均no-store。此阶段运行登记为9项，本批客户端/Fastify对接使用测试写端口，当前开发库与真实浏览器验收另行完成。

报价与 K 线已接入 getMarketQuote/listMarketCandles，请求先认证再校验，成功与失败均 no-store。K 线 page_size 只接受 1–500 的规范整数字符串，缺省仍为 200；空报价保持 null。API 客户端经 Fastify inject 验证账户/观摩参数、UTC 毫秒与精确数字传输，以及非法提供者响应返回 api_response_invalid。该证据不代表实时行情来源或终端时钟已验收。


持仓列表 listPositions 读取当前自有账户持仓投影。游标绑定用户、账户和快照revision，快照改变返回409并从首页重读；分页1–200、默认50，精确ticket文本排序。已登记400/403/409及运行校验，所有响应no-store，弱ETag区分页面。接口未新增终端采集，本次仅源码及HTTP模拟验证。


经济日历列表/详情由market模块提供，来源必须approved且允许展示、未退休/未过期；revision同时过滤available_at和ingested_at。按当前可知revision读取数值，scheduled_at/id键游标绑定from/to/importance。读取先认证，补齐400/503问题响应，所有结果no-store。字段精度、DTO及错误由运行合同验证；当前正式数据表为空，正向SQL证据来自会话临时夹具。

宏观序列 listMacroSeriesPoints 接入相同认证和运行校验，分页固定查询条件及观测 asOf，展示许可按当前 accessAt 核对；依赖失败返回503，不伪造空结果。freshness 的 invalid 包括未登记或覆盖不足的来源日历，不能解释为数据值为零或来源可用于交易。当前来源日历登记仍待验证，默认不推测美国/Cboe 工作日。

返佣规则listReferralRules/updateReferralRules接入请求、成功及problem校验，拒绝未声明查询参数，路由内成功与失败均no-store。写入完成后的响应损坏返回referral_rule_commit_unknown；规则权限、版本及幂等事务仍归commerce。当前前端只有生成类型，尚无该API业务消费者，前端重构时补齐。

getOperation按当前用户查询，接入请求/成功/problem同源校验；认证错误保持401/403，拒绝未声明query，成功及失败均no-store。异常输出返回api_response_invalid，不回显内部数据。

getExecutionCommandContext接入同源请求和响应校验，认证先于参数检查；报价/品种缺失仍返回null，读接口成功及失败no-store。命令写接口后续接入范围见下文。

createExecutionCommand接入标准snake_case命令、CSRF/幂等头及202/problem校验，旧别名和额外字段不再被接受；补齐401/404/428。版本冲突的resource/ticket信息通过标准errors传输，不再使用未声明details。成功提交后DTO损坏返回user_command_commit_unknown，保留原键与正文确认。组合schema的discriminator仅作OpenAPI提示，实际校验继续执行oneOf及各分支const/字段约束。

分发读取previewExecutionDistribution/getExecutionDistribution接入请求、成功及problem校验，保留管理员服务检查；拒绝未知/重复参数，认证错误不降级为503，路由成功及错误均no-store。预览不代表已经冻结的目标，分发写入仍需单独验收。

createExecutionDistribution/createDistributionCloseCommand已接入请求/202/problem校验，固定目标ID及revision按合同输入；读写错误处理在分发模块内复用。写后DTO错误返回distribution_commit_unknown并保留原key/body确认，路由响应no-store。既有目标选择、原子冻结、分发Worker执行语义不由Schema替代。

listMarketAnalyses现由独立列表用例处理page_size/cursor/symbol/strategy_id，稳定created_at/id键分页，响应data.next_cursor必填且末页为null。客户端映射nextCursor并支持选项对象，原数字条数调用保留，上限与合同一致为200。旧无筛选读取入口已移除；列表游标不是授权凭据，每页仍按当前用户过滤。

getMarketAnalysis/listTradeDecisions/getTradeDecision已接入同源校验，认证先于输入，错误及成功no-store；分析和决策详情沿用所属用户读取，决策列表必须带账户。条数上限服务与客户端统一为200，服务不再静默截为100。

createAnalysisJob/createTraderEvaluation接入请求、202及problem同源校验；CSRF认证优先，冷却429保留retry_after_ms，写后损坏响应返回inference_commit_unknown，继续使用原key/body确认。安全整数订阅版本仍由应用层验证，Schema不替代业务版本和任务幂等。

listStrategies由strategies模块拥有路由，已接入请求/成功/problem校验，用户和kind传递到原策略服务；inference不再注册该列表，URL保持不变。

getStrategy/listStrategySubscriptions接入同源读取校验，保持原策略访问规则、用户/账户范围和详情ETag；未知query和重复账户参数拒绝，读取响应no-store。

createStrategy已接入同源请求/成功/problem校验，Idempotency-Key必填。创建结果回执与策略及首版本同事务写入；需要048策略回执表升级，尚未完成真实依赖验收。

updateStrategyMetadata同样要求Idempotency-Key并接入同源校验；回执查找优先于首次写入CAS，重放保留原结果版本。该路径也依赖尚待升级验收的048回执表。

createStrategyVersion/publishStrategyVersion/retireStrategy加入同源请求/成功/problem校验并要求幂等键。版本编译仅首次执行，发布订阅绑定更新与结果回执同事务；这三项也依赖048升级。

createStrategySubscription加入同源校验及必填幂等键；可选字段保留省略状态参与摘要，默认值/到期时间/绑定版本仅首次计算。订阅、计划、偏好与回执同事务，依赖048升级。

updateStrategySubscription也已接入请求/成功/problem校验和回执事务，保留原补丁与期望版本；首次才合并状态、按变更解析绑定及计算计划。重放仍复核账户所有权，但不被后续ended/CAS挡住；计划行缺失回滚。

策略域11个操作均已登记。compileStrategy为无持久写入的编译校验，保留认证/CSRF并校验请求/结果；不使用写回执。七类持久写入均要求Idempotency-Key，048尚待真实迁移与启动readiness验证，不能据此宣称运行环境已升级。

复盘域6个GET操作（案例列表/详情、手动候选、记忆列表/详情/更新列表）接入请求、成功和problem同源校验，认证先于参数检查，拒绝未知query，响应no-store。两个分页列表明确最多100，与应用限制一致。记忆详情与摘要复用开放字段集合，再分别封闭未知字段，避免allOf继承封闭摘要导致合法详情被拒绝。复盘6项写操作也已接入请求、成功和problem同源校验，保留认证/CSRF先行和If-Match检查；写后投影损坏返回review_result_unknown且retryable=false。6项写入的结果读取及回执纳入同一事务；真实依赖验收状态见下文。

观摩管理10个操作均接入请求、成功和problem同源校验，保留应用管理员权限检查、严格游标和100条分页上限、未知query拒绝及操作记录敏感字段过滤。六个写操作先验证认证/CSRF，再校验合同并构造命令，保留Idempotency-Key和正文expected_revision约定。成功和问题响应均no-store；提交未知或写入成功后的DTO损坏返回observer_management_commit_unknown/503、retryable=false，恢复必须保留同键同请求。客户端管理功能与真实依赖验收仍待后续完成。

getAuthCenterSession/getApplicationSession接入同源校验，保留Host和各client的Cookie选择、会话权限检查；认证之后拒绝未知query，响应损坏返回安全503。两者成功和错误均no-store，错误统一application/problem+json。四类退出操作也已登记，使用application/problem+json错误和无正文204成功响应；登录与实时票据也已登记；标准OAuth路由保持独立协议例外边界。

运行产物以空media映射登记明确无正文的204，校验器只接受已登记204且值为undefined；未登记状态、null/空字符串/对象均不接受。四类退出在认证/CSRF之后拒绝未知query和任何正文，保留各自撤销范围、Cookie过期和no-store。跨MySQL、Redis、设备撤销的失败恢复仍属业务验收，合同接线不证明这些副作用原子完成。

认证8个业务操作已全部登记。登录在Host/Origin之后校验严格参数，remember省略保持false；授权参数与登录字段共用开放字段集合，外层各自拒绝未知字段。登录结果URI/目标回调及会话secret、实时票据secret/结果均在Set-Cookie之前校验。实时票据只接受trade会话和CSRF，拒绝正文及未知query；成功/错误均no-store。读取和退出合同不等于持久认证流程故障恢复或浏览器部署验收。

Bridge配对创建和兑换已接入同源请求/成功/problem校验，移除本地重复正文Schema以避免Fastify默认删字段；创建先认证/CSRF，兑换以配对码和同一客户端随机凭据证明请求。写后DTO异常或提交确认丢失为bridge_pairing_commit_unknown/503、retryable=false，保留原键/配对码/installation/token恢复，不能生成新凭据替代。事务失败连接处理与SQL double验证不等于真实MySQL故障恢复验收。

Bridge旧凭据兑换、精确撤销及会话票据三项也完成同源校验；5个Bridge凭据/配对业务操作全部登记。移除路由重复请求/响应Schema及专用preValidation，保留原bodyLimit、领域校验及绑定语义。未知字段、类型转换和query在调用服务前拒绝，错误instance不含查询字符串；服务返回坏结果为bridge_credential_result_unknown/503、retryable=false，响应不回显secret。该接线不等于凭据仓储提交确认丢失已验证。

复盘6个写操作均已接入reviews私有持久回执源码，要求Idempotency-Key；原正文/目标/原CAS一致才重放原结果与ETag，变更命令409。案例写入和手工重放复查当前账户owner，记忆决策复查当前library owner。手工首次创建仍检查候选所属用户/账户、凭据、有效期和策略；重放不重新消费候选，旧案例无回执返回review_legacy_receipt_unavailable/409并保留可读。049升级/readiness、真实MySQL恢复和并发验证尚未完成，源码接线不代表现库已就绪。

回执基础组件已在VM隔离临时MySQL库验证并发同键、实际commit后注入确认丢失、真实回滚及049外键/CHECK（review-write-receipt-reference-v1-20260909.json），临时库已删除。该证据不覆盖六个业务仓储全部SQL、现库升级或历史恢复。

六类复盘业务写入已在VM临时库原始012/049约束下验证，含dateStrings UTC、真实生成提交后确认丢失、记忆三种决策与重放（review-business-reference-v4-20260909.json）。现库历史恢复、升级及readiness尚未完成，临时reference不替代这些证明。

交易策略config支持可选`risk_budget: { version: 1, max_risk_per_trade_percent: "0.5" }`，现有HTTP config对象传输形状不变；领域编译器校验其严格字段、版本和正十进制字符串（最多18位小数、不超过100）。缺省不增加策略限制，显式null/0/负数/指数及未知预算字段拒绝。语义为min(账户effective上限,策略上限)后应用仓位档位，明确手数也受该策略上限约束。新交易快照冻结整个config摘要，风险Worker从冻结决策及当前授权策略读取并在提交事务重验。模型动作没有策略上限设置权；动作建议上限合同尚未开放。现有策略/订阅数据未自动改写，源码和模拟连接测试不代表运行环境已启用或真实交易验收。

动作风险预算（2026-09-11）：交易员开仓/挂单parameters可包含risk_ceiling_percent，采用与策略预算一致的正十进制百分比规则。风险审核按min(min(账户effective上限,策略上限)×已解析档位比例,动作上限)计算，明确手数路径同样校验。该字段保留在获批动作/审核记录供审计，Bridge订单参数仍按既有白名单生成，不把预算元数据发送给终端。管理动作声明该字段或非法百分比均拒绝；模型合同与服务端校验共同生效。
