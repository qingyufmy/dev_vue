# 同库升级第四十八批：按周期承接市场数据计划

真实旧配置具有主周期及逐周期kline_count，V4原先只有统一candle_limit且最小50，无法承接道诚策略M1=30、H1/M15=150的实际请求。新增版本1的market_data_plan，严格校验主周期包含关系、周期唯一、整数数量10–1000及固定字段，不允许同时指定旧统一timeframes/candle_limit。原统一配置路径保持原行为。

分析配置编译器和AnalysisContextBuilder接受该显式计划；TradingAnalysisMarketSource按各周期数量读取，并在冻结市场输入记录primary_timeframe及完整请求计划。该数量是请求量，不宣称行情库必有足量数据；市场历史完整性及实际SQL执行仍需另外验收。模型输出合同未改变。

旧字段转换器只承接明确且有效的market_data_plan_json，按旧normalizeMarketDataPlan把主周期排首位并保留其余相对顺序；缺失配置/提示词回退、别名/异常JSON、旧版会截断的数量不静默归一。候选不激活策略，不能把策略规则或指标字段混入分析配置假装已迁移。

源库3条转换及独立复采一致，回执 [dev-vue-strategy-market-plan-review-20260907.json](dev-vue-strategy-market-plan-review-20260907.json)：道诚H1=150/M1=30/M5=100/M15=150/H4=100；测试M30=100；ATR的H1/M5/M15/M30/H4各100。原源摘要未变，无数据库写入。

27项测试通过（计划8、转换5、策略管理4、分析Worker10），服务端类型检查及构建通过。验证覆盖逐周期参数进入读取端、冻结主周期/数量、冲突配置与无效配置拒绝。本批不证明底层listCandles真实SQL及物理数据数量；已定位其LIMIT仍绑定数值，需实际MySQL查询验证后修复，不能引用前期调度LIMIT验证代替。下一步继续该SQL验证及指标、执行规则、角色映射，完整回填/自动升级/清理仍未完成。
