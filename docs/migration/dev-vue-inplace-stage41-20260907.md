# 同库升级第四十一批：订阅止盈偏好存储

按 [两轮复审设计](subscription-execution-preferences-design-20260907.md) 追加根迁移027，建立 subscription_execution_preferences_v4 的一对一主键、无级联删除外键、四种模式、合同版本及 revision 约束。已执行迁移保持不变。迁移加载器当前共28个文件、167条语句；原历史前缀检查仍通过。

MysqlStrategyCatalog 新订阅创建事务同时初始化明确的 ai_recommended 配置。新增作用域读取器绑定 subscription/user/account，缺失返回 null，错误版本/模式/revision 拒绝，不回填历史默认值。存储 revision 按十进制字符串读取，避免 JavaScript 大整数精度损失。读取器尚未接入交易员/执行消费者；配置修改 API 和配置冻结仍需后续实现。

验证：偏好存储12项（含原创建事务初始化失败回滚）、策略管理4项、迁移加载/恢复34项，共50项定向测试通过；服务端类型检查、构建通过。这里的事务回滚与作用域绑定为 Mock 证据，不宣称真实 MySQL 外键、锁或跨账户行为验收。

本批未执行027、未写开发业务库。当前 dev_vue 的 strategy_subscriptions 仍是旧结构，不能直接运行该根迁移；同库升级必须在订阅结构转换后纳入此表及逐行模式回填。新增V4服务代码需027结构准备完成才能使用新订阅创建路径。真实结构演练、最终止盈价格转换、记忆/风险配置映射、全量自动升级及旧结构删除均未完成。
