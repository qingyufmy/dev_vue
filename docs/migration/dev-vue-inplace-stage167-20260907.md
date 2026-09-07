# 阶段 167：课程执行入口与学习域父子迁移顺序

课程专用合同限定 courses/learning-course-v1、inplace-learning-course-v1 和课程/课时父实体 PK 引用。新增课程批次执行/恢复入口，沿用已有事务、回执和检查点协议；实际媒体 PK 继续由同事务 source archive 保存并独立核验。没有改写已执行迁移或旧域合同。

readLearningCourseAudit 在新的 REPEATABLE READ 事务中显式读取原课程 26 字段、目标课程/课时/媒体全部审核字段和当前 run/stream 来源存证。子查询同时包含当前 run 所属父实体的子项，即使子项 migration_run_id 被改写，也不能借当前 run 过滤逃过额外实体检查。机器整数和日期使用 SQL 文本；标识符来自固定合同白名单。

migrateLearningCourse 支持 apply/recover/verify。回执确认 committed 后仍需独立回读和三表对账；缺失媒体、实际 ID 与存证不同、损坏存证或多余媒体均拒绝 verified。recover 不创建 run、不补写业务行；unknown 不自动切到重试。

migrateLearningCore 在第一笔事务前验证课程和进度两份 spec、完整转换、不同 run ID、同一逻辑来源/数据库/服务器/恢复副本及同一 sourceSnapshotId，并比较进度完整课时映射与课程产生的映射。课程返回 verified 后才执行进度；课程未提交或结果未知时返回 progress=null。两个域仍各自使用冻结转换与批次，可按原 run 恢复，不伪造跨域单事务。

## 验证和边界

26 项定向测试通过：课程状态机 15 项、课程应用入口/SQL 回读 6 项、父子编排 5 项。包含并发和重复、映射冲突、提交前后确认丢失、恢复不重放、实际媒体 ID 变化、坏 JSON、多余媒体、子域 admission/转换失败时父域不执行，以及跨服务器和不相关课时映射拒绝。

以上仍是内存事务和 Mock SQL 证据。本轮没有执行真实 DDL/DML。课程和进度两条应用入口已接通，但还需实际运行环境/冻结 manifest 接入、迁移控制记录完整核验和开发恢复副本真实事务/中断恢复演练。文件外部可读性、历史时区、业务消费者切换和全库其它领域不在这组通过测试的证明范围内。全域规范化与部署自动升级目标仍未完成。
