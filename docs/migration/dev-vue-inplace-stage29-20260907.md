# 同库升级第二十九批：分析调度遵守订阅时段

新增策略域 `evaluateSubscriptionWindow`，消费第二十八批版本1候选合同；兼容当前V4 `{enabled:false}` 的未启用表示。严格检查时间/星期/版本/窗外行为/时区一致性。相同端点表示整天，结束分钟排除，跨午夜依据开始日，窗外 signals_only 仅允许分析。

到期查询读取 receive_timezone/receive_window_json；调度器在同用户/版本/品种分组前逐订阅判断，因此窗外账户不会被选作行情来源。关闭窗口的订阅推进下一正常cadence，避免一直占据到期查询前列；未知时钟且pause_all也在下一cadence复查。损坏合同和时钟读取异常作为该订阅失败报告，不登记分析，不阻断本批其它合法订阅。

调度入口通过现有 MysqlTradingRepository.getAccountSnapshot 获取包含归属和终端来源校验的快照，不直接信任无来源时区列。时段判断只接受 calibrated 与合法偏移，沿用V4风险域的校准要求；stale/observer_bootstrap/显示默认UTC+3不升级为可信执行证据。禁用时段不查询时钟，signals_only 在不能确认窗内时仍允许分析。这个函数只判断时段，返回 executionAllowed 不是完整交易授权。

6项新增运行测试加14项调度/转换回归共20项通过，服务端类型检查和构建通过。验证覆盖同组账户先过滤、窗外推进、坏配置隔离、禁用无需时钟及时间边界。本批没有启动调度/Worker/Bridge，没有数据库DDL/DML，没有真实任务或交易。

尚未完成：排队后推理复查、分析结果生成交易员时的逐订阅窗口检查、最终执行检查，以及对应并发版本合同。因此第二十八批候选的 schedule_runtime_consumers 门槛仍保留，业务回填和自动升级不能据此宣布完成。下一步沿 mysql-inference-repository 的 beginAnalysis/completeAnalysis 与执行订阅读取补齐这些检查。
