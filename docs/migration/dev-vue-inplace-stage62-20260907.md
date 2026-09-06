# dev_vue 同库升级阶段 62：用户默认值规范化演练

核对根迁移 018 与真实 users 定义后，追加 009_user_state_defaults.sql，将 email_verified、phone_verified、auth_method、plan_period、changelog_seen_version 的默认值改为 NULL。只影响未来 INSERT 省略字段时的结果，不更新任何已有用户状态、历史时间或权限。

旧默认值依次为 1、0、email、空字符串、0。V4 根目标声明均为 NULL；尤其不能让未来用户仅凭省略 email_verified 就得到“已验证”状态。该变更不替代认证流程验收。

`inplace-user-defaults.mjs` 在既有 40 步后追加 5 步，精确绑定每列原类型、NULL、默认值、排序规则与 EXTRA，SQL 只允许指定列 SET DEFAULT NULL。现有表/列类型、行数据、索引不变。

原结构对账增加局部还原器：仅把五个已审核默认值 token 还原为旧形式，再沿用原 schema 指纹核验；协调器独立验证当前默认值是否符合 journal 状态。其他类型、列名、索引、约束差异没有被忽略。原行 hash 直接读取真实列值，不经过还原器。

## 真实副本结果

固定恢复副本 dev_vue_m1_source_20260907_02 实际执行 5 条 ALTER，分别在 email_verified、auth_method、changelog_seen_version 成功后断连。3 次重连均补记而不重复 DDL，最终 45 步 completed；重跑 0 DDL。

原 165 表、271007 行旧列内容前后及最终校验一致，现有用户值未改写。当前 dev_vue 仅采集源定义，尚未执行 009。009 已在副本执行，必须保持不可变。

回执：dev-vue-user-defaults-rehearsal-20260907.json，SHA-256 `dd6987a7905fbb45089a44e7288ca3e4b24fc7c2b29247d7df5d982d0a3ba090`。

工具包 SHA-256 `6fd64c95860e4da207ae43ab4eb9b20b1272c816271a7fe26dda9c2473a7f215`，110 个文件与本地逐项核验一致。远端 user-defaults-rehearsal-01 证据保留，本地临时包已删除。

## 复核与验证

需求复核：采用 ALTER COLUMN SET DEFAULT，不通过 MODIFY 顺带改变类型、NULL 或排序规则；不以目标默认值回填旧用户。

恢复复核：前后默认值绑定日志；五个离线中断点和三个真实中断点覆盖新增路径。原 schema 指纹仅接受明确默认值差异；测试确认无关类型变化仍影响指纹、缺列会拒绝。

57 项定向测试通过，包括 8 项本阶段转换/恢复/指纹测试。真实副本演练如上，无服务、登录、模型或交易测试。

下一步将默认值演练证据与新版原结构对账接入统一入口，再升级当前 dev_vue。历史时间、业务回填、自动部署切换和旧结构删除仍未完成。
