# 交易核心历史承接与读取切换核对

2026-09-11。此次使用 server/.env 的应用账号只读访问 192.168.1.254/dev_vue，核对数据库身份及已构建 V4 读取路径。没有创建测试库、没有业务写入，没有启动服务。HTTP 使用进程内注入与身份替身，不属于真实登录链验收。

## 本轮实际读取

| 范围 | 实际结果 | 证据 |
|---|---|---|
| 策略/订阅/记忆 | 当前 schema readiness 通过；三个用户分别读取到 2/1/0 个当前归属订阅，历史归属订阅不返回；迁移策略仍 draft，订阅 paused 且运行开关关闭；4 个记忆库列表及详情 200，仍 shadow/revalidating | [当前只读报告](architecture/core-read-cutover-current-v1-20260911.json) |
| 风控 | 两个当前归属请求 200，旧归属请求 404；UTC 回读通过 | [当前风控报告](architecture/core-risk-read-current-v1-20260911.json) |
| 历史复盘 | 183 个案例可按本人读取，23 个当前版本；183 次其它用户访问均拒绝；原文和 UTC 校验通过 | [当前历史报告](architecture/core-review-read-current-v1-20260911.json) |

## 既有迁移与当前入口对应

| 数据职责 | 既有迁移证据 | 当前源码入口/目标 | 结论与剩余 |
|---|---|---|---|
| 账户根与历史归属 | current-account-root-applied-20260908.json：根提升 applied；早期 account-root-cutover-review-current 的 ready=false 是提升前证据 | trading/infrastructure/mysql-trading-repository.ts：trading_accounts + ownerships + ownership_intervals + user settings | 同名根表已提升，不能因为表名未加 v4 判定仍读旧结构；本轮未全量重做账户映射对账 |
| 策略及订阅 | strategy-subscription-transition-current-v2-20260911.json：6 个策略、6 个版本、5 个订阅/调度/偏好；旧表与原 ledger 保留、重放无新增 | strategies/infrastructure/mysql-strategy-catalog.ts、mysql-analysis-schedule-store.ts | 可读承接已验证；运行语义未闭合，见下节 |
| 风控政策 | risk-policy-current-v1-20260911.json：3 个集合、10 个版本，2 个 active 集合和 1 个历史归属 retired 集合；旧数据保留 | risk/infrastructure/mysql-risk-repository.ts：risk_policy_sets_v4、risk_policy_versions_v4 等 | 当前读取和旧归属隔离通过；不把此项扩展为所有平台风控配置验收 |
| 策略记忆 | strategy-memory-current-v1-20260911.json：2 个旧库/20 个旧版本承接为4库/40版本，旧数据保留、重放无新增；078 补齐运行日志结构 | reviews/infrastructure/mysql-runtime-strategy-memory-reader.ts：strategy_memory_libraries_v4 + strategy_memory_library_revisions_v4 | shadow 不注入运行，已确认的新记忆同链使用另有报告；旧记忆激活语义不能由列表可读替代 |
| 复盘历史 | review-history-cases-current-v1-20260911.json：183 案例/34 版本/33 用户状态；review-history-archive-current-v1-20260911.json：563 分块可恢复 | reviews/infrastructure/mysql-review-repository.ts：review_cases_v4/review_versions_v4；历史元数据与归档读取按公开用例 | 本轮验证当前案例/当前版本可读；34 是迁入版本总数，23 是当前版本读取数，口径不同。历史原文只读，不重当可执行新复盘 |
| 推理及执行 | inference-current-apply-20260910.json 证明结构升级；review-generated-memory-pipeline-v1-20260911.json 证明合成数据的开发依赖主链 | inference/execution 各自仓库、Worker、outbox | 新运行链已具证据；不能用结构升级证明旧信号/推理/执行事实全部在新 API 可追溯。需另核历史读取去向 |

上述迁移报告均位于 docs/architecture，是各自观测时刻证据，不宣称本轮重新执行迁移或全表内容对账。源文件及本轮报告摘要见 [证据索引](architecture/core-data-read-evidence-index-20260911.json)。读取探针使用现有 dist-v4；源哈希用于跟踪后续漂移，不独立证明构建与源码一致。

## 已确认的核心功能缺口

旧策略转换器 `scripts/lib/v4-strategy-role-config-conversion.mjs` 在 use_chan_analysis 开启时明确产生 chan_runtime_mapping_required。当前迁移结果至少一个原 active 策略处于 configStatus=partial，全部角色提示词 semanticAcceptance=pending；策略为 draft，订阅关闭并暂停。它们是数据保留结果，不是运行等价迁移。

不能简单删除阻断或自动启用订阅来宣布完成。后续需只读核对旧版该开关实际产生的客观输入，在 V4 通用数据能力中承接必要输入，再验证角色拆分后的提示词/配置。不得按策略 ID 增加专属交易规则。这个能力缺口属于后端核心，不能整体推给前端或把迁移数据直接丢弃。

本轮未发现上述实际读取中的缺表/缺列或原文损失；仍未证明推理/执行历史与全部核心数据语义已切换。D8 保持未关闭，下一步处理策略语义承接和剩余历史读取，而不是重复这三项已通过的检查。

## 缠论来源与历史窗口承接

只读核对旧参考仓库：server/routes/ai/utils.js 的实际版本为 chan_structure_v8；market-data.js 的 computeChan 调用旧窗口策略，旁边 chan-v9 不是该入口的替代证明。chan-window-policy.js 规定 M5/H1 1800、M15 2000、H4 1000 根内部历史，模型可见窗口独立；llm.js 通过 projectStrategyContextChanForModel 投影结构字段，并在关闭开关时移除 chan。不能只添加布尔开关或把 v9 实验算法换入。

V4 的市场计划/模型窗口仍最多1000，浏览器服务仍最多500。本次仅将内部 MysqlTradingRepository.listCandles 的有界读取上限提高到2000，以承接既有计算窗口，不扩张公开接口。当前真实库只读返回1000/1800/2000根，顺序正确，2001被拒绝，见 architecture/internal-candle-window-current-v1-20260911.json。17项定向测试、完整服务端构建及内置边界/合同生成检查通过。

这只是解除数据读取容量阻断，尚未移植 v8 计算/投影，也没有启用旧策略或解除迁移语义阻断。下一步必须保持原算法和输出语义，将纯计算从旧行情与Bridge耦合中分离，再以相同冻结K线做等价验证。当前已修改 trading repository；上一节证据索引中的该文件哈希是修改前快照，不能当作修改后源码证明。

## v8 模型投影纯模块迁入

新增 market/domain/chan-model-projection.ts，经 market/index.ts 导出。第一轮核对职责：只迁移模型结构投影，不引入旧路由、数据库、Bridge、策略专属执行条件或 v9 算法。第二轮核对兼容：固定结构/能力白名单，保留 latest_structure 对当前段的精确 stable_id/confirmed 匹配、移除绘图时间、深克隆不改变冻结输入；引用/循环仍拒绝。

519 个合成输入（含不同活动段、候选段、空值、布尔能力、无关字段与引用拒绝）的新旧输出一致，报告 architecture/chan-model-projection-parity-v1-20260911.json 记录双方源哈希。4 项定向行为测试、完整 server 类型检查、构建及边界/合同门禁通过。该模块尚未进入 Worker；下一步仍是纯计算分离和历史窗口接线。没有数据库写入、策略激活、真实模型调用或部署。

## v8 基础计算分离

market/domain/chan-v8 已分离 types、macd、bars、bis 四个严格 TypeScript 文件；保留旧公式、包含方向判断、原始索引、分型去重和笔断裂分段语义，去除 process.env/console 调试副作用。没有引入旧 market-data.js 的数据库或Bridge导入。此为同一能力承接的内部实现，不新增阶段或策略规则。

可复现对比：`node scripts/verify-chan-v8-foundation-local.mjs D:/dev_codex/wall-street-skill-local/server/routes/ai/market-data.js D:/dev_codex/dev_vue/docs/architecture/新报告文件名.json`。脚本仅在无I/O的VM上下文提取参考纯函数范围，固定种子120组0～2000根行情，488项计算结果一致；71组非空笔、75组发生包含或过滤，输入不变性通过。报告 chan-v8-foundation-parity-v1-20260911.json 保存参考全文、纯函数片段和目标源码hash；编译与模块边界检查通过。

该证据只覆盖MACD/包含/分型/笔。线段、中枢、背驰、多窗口一致性和完整分析Worker仍未迁入，不能当作v8整体等价。当前未激活任何策略，未连接数据库。

## v8 特征序列、线段与中枢

新增 market/domain/chan-v8/features、segments、centers：保留特征序列包含、缺口后的反向分型确认、旧方向极值使候选失效、非可信前缀两次端点重同步、同一验证群体的完整线段链多数支持，以及中枢初始交集/延伸/离开关系。不用独立相邻对多数拼接不存在的完整链。

可复现脚本 scripts/verify-chan-v8-structure-local.mjs，参数为旧market-data.js绝对路径与新报告绝对路径。40组固定种子笔序列共760项新旧结果一致，54个非空线段结果、120个非空中枢结果、35个resynced结果；报告 chan-v8-structure-parity-v1-20260911.json 保存参考/目标hash。8项当前结构和投影定向测试、全server类型检查及完整构建通过。没有旧运行依赖、数据库操作或策略激活。

背驰、结构生命周期、单窗口计算和跨窗口组装仍未迁入；当前不能宣称完整v8引擎或Worker接线完成。已完成的纯算法模块保持内部，不以增加公开空接口冒充运行接线。

## v8 背驰与形成态

新增 divergence、divergence-result、forming-divergence、segment-location、rounding，继续按纯计算职责拆分。保留中枢明确进入/离开段引用、40根MACD暖机、柱面积/峰值与DIF/DEA、零轴回归、趋势/盘整背驰分类、形成态未确认以及精确定位。候选起点被突破需要完整双边特征序列才退役的旧行为保持。

verify-chan-v8-divergence-local.mjs 对48组合成方向/幅度/暖机/中枢输入及状态分类做252项新旧输出对比通过；其中confirmed 12、forming 100、unavailable 78、evaluated 14，另48项是历史数组。旧源纯函数在无I/O上下文执行，记录源/目标hash于 chan-v8-divergence-parity-v1-20260911.json。没有数据库或外部模型调用。该样本不代表所有趋势零轴正向分支或完整v8算法覆盖。

当前完成纯结构基础与背驰；结构生命周期/摘要、单窗口和多窗口一致性组装以及模型Worker接线仍未完成。迁移运行阻断保留。

## v8 生命周期与结构摘要

新增 pivot-lifecycle、bi-summary、segment-summary、center-summary、latest-structure，保留真正被笔构造接受的active pivot、起点突破后的延伸极值、形成笔实际极值时间、段展示端点与观测末端区别、候选与当前笔的精确连接。迁入原逻辑，不让历史已失效候选冒充当前方向。

verify-chan-v8-lifecycle-local.mjs 对80组合成行情做800项新旧输出对比通过：39组active、38组origin_breached、3组unavailable；同时检查最新结构计算不变更输入。报告 chan-v8-lifecycle-parity-v1-20260911.json 记录参考全文/纯函数段与5个目标文件hash。初次类型检查发现非空摘要展开的类型推断缺口及遗漏常量，已修正，编译通过；业务算法未因类型修正改变。

趋势分类、入场候选、能力组合以及单窗口/跨窗口完整计算仍待迁入；当前不进入Worker、不改变现有策略激活状态，也不执行数据库写入。完整构建及内置模块/合同检查通过。

## v8 趋势和入场候选

新增 trend 与 entry-candidates：保留背景趋势和当前笔方向的优先关系、确认背驰耗竭、已确认/待确认中枢突破、一二三买卖候选及其精确stable ID/bi run归因。候选新鲜度和结构可用性沿用旧算法；这些是模型证据，不新增服务端交易许可或策略专属下单规则。

verify-chan-v8-trend-entry-local.mjs 对方向、候选类型、可靠性、新鲜度、价格位置和active pivot状态共756项对比通过，六类候选均有非空样本，背景状态覆盖盘整、上下突破/待确认/耗竭。报告 chan-v8-trend-entry-parity-v1-20260911.json 保存源/目标hash。该样本未覆盖所有双中枢趋势或旧代码边界；完整窗口对比仍需后续完成。编译与完整构建通过；无数据库操作、策略激活或模型调用。

剩余能力状态、单窗口、多窗口一致性及分析Worker接线，当前仍不宣称完整算法可运行。
