# 阶段 73：推荐账本真实 MySQL 约束验证

开发用参考库 dev_vue_m1_a 已执行 011_referral_credit_ledger.sql，生成实际 SHOW CREATE TABLE 定义。该 SQL 现已执行，保持不可变；参考库这次结构探针单独记入本阶段回执，没有伪造新的根 schema_migrations 记录。当前 dev_vue 和恢复副本尚未安装账本，仍需正式升级步骤接入。

`probe-referral-ledger-schema-host.mjs` 在固定参考库/UUID 下先检查表不存在，再建表；测试用户采用显式负 ID，不推进 AUTO_INCREMENT。测试用户、推荐账户、迁移 run 和两条合法账本写入位于同一事务，测试结束完整回滚。事后核验账本 0 行、测试用户 0 行、测试 run 0 行。

合法案例：负一期初余额、从负余额增加到正余额的佣金入账。拒绝案例：重复版本、opening 非首版、opening 带 delta、opening 缺少 run、重复业务事件、缺失账户外键、金额等式错误、NULL delta、零入账、扣减透支。10 项反例均验证 MySQL 的具体错误码，非仅检查 SQL 文本。

证据 `dev-vue-referral-ledger-schema-probe-20260907.json` 包含实例、MySQL 版本、输入 SQL hash、实际定义、错误码和回滚结果。上传的脚本/SQL 在执行前逐项比对 SHA-256，凭据经匿名内存 FD 传入；没有向当前开发库写业务数据或启动服务。

本次仅证明数据库单行 CHECK、唯一键及账户外键的所列路径；不证明跨行版本连续、账户余额与账本同事务一致、来源权限及退款一次性。迁移 run 外键存在于实际定义，缺失 run 的错误路径未单独插入测试，不扩大验收结论。

下一步用实际定义绑定同库第 47 步，在恢复副本验证建表响应丢失恢复，再升级当前 dev_vue 并持久化 25 条 opening。全库业务迁移、部署自动升级链及旧结构删除仍未完成。
