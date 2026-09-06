# 同库升级第三十九批：有数据的时钟归属查询验证

新增 verify-subscription-clock-fixtures.mjs，使用server/.env的dev_vue连接，在真实MySQL8.4.8只读事务内用10个CTE影射查询涉及的全部表，注入合成行后调用构建后的readTransactionAccountClock实际SQL。逐一校验FROM/JOIN表名都已被CTE影射，参数绑定数据，不读取真实业务行，不创建临时表，不执行DDL/DML，最后回滚。

16场景通过：正常来源；旧owner revision、错误owner、结束区间、删除用户、解绑终端、其他用户profile、平台不匹配、投影revision不一致、来源用户/区间不一致、重绑实例、新连接epoch、多绑定；以及stale/observer_bootstrap时钟。来源不匹配返回null；正常校准来源允许指定周一UTC+3跨午夜窗口，stale/bootstrap虽可读取同源快照但不授予执行许可。

回执[subscription-clock-fixtures-20260907.json](subscription-clock-fixtures-20260907.json)保存每场景fixture摘要、SQL摘要及结果；SQL摘要f41cc8528002df194ba3cf6f5dc6597e73c6e103d2098003161be833d993fd15与前期真实结构验证一致。独立--verify重跑16场景并逐项对比回执通过，脚本语法和diff检查通过。

复现：先pnpm run build:server:v4，再node scripts/verify-subscription-clock-fixtures.mjs --verify。默认写回执使用wx，不覆盖已有证据。

本批证明合成数据下实际JOIN/过滤和时段判断行为，不证明物理表锁竞争、事务隔离并发或完整执行业务流程；concurrencyVerified=false。开发源库数据未改变。下一步继续验证冻结证据及迁移字段转换，完整自动升级和旧结构清理未完成。
