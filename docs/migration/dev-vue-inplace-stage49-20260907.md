# 同库升级第四十九批：K线SQL真实兼容与取数验证

当前listCandles的数值LIMIT参数在本地mysql2 3.24.3配合MySQL8.4.8的CTE场景可执行；在虚拟机mysql2 3.23.1的实际V4参考表上EXPLAIN返回ER_WRONG_ARGUMENTS。两种场景的驱动版本与表来源均有差异，不能把成功的CTE证明扩展到物理表，也不据此断言仅表类型导致失败。失败输入保留为subscription-window-sql-input-v6-20260907.json，远端window-sql-20260907-08保留原工具。

修复仅作用于listCandles：先验证limit为1–1000的安全整数，再用String(limit)绑定。API现有最多500和策略计划最多1000均可承接；非法值在SQL前拒绝。未更改品种、账户、周期条件或“先取最新N根、再升序返回”的查询语义，没有批量重写其它SQL。

修复后在dev_vue_m1_a真实结构上11条EXPLAIN/SELECT通过并独立复跑一致，回执 [subscription-window-sql-validation-v7-20260907.json](subscription-window-sql-validation-v7-20260907.json)。本次K线查询使用明确不存在的账户/品种，结果0行；不是非空物理表测试。远端独立window-sql-20260907-09保存0600输入/工具及摘要。

另新增verify-market-candle-sql.mjs：dev_vue只读事务中用CTE替代market_candles，160条目标记录加3条其它账户/品种/周期记录，调用构建后的真实Repository读取1/10/30/100/150/1000条。6场景验证数量、最新范围、升序、精确作用域以及9007199254740993以上价格/成交量的文本精度，重复verify一致。回执 [market-candle-sql-validation-20260907.json](market-candle-sql-validation-20260907.json)。保留数值参数对照成功结果，不把它误写成复现失败；修复前后结果摘要相同。

18项定向测试通过（SQL限额10、市场计划8），类型检查、构建通过。初次构建提示新错误码未加入TradingAccessError联合类型，补齐后通过。本批无DDL/DML，无服务/终端启动。市场数据计划的查询兼容已验证；指标/策略规则、角色及历史时间映射、业务回填、全量自动升级和旧结构清理仍未完成。
