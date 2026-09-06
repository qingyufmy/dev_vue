# 阶段 65：推荐表同库升级与真实恢复验证

追加 `010_user_referral_accounts.sql`，直接采用 V4 参考库已执行根迁移后的 SHOW CREATE TABLE 定义。`inplace-referral-schema.mjs` 在已有 45 步后追加 CREATE，完整校验参考库 28 条迁移 checksum，保留 DECIMAL(20,8)、两个推荐码的排序规则、非唯一索引及用户外键；不回填默认余额，不改变 users 现有字段。

## 真实执行

- 参考定义：`dev-vue-referral-schema-reference-20260907.json`，只读获取；参考表为空。
- 恢复副本 `dev_vue_m1_source_20260907_02`：实际 CREATE 1 次，成功后销毁连接；重连根据表定义与 started 日志补记 completed，没有重复 DDL；再次执行 0 DDL。
- 副本回执：`dev-vue-referral-schema-rehearsal-20260907.json`，SHA-256 `210810f7ef4c0a86a0c645e8539443dc35053e601479565a868abf6932acc893`。
- 工具包：115 个文件逐项核验；SHA-256 `2cfdc22f0ac45de5272836b13b9ce504de1579537e0eb2e79d87037ed8c4bbf8`。远端 `referral-rehearsal-01` 保留证据，本地临时包已删除。
- 当前 `dev_vue`：统一入口完成 1 条 CREATE、2 次 journal 写入，现 197 表、46 completed。回执 `dev-vue-schema-upgrade-b7e487f8-7298-4ddf-91a3-dc1a0cbb32f1.json`。
- 独立再次执行：0 DDL、0 journal 写入，回执 `dev-vue-schema-upgrade-00bac4b4-7d88-440e-afc9-789d7d4aab6a.json`。

副本与开发库均保留原 165 表/271007 行指纹。五项已完成的用户默认值差异仍由原精准还原器处理，未放宽其他 schema 漂移检查。没有业务 DML、服务启动、部署、结算或终端操作。

## 检查与验收

合同复核：新表定义绑定真实参考库，不把来源码改为用户外键、不增加码唯一性、不初始化财务记录。依赖 users 已存在；整个历史与所有目标先预检后写 journal。

恢复复核：真实 CREATE 响应丢失后的恢复、重复执行和原数据对账通过；新证据门绑定实例、备份、46 步 checksum、完整工具 hash 和恢复结果。原 29/40/45 步证明文件及 SQL 保持不变。

52 项协调器/转换测试和 36 项新旧证据门测试通过（两组含 3 项重复，合计 85 个不同用例）。变更入口显式调用，不从应用启动迁移。

## 尚未完成

推荐表为空；阶段 64 的 25 条转换候选尚未成为真实目标记录。下一步接入同批源证据/回执/检查点、提交未知恢复和独立目标回读，再完成副本与当前库回填。旧推荐字段继续保留；财务写协议、全库业务迁移、自动部署升级全链路与最终删除门仍未完成。旧的 45 步来源检查器会拒绝新增历史；后续读写适配器必须显式采用 46 步，不能过滤日志绕过检查。
