# 阶段 165：学习进度批次执行、恢复和 SQL 独立回读

学习进度专用合同限定 inplace-learning-progress-v1、同库目标、progress/learning-progress-v1 流及 learning_progress 目标。沿用已验证的事务状态机，新增领域适配文件，保留已有域实现及其历史证明绑定不变。批次回执、ID map、业务 writer、来源存证和检查点在同一 repository 事务中执行。

migrateLearningProgress 应用入口支持 apply、recover、verify。绑定 run、来源集合和转换摘要；apply 登记并顺序提交批次，recover/verify 只查询已有批次结果。遇到 not_committed/unknown 立即返回，既不创建 run 也不重放 writer。所有批次确认 committed 后，还需新事务核对目标身份及 run 绑定，并使用独立 SQL 回读和阶段 164 审核器，只有审核通过才返回 verified。空来源同样不能跳过 run 和目标身份检查。

readLearningProgressAudit 显式读取来源八字段、目标十三字段、当前 run/stream 的来源存证，以及真实用户与课时身份。整数、DOUBLE 和日期使用 SQL 文本，不依赖 JavaScript 数值或本地时区。来源全量读取意味着本入口当前针对完整冻结 progress 集合；不能把它当作任意子集回填入口。

学习进度 repository 在 BEGIN 前显式设置 REPEATABLE READ，避免连接池复用后继承其它隔离级别。设置失败销毁连接，业务 SQL 不执行；最终多表读取在新事务一致快照中完成。

## 验证与证据边界

本轮 28 项定向测试通过：执行/恢复状态机 15 项，SQL 回读及真实批次合同衔接 3 项，应用编排 6 项，repository 4 项。覆盖并发重复、内容冲突、跨 run 映射、提交前/后确认丢失、仅已确认死锁回滚可重试、回执不符回滚、错误检查点、行/字节上限、损坏存证、域越界、恢复不补写、已提交但业务行损坏，以及隔离级别初始化失败。

这是纯函数、内存事务和 Mock SQL 证据，不是 MySQL 实际运行验收。本轮没有连接或修改真实数据库，没有新 DDL，没有切换业务消费者。来源八字段和目标字段的真实 SQL 行为、当前 62 步身份检查及提交故障仍需开发恢复副本演练。

尚需课程批次及课程独立对账、真实进度命令环境/冻结清单接入、迁移控制记录的整体核验和开发恢复副本演练。真实时间依据未解决的历史行不能由合成测试 UTC+8 替代。全域规范化、部署自动升级、最终读写切换和旧结构删除仍未完成。
