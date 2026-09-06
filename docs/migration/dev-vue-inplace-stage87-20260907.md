# 阶段 87：支付两表第 49/50 步完成同库安装

追加 payment match coordinator 和证明门，沿用既有 48 步后依次登记 `inplace_012_01_payment_transactions`、`inplace_012_02_payment_matches`。完整日志顺序/checksum、SHOW CREATE TABLE、表类型及触发器检查继续保留；013 SQL 和历史证明文件未修改。

恢复副本 dev_vue_m1_source_20260907_02 完成两次真实 CREATE 后断连：重连分别核对已提交结构、补全日志，未重建表。总计 2 DDL、2 次恢复、重复无操作。[恢复回执](dev-vue-payment-match-rehearsal-20260907.json) SHA 为 `99554a44a25f1be782cef247c8561e2bfbad0452d9bb1b1010304914535f367e`，绑定 130 个工具/证据文件，远端目录 `/www/backup/aurum-v4/m1/20260906-01/payment-match-rehearsal-01`。

统一结构升级 CLI 提升 v7，继续验证前序全部证明，并新增第 49/50 步证明及原有 payment_orders 全字段 hash 保护。执行前后校验原 165 表/271007 行、25 个推荐账户、25 条账本和已有订单目标行；本次订单目标为空，不能将空表保护证据描述为已验证非空业务回填。

当前 dev_vue 实际结果：

- [首次安装](dev-vue-schema-upgrade-b62912a1-679c-4081-8804-541ac0635675.json)：2 DDL、4 日志写入，内部重复通过。
- [独立重跑](dev-vue-schema-upgrade-9e430a55-19f0-46d0-bae3-7cd7368a0e81.json)：0 DDL、0 日志写入。
- 独立查询：201 表、50 completed；payment_orders/payment_transactions/payment_matches 均 0 行；推荐账户与账本各 25 行。两次升级回执确认原 271007 行保持一致。

68 项定向测试通过：两表协调 4、两表证明 15、前序订单证明 13、公共协调 36。涵盖两种 CREATE 断连位置、重复、后续表冲突、证据路径/文件/源数据绑定和恢复逻辑。真实恢复和当前库证据如上。

支付目标结构现已具备，仍不代表支付功能或数据迁移完成。后续需要带历史 UTC 和资产配置证据的完整 writer、源字段证据、独立逐订单/匹配对账及业务切换。早期固定 48 步及更早工具应保持拒绝未知日志，不能过滤后来步骤绕过检查；当前结构入口为 v7。全库自动部署升级、运行回滚和旧表删除门尚未完成，本轮没有支付、通知、权益或公网操作。
