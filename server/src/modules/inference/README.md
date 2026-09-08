# Inference


## 账户读取与运行组装

AnalysisTradingReader 仅选择 trading 公开读取合同中的 findOwnedAccount/listAccounts/getQuote/listCandles；TraderAccountReader 仅选择归属、账户快照、持仓、挂单、报价和 revision 读取。推理代码不导入 trading 内部文件，不因构造器需要整个 repository 而索取无关能力。

TradingAnalysisMarketSource 留在本域基础设施，不从业务 index 导出；worker-analysis 经 composition 的 createAnalysisMarketSource 创建，返回 AnalysisMarketSource 应用端口。其它历史基础设施公开导出仍需逐项迁移，不能把本次单一工厂视为全域收口。定向验证包含 strategy-market-plan、inference-pipeline-vertical-slice 和 trader-preferences。


交易 Worker 通过 createMysqlTraderContext 创建上下文应用能力，由模块内部组装合约、风险摘要、执行偏好读取器；createMysqlTraderWindowGuard 返回应用时间窗端口。具体读取器和守卫不从业务 index 导出。SQL 跨域所有权仍待逐项处理，不能把构造器迁移视为数据所有权完成。


分析 Worker 使用 createMysqlAnalysisWindowGuard/createMysqlMacroSnapshotReader 获得应用能力，业务 index 不公开具体类。时钟回调保留账户和用户范围，宏观证据哈希、版本、时效及缺失拒绝规则保持。定向入口为 analysis-window-guard、macro-evidence-context、inference-pipeline-vertical-slice。


运行入口经 createMysqlInferenceRepository 获得应用持久化端口，必须注入账户时钟与偏好连接工厂。createInferenceHttp 组装路由及策略服务，模块持有 /api/v4 前缀，总注册器保留 trade Host 隔离。业务 index 不导出 MySQL repository 与路由；模型、调度、恢复及用量相关具体出口仍待清理。


createMysqlAnalysisScheduler/createMysqlModelTaskRecovery 组装调度和恢复持久化，实现只留在基础设施层。调用方仅获得 tick/expireOverdue，仍拥有轮询和生命周期；工厂本身不发起查询、调度或恢复。相关定向回归为 analysis-schedule-query、analysis-scheduler-worker。
