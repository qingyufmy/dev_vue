# 同库升级第四十五批：订阅构建表与真实预检

从dev_vue_m1_a采集已完成027后的3张实际SHOW CREATE及28项迁移校验和，回执 [dev-vue-subscription-build-reference-20260907.json](dev-vue-subscription-build-reference-20260907.json)。固定UUID，远端独立0700目录subscription-build-reference-20260907-01，工具0600，摘要验证后执行。采集仅执行SELECT/SHOW。

新增inplace/007_subscription_build_tables.sql：strategy_subscriptions_v4_build、subscription_schedules_v4_build、subscription_execution_preferences_v4_build。账户外键指向trading_accounts_v4_build，策略和版本仍指向已准备的strategies/strategy_versions；调度与偏好指向订阅构建表。构建表约束名为原名摘要生成的build_sub前缀，避免同库约束重名；原业务主键、生成列、索引和CHECK语义保持参考结构。

loadSubscriptionBuild绑定完整参考迁移历史与DDL，只追加26项前置后的3步。复用executeOrderedSchema进行日志、前后结构摘要、重复执行和DDL响应丢失恢复。store前置检查继续调用原策略/账户/基础表链路；外层执行者仍需持有升级锁、验证旧数据证据，不能只凭本模块直接上线切换。

职责复核：构建表解决真实同名冲突，不创建第二个在线写入口；3张表不写旧数据，不把无法确定的策略角色、时间来源或记忆模式默认填平。兼容与恢复复核：全部CREATE，无DROP/RENAME/级联删除，已执行迁移不变；所有新表先检查再记录第一步，未登记冲突表拒绝。完成回填/对账前保持原表不动。

15项定向测试通过（6项本批、9项通用有序迁移）：真实参考绑定、账户/订阅引用、约束唯一、只读计划、执行后重跑、三处DDL响应丢失恢复、未登记表冲突。真实dev_vue在升级锁内只读事务完成前置检查，三步均pending，见 [dev-vue-subscription-build-plan-20260907.json](dev-vue-subscription-build-plan-20260907.json)。首次预检因调用mysqlColumnStore漏传hasJournal而错误判为无前置日志；修正为显式已验证日志存在后预检通过，失败过程无写入。

本批未执行3条DDL，未回填或重命名。下一步在原恢复副本执行同样步骤，验证DDL真实结果、响应丢失恢复及旧列数据对账，再用于开发源库。策略角色/配置映射、历史时间依据和完整订阅权限承接仍需完成；全量自动升级和旧结构清理未完成。
