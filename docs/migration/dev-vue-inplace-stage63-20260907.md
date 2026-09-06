# dev_vue 同库升级阶段 63：用户默认值实际升级

当前 dev_vue 已执行不可变 009_user_state_defaults.sql，email_verified、phone_verified、auth_method、plan_period、changelog_seen_version 的默认值均为 NULL。原有值不回填、不归零、不推定为已验证；历史时间不改写。

统一 `upgrade:dev-vue-schema` 命令输出升级为 v3，采用完整 45 步协调器和五项默认值专用原结构对账。三个已验证阶段分别核验 101、106、110 个演练工具文件以及各自步骤、备份、实例、原数据 hash 和恢复点。

新增 `inplace-user-defaults-proof.mjs`，旧证据校验器和已经执行的 SQL/演练脚本不变。旧的仅支持 29/40 步的脚本保留为历史工具，当前结构操作使用统一入口。

## 实际结果

- plan：前 40 步 completed、新增 5 步 pending，旧数据对账通过。
- 首次 apply：5 条 ALTER、10 次日志写入；内部重跑 0 DDL。
- 独立第二次 apply：0 DDL、0 日志写入，全部 45 步 completed。
- 原 165 表、271007 行原字段 hash 一致。默认值差异通过专用还原器校验，其余原结构保持一致；不能将此表述为原始 SHOW CREATE 字节完全不变。

首次回执：`dev-vue-schema-upgrade-214d2a39-d9bc-4f36-bd91-ad9cd5d6e11e.json`。

重跑回执：`dev-vue-schema-upgrade-a066b947-ada8-4317-8e3b-8cc33c51e811.json`。

41 项定向测试通过，覆盖用户默认值/恢复、110 文件新证据门及原两阶段证据门。真实 plan/apply/独立重复均通过；未启动认证服务或执行真实注册测试。

当前没有业务行回填、旧结构删除、服务启动或部署。本批只修正五项未来 INSERT 默认值；完整账户/策略/业务数据转换、历史时间依据、自动切换及最终清理仍未完成。
