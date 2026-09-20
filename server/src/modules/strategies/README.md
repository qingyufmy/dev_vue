# Strategies

`AnalysisStrategyAccess.canUse`提供同事务的分析策略可用性检查：活动、未删除、有active_version_id，且为平台策略或当前用户所有。`createAnalysisStrategyAccess`绑定调用者连接并使用FOR SHARE，不提交事务、不查询auth身份；此能力不证明版本内容完整或授权策略执行。观摩管理消费公开端口并保留自己的409错误与管理事务。验证入口为mysql-analysis-strategy-access.test.ts及verify-analysis-strategy-access-mysql.mjs，后者仅使用会话临时表。


## 目录与 HTTP 组装

API 和后台入口通过 composition 的 createMysqlStrategyService 创建业务服务，createStrategyHttp 组装固定 /api/v4 路由。模块业务 index 不导出 MySQL 目录和 HTTP 实现；推理仍可使用 StrategyService 业务能力。连接池、队列和进程生命周期由入口负责。

定向回归为 strategy-management、strategy-market-plan、strategy-entry-methods。订阅执行偏好 SQL 的跨模块公开调用仍是待收口项，须保留同事务读取和并发语义；静态边界通过不代表完整策略、数据和前端流程验收。


订阅执行偏好现通过 SubscriptionPreferencesReader 业务能力读取。composition 的 createSubscriptionPreferencesReader 绑定现有事务连接，仅执行原 FOR SHARE 读取，不开始/提交/回滚事务。SQL 初始化仅留在本域订阅创建实现中；公开 index 不再导出这两个 SQL 函数。推理构造、快照写入及完成前检查由运行入口注入同连接能力，定向测试追加 subscription-execution-preferences、trader-preferences、trader-window-evidence、trader-window。


## 订阅计划所有权

RuntimeStrategyAccess负责模型解析所需策略访问：当前调用要求active且active_version匹配；冻结复盘允许退役策略，但仍须未删除及平台/本人归属。此端口不读取模型配置、密钥、用户套餐或用量。两个方法只读，不改变策略状态或授予交易权限；对应真实查询验证为model-access-reference.mjs。

AnalysisWindowReader提供分析启动前的当前窗口列表，限定用户、源账户、分析策略/版本、品种、active、analysis_enabled及未撤销owner；不要求trader_enabled。查询实现归本域，分析业务判定及账户时钟由推理消费方执行。本读取沿用独立查询语义，不声称与外部时钟形成原子快照。

AnalysisSubscriberReader提供自动分发候选、手动请求的双策略/品种绑定及当前订阅版本状态；SubscriptionExecutionWindowReader提供限定版本和owner的执行窗口。工厂绑定原事务连接，FOR SHARE/手动请求FOR UPDATE，不自行提交。自动候选要求analysis_enabled，手动请求不要求开启自动分析；库存与账户投影不归策略模块。验证入口scripts/lib/subscription-execution-window-reference.mjs与服务端trader-window、manual-trader-evaluation-ports、analysis-subscriber-dispatch测试。

subscription_schedules 的创建、用户修改、到期扫描及下一次到期更新均由 strategies 基础设施持有。公开 AnalysisScheduleStore 只提供 listDue/advance；composition 的 createMysqlAnalysisScheduleStore 返回该能力，由 scheduler-analysis 入口注入推理调度器，不向推理业务暴露连接池或SQL。advance 保留 subscription_id + expectedDueAt 条件更新，竞争时返回 false，不自动重试。分析任务分组、模型调用和调度生命周期仍属于 inference；定向验证为 analysis-schedule-query、analysis-scheduler-worker。

## 执行配置读取边界

`StrategyExecutionConfigReader` 是跨域业务端口，调用方经 `index.ts` 使用类型，由 bootstrap/entrypoints 经 `composition.ts` 组装同一事务连接。它按订阅、用户、账户、订阅版本和交易策略版本读取当前获授权的配置，并比对已验证输入快照中的 prompt/config SHA-256；缺少冻结摘要不得从当前版本补全。SQL 实现不读取其它业务域的决策正文，也不接收模型声明作为信任来源。此端口本身不代表风险审核事务已接入，或外部风险预算字段已开放。
