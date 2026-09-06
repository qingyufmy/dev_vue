# 阶段 74：账本第 47 步真实升级

推荐账本已在恢复副本和当前 dev_vue 安装。当前库 198 表、47 completed；账本为空，25 条推荐账户和原 165 表/271007 行保持不变。

新 loader 绑定 011 原始 SQL hash 与阶段 73 的实际 SHOW CREATE TABLE，按 MySQL 标准化定义执行，符合现有协调器的标识符约束；未修改已执行 SQL。表类型、触发器和完整定义均检查，未知表状态拒绝覆盖。

恢复副本实际 CREATE 1 次，成功后断连；重连补记 completed，无重复 DDL。除原行 hash，还逐次核对 25 条已迁推荐账户的完整字段 hash。回执 `dev-vue-referral-ledger-rehearsal-20260907.json`，SHA-256 `582fb0edadf2ccceb5b4b78aa361db8c73667bdcff75f0f02657083699e8d28e`。120 文件工具包 SHA-256 `28c6025c073dbe841d43de0d9ab8ec52204ddbff5cd0c764e2b360dad27c4c65`，逐文件核对通过，远端证据保留、本地 tar 清理。

统一升级入口核验新演练证据及旧 29/40/45/46 步证据后，当前库实际执行 1 DDL/2 journal 写入，回执 `dev-vue-schema-upgrade-9af873c5-26e2-4052-bb59-296d79966c37.json`。独立重复执行 0 DDL/0 journal，回执 `dev-vue-schema-upgrade-ece43b3e-6c18-4dd0-b4ed-4231b9858b6e.json`。

50 项定向测试通过：协调器 36、新表恢复 3、证明门 11。既有推荐账户已存在时升级前后核对其 hash；更早版本尚无推荐表时，允许其由注册步骤创建，不额外要求先手工安装。

下一步持久化 25 条 opening，并对账每用户期初、来源回执和账户 revision。旧 46 步回填 adapter 会拒绝第 47 步，需要追加明确的新 adapter，不能过滤历史强行复用旧身份。应用财务事务、其他域迁移、自动部署升级全链及旧结构删除尚未完成。
