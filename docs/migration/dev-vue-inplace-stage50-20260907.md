# 同库升级第五十批：入场方式与指标开关核查

旧parseStrategyPolicy把entry_methods_json规范化后用于模型输出合同和结果校验；market/limit/stop/stop_limit是用户声明的执行方式，不是新增策略专属判断。本批在V4交易员配置中校验entry_methods，TraderContextBuilder从版本配置生成冻结entryMethods；未配置的V4版本明确采用四种既有默认方式，显式null/空数组/未知方式拒绝。模型提示说明允许方式，决策校验只限制新开仓/挂单；修改保护、平仓、改单和撤单不受入场列表限制。

策略规则只读报告 [dev-vue-strategy-rules-review-20260907.json](dev-vue-strategy-rules-review-20260907.json) 与原源摘要一致并独立复采一致。三条策略均明确存储四种方式，未使用缺省值。道诚策略use_chan_analysis=1/use_ema34_filter=1，结构化政策schema为strategy-policy-v1、mode=shadow，包含启用的EMA指标；测试/ATR均无政策、开关关闭。三条平台策略按旧运行语义均不提供私人组合上下文。

旧入口中的use_ema34_filter控制数据提供，不代表把EMA做成服务器交易硬拦截。V4当前尚无对应指标/政策运行模块，本批只记录原开关、政策原文摘要和声明，不能把这些字段丢弃或宣称已迁移。显式shadow也必须保留，其详细编译和数据注入待后续承接。

35项定向测试通过：方式合同12、源规则3、交易员Worker12、推理流程8；服务端类型检查和构建通过。覆盖禁止方式、六种挂单类型、现价单、管理动作不误拦、重复/未知配置，以及旧JSON异常不静默丢弃。原角色/指标政策转换仍阻断整条策略回填；本批未修改数据库、启动服务或改变终端状态。全量自动升级和旧结构清理未完成。
