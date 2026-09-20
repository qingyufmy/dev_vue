# 后端原需求与当前实现对账（22 个业务域）

2026-09-11。逐行对应原功能矩阵第 8 节。此表是源码/合同范围核对，不是全功能验收，也不代表重新查询了数据库。原需求全部保留；配套阶段仍包含后端工作，不能标记为后端已经完成。

## 需求与承接入口

模块名链接到真实公开入口；缺少独立模块不等于功能一定不存在，缺项按当前合同与承接说明判断。模型运行基础设施当前由 inference 组装，不为匹配原矩阵机械新增目录。

| 原业务域 | 当前入口 | 已有范围 | 未关闭范围 | 交付归属 |
|---|---|---|---|---|
| identity | [auth](../server/src/modules/auth/index.ts) | 会话、登录、撤销与 realtime ticket | MFA 注册/恢复、身份完整管理未由现有 8 个操作证明 | D3 身份基础；D4/D6 配套管理 |
| profile | [auth](../server/src/modules/auth/index.ts) | 会话读取包含主体信息 | 资料/联系方式/头像修改没有对应合同 | D4/D5/D6 配套后端，未完成 |
| membership | [commerce](../server/src/modules/commerce/index.ts) | 会员及学习权益读取 | 计划管理、权益授予/到期处理没有完整接口和任务证明 | D5/D6 配套后端，未完成 |
| commerce | [commerce](../server/src/modules/commerce/index.ts) | 推荐规则读写、钱包读取端口 | 订单、TRC20 支付、激活、返佣对账未覆盖 | D5 配套后端，未完成 |
| learning | [learning](../server/src/modules/learning/index.ts) | 课程列表、详情、完成事务 | 测验、内容编辑/发布、后台管理未覆盖 | D5 配套后端，未完成 |
| community | 待明确承接 | 未找到独立合同域或承接说明 | 帖子、回复、举报、资源需逐功能实现核对 | D5 配套后端，未完成 |
| notifications | 待明确承接 | 未找到完整投递用例的合同域 | 站内、邮件、短信、模板、重试与渠道结果未覆盖 | D5/D6 配套后端，未完成 |
| site-content | 待明确承接 | 未找到完整发布用例的合同域 | 品牌、案例、法律文本/同意、TDK 未覆盖 | D5/D6 配套后端，未完成 |
| app-config | [settings](../server/src/modules/settings/index.ts) | 受约束的配置读取/修改 | 不能代替域名发布、功能开关、集成验证、版本发布流程 | D6 配套后端，未完成 |
| trading-accounts | [trading](../server/src/modules/trading/index.ts) | 账户、当前上下文、档案、观摩源与授权 | 当前读取链已入主链；实机账户切换与全部管理能力待联调 | D3 核心；D4/D6/D7 配套 |
| bridge-gateway | [bridge](../server/src/modules/bridge/index.ts) | 配对、凭据、会话与网关运行入口 | 主链已使用生产派发处理器/服务；真实网关队列与Socket、终端接线仍待联调 | D3 核心接缝；D7 客户端 |
| market-data | [trading](../server/src/modules/trading/index.ts)、[market](../server/src/modules/market/index.ts) | 报价、K 线、宏观与经济日历读取 | 主链行情为合成样本；真实终端新鲜度需后续实机验证 | D3 核心读取；D4/D7 联调 |
| strategies | [strategies](../server/src/modules/strategies/index.ts) | 策略、版本、编译发布与账户订阅 | 全量旧策略/订阅语义和读写切换证据需汇总 | D3/D8 核心；D4 管理交互 |
| models | [inference](../server/src/modules/inference/index.ts) | 运行配置读取、解密、用途校验与用量结算 | 模型配置 CRUD、验证任务、默认/用途设置无对应 HTTP 合同 | D3 运行核心；D4/D6 配置管理未完成 |
| inference | [inference](../server/src/modules/inference/index.ts) | 调度、分析 Worker、交易员 Worker、结果读取 | 真实依赖主链通过但外部响应模拟；非空参考归因缺证据 | D3 核心剩余接缝 |
| risk | [risk](../server/src/modules/risk/index.ts) | 政策、摘要、决策、人工放行与回执 | 全域历史政策承接及平台管理能力需对应证据 | D3/D8 核心；D4/D6 配套 |
| execution | [execution](../server/src/modules/execution/index.ts) | 统一命令、分发、意图、准备和结果读取 | 主链 Bridge 派发直接推进，未知结果/分支需对应已有独立证据 | D3 核心剩余接缝 |
| position-management | [execution](../server/src/modules/execution/index.ts) | 已有保护、部分平仓工作流源码 | 不可用市价开仓样本代替持仓管理分支验收 | D3 既有流程证据汇总；D4/D7 联调 |
| reviews-memory | [reviews](../server/src/modules/reviews/index.ts) | 生成、确认、记忆接受与后续读取 | 自动非空周期采集到生成输入的接缝未关闭；压缩/冲突等不扩大当前门槛 | D1/D2 必要基本链；D4 完整管理 |
| trade-history | [trade-history](../server/src/modules/trade-history/index.ts) | 历史列表、详情、采集与投影 | 统计/导出接口未在本域两个合同中覆盖；历史读切换需对应报告 | D1/D2/D8 核心；D4 导出等配套 |
| audit | [audit](../server/src/modules/audit/index.ts) | 用户审计列表和详情 | 管理导出、留存和访问审计不能由两个读接口证明 | D3 关键审计；D6/D9 配套 |
| jobs | 运行角色组装 | entrypoints / queue / outbox / bootstrap 按角色组装 | 不是缺一个 jobs 文件夹；全后台任务中心和长稳验收尚未完成 | D1/D2/D3 必要恢复；D6/D9 其它能力 |

## 当前核心关闭顺序

1. D8 先完成已运行域的数据承接证据：逐域关联迁移/回填报告、当前读取入口、写入所有者和旧字段语义；目录存在与追加 DDL 成功均不能替代此项。
2. D3 只补生产派发消费者、必要非空参考归因等真实接缝；复用已有分支证据。外部供应商/终端可以模拟，但进程内接线与持久副作用不可用直接改状态冒充。
3. D2 补非空自动周期采集到复盘输入的必要路径，复用已验证的生成→确认→接受→使用链；不继续扩展新的历史边界政策。
4. 前端对应模块合同与数据稳定即可开始。配套 CRUD、支付、内容等仍在原需求中，随对应产品流程完成，既不误报已做完，也不全部变成当前交易核心的前置条件。

## 数据证据与局限

- 最新既有升级报告 `architecture/memory-completion-current-v1-20260911.json`：266 步、314 表；078 旧列数据与原 journal checksum 保留，再执行无 DDL。它证明本次追加升级，不证明全部历史读取语义。
- `architecture/current-database-catalog-20260911.json` 的 4418 列与 265 步是 078 之前快照；不再与 266 步混写为同一时刻目录。
- `architecture/data-write-ownership-review-20260911.md` 覆盖静态/间接写入归属；不覆盖所有跨域读契约和历史迁移语义。inference 已修改文件的旧哈希证据需要更新。
- `architecture/review-generated-memory-pipeline-v1-20260911.json` 为真实开发依赖加合成外部数据；复盘 case/job/evidence 仍种入，HTTP 身份替身、空参考仓位、全外键未验证等限制保留。

## 当前 HTTP 合同操作索引

以下从 manifest 登记域的源文件读取。只说明已声明的操作范围，实际路由一致性引用既有 `architecture/api-contract-closure-20260911.log`；本轮未重跑路由验证。没有列出的能力不能因为该索引全匹配而算完成。

- [auth](../contracts/http/domains/auth.json)（8）：`getAuthCenterSession`, `logoutAuthCenterSession`, `loginAtIdentityCenter`, `getApplicationSession`, `logoutCurrentApplication`, `logoutAllWebApplications`, `revokeAllSessionsAndDevices`, `createRealtimeTicket`
- [bridge](../contracts/http/domains/bridge.json)（5）：`createBridgePairingRequest`, `redeemBridgePairing`, `exchangeLegacyBridgeCredential`, `revokeBridgeDeviceCredential`, `createBridgeSessionToken`
- [trading](../contracts/http/domains/trading.json)（28）：`getTradingContext`, `replaceTradingContext`, `leaveObserverMode`, `listTradingAccounts`, `getBridgeConnectionCapacity`, `listTerminalProfiles`, `listObserverChannels`, `listObserverSourcesForAdmin`, `createObserverSource`, `updateObserverSource`, `listObserverChannelsForAdmin`, `createObserverChannel`, `updateObserverChannel`, `listObserverChannelAccesses`, `setObserverChannelAccess`, `setObserverDefaultChannel`, `listObserverManagementOperations`, `getTradingAccountSnapshot`, `getMarketQuote`, `listMarketCandles`, `getMacroMarketOverview`, `getLatestMacroSnapshot`, `listMacroSnapshots`, `getMacroSnapshot`, `listMacroSeriesPoints`, `listEconomicCalendarEvents`, `getEconomicCalendarEvent`, `getTradingContextReceipt`
- [execution](../contracts/http/domains/execution.json)（8）：`getExecutionCommandContext`, `createExecutionCommand`, `createExecutionDistribution`, `previewExecutionDistribution`, `getExecutionDistribution`, `createDistributionCloseCommand`, `listPositions`, `getOperation`
- [inference](../contracts/http/domains/inference.json)（6）：`createAnalysisJob`, `listMarketAnalyses`, `getMarketAnalysis`, `createTraderEvaluation`, `listTradeDecisions`, `getTradeDecision`
- [risk](../contracts/http/domains/risk.json)（9）：`getRiskPolicy`, `replaceRiskPolicy`, `getAccountRiskSummary`, `getManualRiskRelease`, `createManualRiskRelease`, `listRiskDecisions`, `getRiskDecision`, `getManualRiskReleaseReceipt`, `getRiskPolicyReceipt`
- [reviews](../contracts/http/domains/reviews.json)（18）：`listReviewCases`, `getReviewCase`, `requestReviewGeneration`, `listReviewVersions`, `createReviewVersion`, `confirmReviewVersion`, `returnReviewCase`, `listManualReviewCandidates`, `createManualReviewCase`, `listStrategyMemories`, `getStrategyMemory`, `listStrategyMemoryUpdates`, `decideStrategyMemoryUpdate`, `getReviewVersion`, `getReviewHistoricalMetadata`, `listArchivedReviewJobs`, `listArchivedReviewEvents`, `listArchivedReviewStages`
- [strategies](../contracts/http/domains/strategies.json)（11）：`listStrategies`, `createStrategy`, `compileStrategy`, `getStrategy`, `updateStrategyMetadata`, `createStrategyVersion`, `publishStrategyVersion`, `retireStrategy`, `listStrategySubscriptions`, `createStrategySubscription`, `updateStrategySubscription`
- [trade-history](../contracts/http/domains/trade-history.json)（2）：`listTradeHistory`, `getTradeRecord`
- [audit](../contracts/http/domains/audit.json)（2）：`listAuditEvents`, `getAuditEvent`
- [learning](../contracts/http/domains/learning.json)（3）：`setLearningCompletion`, `listLearningCourses`, `getLearningCourse`
- [commerce](../contracts/http/domains/commerce.json)（2）：`listReferralRules`, `updateReferralRules`
- [settings](../contracts/http/domains/settings.json)（2）：`readAdminSystemSetting`, `updateSystemSetting`

核对：原矩阵 22/22 行具备明确去向；当前合同 104 个操作。两者均不表示功能 100% 完成。
