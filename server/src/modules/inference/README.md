# Inference


## 账户读取与运行组装

AnalysisTradingReader 仅选择 trading 公开读取合同中的 findOwnedAccount/listAccounts/getQuote/listCandles；TraderAccountReader 仅选择归属、账户快照、持仓、挂单、报价和 revision 读取。推理代码不导入 trading 内部文件，不因构造器需要整个 repository 而索取无关能力。

TradingAnalysisMarketSource 留在本域基础设施，不从业务 index 导出；worker-analysis 经 composition 的 createAnalysisMarketSource 创建，返回 AnalysisMarketSource 应用端口。其它历史基础设施公开导出仍需逐项迁移，不能把本次单一工厂视为全域收口。定向验证包含 strategy-market-plan、inference-pipeline-vertical-slice 和 trader-preferences。
