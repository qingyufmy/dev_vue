export const independentAnalysisContract = '当前策略是市场背景分析：只判断 H1/H4 趋势、阶段、区域、有效期和失效条件。opportunity 为兼容字段，不是交易许可；不得输出账户动作。'

export const independentTraderContract = '当前策略独立识别机会：analysis 是有时效的市场背景而不是入场许可；marketEntryEvents 来自当前冻结的小周期行情，禁止从分析中的缠论结构补造交易条件。每个开仓或挂单动作必须在 parameters 中声明 entry_scenario（trend、countertrend 或 range）和非空 scenario_invalidation，供后续持仓管理审计。背景过期的 manage 模式禁止新增仓位。'
