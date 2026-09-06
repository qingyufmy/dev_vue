# 阶段 99：会员结构第 51 步同库升级

会员结构已接入升级器 v8，并完成恢复副本和当前 dev_vue 的追加升级。当前实查 202 表、51 completed；memberships 与支付三表均为空，未回填会员或切换权限读取。

## 实现与保护

- 新 membership coordinator 追加 inplace_013_01_memberships，验证 014 SQL 散列、真实参考建表回执、BASE TABLE、触发器和规范 SHOW CREATE 指纹。
- 升级器继续验证全部旧前缀证明，再验证会员真实恢复证明。没有忽略未知步骤或修改已执行 SQL。
- 新增支付交易、匹配和既有会员行的显式全列散列保护；原有推荐余额、账本、订单和旧 165 表校验继续执行。

## 实际执行

恢复副本 dev_vue_m1_source_20260907_02：在 CREATE TABLE 实际完成后销毁连接，重连后识别 reconcile，仅补迁移完成记录，不重放 CREATE；共 1 次 DDL、1 次断连恢复，重复无新增。

回执 [dev-vue-membership-rehearsal-20260907.json](dev-vue-membership-rehearsal-20260907.json)，原始 SHA-256 `b4a109edaeeb3bca5dd152f8a267da17e75952b17b01e442f78fbc391bc7b9c1`，绑定 136 个文件。远端目录 `/www/backup/aurum-v4/m1/20260906-01/membership-rehearsal-01`。

当前 dev_vue：

- [首次升级](dev-vue-schema-upgrade-5c1f4975-c2a9-4af9-a166-60b2bff8d45b.json)：1 DDL、2 journal writes。
- [独立重复](dev-vue-schema-upgrade-c2c2b72d-dc46-4107-994b-6f3e295c570b.json)：0 DDL、0 journal writes。
- 原 165 表/271007 行与基线一致，推荐账户和 opening ledger 各 25 行保持原值；支付数据散列保持一致。

56 项协调器、会员步骤与证明篡改测试通过。执行入口仍为 `node scripts/upgrade-dev-vue-schema.mjs --plan|--apply`，无服务启动时自动迁移。

## 后续边界

下一步接入会员业务 writer、完整来源归档、批次事务和恢复验证，再按实际依据推进回填与消费者切换。旧 users.plan* 未删除。历史 50 步读取/回填工具仍按原版本拒绝新步骤，后续业务工具需追加明确的 51 步适配，不能过滤迁移记录绕过检查。

全量自动升级入口、其余业务域转换、读写切换和旧结构删除均未完成；本阶段只证明会员结构的无损追加升级。
