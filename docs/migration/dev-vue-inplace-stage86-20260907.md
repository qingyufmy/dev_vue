# 阶段 86：支付交易与匹配目标结构

追加 013_payment_matches.sql，包含 payment_transactions、payment_matches；[物理合同](payment-match-physical-contract-20260907.md) 覆盖来源字段、两个复合外键、单一认领、独立金额、状态职责和两轮复审。SQL 已在开发参考库 dev_vue_m1_a 执行，现已冻结；当前 dev_vue 仍为前一阶段的 48 步，尚未安装两表。

真实 MySQL 8.4.8 回执见 [约束演练](dev-vue-payment-match-schema-probe-20260907.json)，SHA-256 为 `f67c0bc361d852dc2799683640f11d5f22ea2f4bc3bbe8f2cd3a17678cecb14b`。远端目录 `/www/backup/aurum-v4/m1/20260906-01/payment-match-probe-01`，上传 SQL、probe、匿名凭据 launcher 和 SQL parser 后逐文件检查 hash。

验证结果：

- 2 条合成交易观测、3 条合法匹配（pending、confirming、历史 expired）写入成功。
- 18 类拒绝：跨用户、跨地址、跨资产、跨链、重复订单匹配、重复交易认领、无订单、无迁移 run、负期望金额、零确认策略、native 无确认策略、无效时间窗、未知状态、confirmed 无交易、pending 带交易、交易哈希大小写重复、零实际金额、观测时间倒退。
- 跨目的地/资产/链测试使用尚未认领的独立交易，避免被重复认领唯一键提前拦截而误称复合外键通过。
- 独立 JOIN 回读 expected_amount 为 1.00000000、received_amount 为 1.00000001，金额差精确保留。
- 事务最终回滚，新两表业务行、4 个订单 fixture、2 个用户 fixture 和迁移 run 均为零。表结构保留；自增元数据可能变化，不宣称参考库字节级还原。

这证明 MySQL 结构与约束，不证明链上服务、支付确认/订单状态事务、权益发放或旧数据转换。原 8 条监听没有被导入，更未补造交易。资产合约的历史配置依据、订单/过期 UTC、旧确认数来源、金额容差及未完成义务恢复仍按合同核验。

下一步将两次 CREATE 登记为第 49、50 步，在恢复副本分别注入 DDL 后断连并验证完整恢复，再安装当前库。保留旧表，直到完整回填、业务接续和删除门满足。
