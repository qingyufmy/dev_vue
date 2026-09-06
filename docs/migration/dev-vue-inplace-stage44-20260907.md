# 同库升级第四十四批：偏好结构与真实SQL演练

实际目标为开发V4参考库 dev_vue_m1_a，MySQL8.4.8，UUID ac423207-6ef3-11f1-b302-000c29fda104。受影响的 strategy_subscriptions、terminal_history_deals_v4、account_trade_records_v4 在执行前均为0行。通过既有 runSchemaMigrations 的完整历史校验和锁，顺序完成026的两条ALTER及027的一条CREATE，跳过原26个迁移；立即重复执行跳过全部28个迁移，无重复DDL。没有向dev_vue源库执行DDL/DML。

回执 [preferences-reference-upgrade-20260907.json](preferences-reference-upgrade-20260907.json) 保留实际SHOW CREATE、完整迁移历史及两次结果。远端独立0700目录 /www/backup/aurum-v4/m1/20260906-01/preferences-reference-20260907-01 保存0600工具及回执；部署包SHA256为567acdcd45c1b1df2fbfbfcf5737e5070f9632af1c3f5f724a5207c7e51562b1。复用已有凭据memfd方式，不在参数、文件或日志中输出密码。新脚本只针对固定空V4参考表，不是通用旧库自动升级入口。

capture-subscription-window-sql 更新为v5，捕获当前构建源码的10条SELECT，新增偏好作用域读取，执行查询含偏好JOIN。真实参考结构上10条EXPLAIN/SELECT全部通过并独立复跑一致，结果为0行。回执 [subscription-window-sql-validation-v5-20260907.json](subscription-window-sql-validation-v5-20260907.json) 包含两轮结果与工具摘要；远端window-sql-20260907-07保留固定输入。

另新增 verify-subscription-preference-fixtures.mjs，使用server/.env的dev_vue只读事务，通过两个CTE影射实际查询中的两个物理表。8场景通过并独立--verify一致：匹配、错误用户、错误账户、错误订阅、模式变化、大整数revision变化、无效版本、无效模式。当前真实数据库内执行SQL/参数和字符串revision比较；不读取真实业务行、不创建临时表或写业务记录。回执 [subscription-preference-fixtures-20260907.json](subscription-preference-fixtures-20260907.json)。

服务端重新构建、脚本语法与diff检查通过。零行结构查询和CTE场景不能替代物理表并发、完整交易流程、非空旧数据升级或终端验收。开发源仍保留旧订阅结构；027已经在参考库完成，不代表dev_vue已完成。下一步继续旧字段适配、订阅目标构建与回填；全量自动升级和清理目标保持未完成。
