# dev_vue 同库升级阶段 58：复盘真实 SQL 兼容验证

本批针对阶段 57 的查询字段变更，在现有 V4 参考库 dev_vue_m1_a 上执行只读 SQL 探针，发现并修正两个分页入口的参数兼容问题。未写数据库、未启动服务或部署。

## 发现与修复

从实际构建产物 MysqlReviewRepository 捕获查询及其绑定参数，不手写替代 SQL。初次 review_cases 查询在 EXPLAIN 阶段返回 MySQL `ER_WRONG_ARGUMENTS`，LIMIT 参数为数字 10。改为字符串形式的整数后成功；manual_candidates 同步采用同样绑定方式。两处原过滤条件、排序、LIMIT 上限来源和 ID 字符串保持不变。

初次输入保留在 `review-projection-sql-input-20260907.json`，修正输入为 `review-projection-sql-input-v2-20260907.json`。初次失败只证明该查询/参数组合在当前 VM 驱动环境不兼容，不泛化为 MySQL 不支持数字 LIMIT。

## 真实验证

6 条查询均连续两次通过 EXPLAIN 和 SELECT，身份固定为 dev_vue_m1_a / `ac423207-6ef3-11f1-b302-000c29fda104`：

- review_cases 列表。
- manual_candidates 列表。
- manual_selection_lock 候选选择行锁。
- memory_updates 列表。
- memory_decision_lock 记忆变更决策行锁。
- review_case_lock 复盘状态行锁。

SQL、参数和源码 SHA-256 随输入冻结；远端脚本和输入上传后先逐文件校验 SHA-256，才运行。结果保留执行计划中的表、访问方式、候选/实际索引、估算行数和 Extra。

完整证据：`review-projection-sql-validation-20260907.json`。远端初次/修正目录分别为现有备份根下 `review-projection-sql-01` 和 `review-projection-sql-02`。

参考库返回行数全部为 0；结果证明列名、关联、参数和行锁 SQL 被实际 MySQL 接受，不证明真实业务行转换、并发行为或有规模数据的性能。尚未覆盖记忆决策成功后的独立回读和全部复盘查询，不能表述为全模块 SQL 验收。

## 回归

新增分页参数回归，覆盖用户/账户过滤及大于 JS 安全整数范围的账户 ID 字符串原样传递。复盘锁/记忆/Worker 合计 16 项测试通过；服务端类型检查及 V4 构建通过。

整体数据库业务回填、历史时间依据、自动切换和旧结构删除仍未完成。本批关闭了计划中复盘查询规范化的一项实际驱动兼容缺陷。
