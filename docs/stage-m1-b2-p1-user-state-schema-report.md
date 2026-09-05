# M1 / B2 / P1：用户状态与推荐账户结构

> 2026-09-05；实施基线 `8eef0b94`。状态：P1 追加结构文件与离线验证完成。本批只交付追加 SQL 文件、离线测试与来源映射，不执行真实迁移或数据回填。
>
> 上游：[B2 目标结构方案](./stage-m1-b2-identity-target-contract-plan.md)。Telegram 绑定已取消，不在本批建立绑定表或入口。

## 1. 范围与实施前复审

第一轮（需求与复杂度）：保留已有 users 主表及认证合同，仅追加 8 个标量字段，推荐账户独立一张表。既不要求用户填写新资料，也不重建用户中心、会员系统或财务账本。不为已经取消的 Telegram 绑定建设活动结构。

第二轮（数据与安全）：以冻结的 [来源元数据](./migration/m1-b2-identity-observation-20260905.json) 核对类型、空值、默认值和排序规则。旧 email_verified 默认 1 不能直接沿用；推荐金额不能因缺省被默默置零。只追加新文件，不修改已执行的 bootstrap、001～017 或 011 纠正文件。真实 DDL、时间转换、权限切流和财务写入仍是独立验收门。

## 2. 交付结构与逐字段承接

追加文件：[018 用户状态与推荐账户](../server/db/migrations/20260905_018_user_state_and_referral_accounts.sql)。包含两条结构语句：ALTER users、CREATE user_referral_accounts。**SQL 文件存在不等于目标库已经有这些字段。**

### 2.1 users 的 8 个新字段

| 冻结源字段 | 018 目标 | 保存规则与剩余门 |
| --- | --- | --- |
| users.email_verified | users.email_verified TINYINT NULL | 明确迁入原 0/1/NULL；目标默认 NULL，不自动验证 |
| users.phone_verified | users.phone_verified TINYINT NULL | 明确迁入原 0/1/NULL；目标默认 NULL |
| users.auth_method | users.auth_method VARCHAR(20) NULL | 原来源值；不授予登录能力 |
| users.plan_period | users.plan_period VARCHAR(20) NULL | 原会员周期，包括空串和 NULL |
| users.plan_source | users.plan_source VARCHAR(20) NULL | 原购买/赠送等来源，不产生新订单或会员权益 |
| users.last_seen_at | users.last_seen_at_utc DATETIME(3) NULL | 先证明旧时间语义；不按本机时区或固定偏移转换 |
| users.changelog_seen_version | users.changelog_seen_version INT NULL | 原已读位置；不拿它控制权限 |
| 无旧对应列 | users.profile_revision BIGINT UNSIGNED DEFAULT 1 | 新结构并发版本；与 token_version 分离，不冒称旧修订号 |

三个新增 VARCHAR 字段显式使用来源 `utf8mb4_0900_ai_ci`，不因沿用主表默认排序规则而悄悄改变新增字段比较语义。所有七个旧字段的目标默认 NULL；回填必须显式提供原值，不能将默认值作为映射实现。

既有 id、uid、密码哈希、联系方式、角色、会员、生命周期和 token_version 均未修改。新增字段暂不进入现有 Profile DTO，也不改变当前认证判定。新注册显式写未验证、联系方式验证、已读更新、活跃时间异步节流和 profile_revision 并发写入属于后续应用用例；本批不宣称这些用例已完成。

### 2.2 推荐账户单独承接

| 冻结源字段 | 018 目标 | 保存规则与剩余门 |
| --- | --- | --- |
| users.id | user_referral_accounts.user_id INT PK/FK | 保留系统用户 ID；包括仍需保全数据的已匿名化用户 |
| users.referral_code | user_referral_accounts.referral_code VARCHAR(50) NULL | 原字符串、空串、NULL；普通非唯一查询索引 |
| users.referred_by | user_referral_accounts.referred_by_code VARCHAR(50) NULL | **推荐码，不是用户 ID**；不强转数字，不加指向 users.id 的外键 |
| users.referral_credit | user_referral_accounts.referral_credit DECIMAL(20,8) NOT NULL | 精度与来源一致、无默认余额、不夹到非负；金额对账另验 |
| 无旧对应列 | revision BIGINT UNSIGNED DEFAULT 1 | 新并发基线，不冒称旧账本版本 |
| 无可靠旧行更新时间 | updated_at_utc DATETIME(3) NOT NULL | 后续回填明确记录新目标行登记时间，原时间/来源另由 receipt 保留；无 NOW 默认 |

两个推荐码字段显式保留 `utf8mb4_0900_ai_ci`。本批不增加码唯一约束：先完成大小写/重音等值、空串和历史重复码专项核对，再决定未来活动码查找键。未完成该门之前不得用 `LIMIT 1` 猜推荐人或启用兑换/结算。

外键只保证用户存在，不启用级联删除。创建表不自动给任何用户插入余额；一个旧用户是否承接推荐行、明确的期初来源和每用户金额一致性由后续回填清单决定，不能把“无行”解释为“余额零”。完整 ledger + balance 原子写协议完成前，不启用新财务写入。

### 2.3 冻结清单和 Telegram

旧冻结 manifest/observation 不改写，其 138 个 blocked 字段不会因本批增加 SQL 文件自动解除。本节是实现位置补充，不是可执行转换器或新的整批就绪清单。后续 manifest 版本必须带已安装结构、时间证据、整行关系、转换和对账证明。

旧 Telegram 字段只保留来源和退役历史处置计划。本批既不新增绑定能力，也不删除、清空或重新激活旧字段和通知。

## 3. 安装、并发和中断边界

- 正式执行仍使用已有显式迁移工具和检查点；本批不执行 CLI，也不修改启动入口，不自动安装到 A/B 或旧源库。
- 018 追加在 017 后；基线的已安装状态仍停在此前实际验收的 017。当前代码计划与数据库实况分开记录。
- ALTER 与 CREATE 不宣称跨语句事务原子性；第一条成功而第二条失败时保留检查点，禁止普通重复 apply 或 DROP 回滚。后续真实演练必须验证恢复证据，不能随意补 IF NOT EXISTS 遮盖半成功。
- 字段结构只提供版本储存位置，不保证应用已经实现 CAS；实际写入须经所属域 repository、权限、幂等、短事务和审计。
- 本批不添加用户联系方式唯一键，不改变推荐码唯一规则，不为高频活跃字段添加未经 EXPLAIN 验证的索引，也不宣称消除死锁或已优化实际耗时。

## 4. 验证记录

- 主代理独立复跑备份、字段、基础结构、迁移/恢复及新增用户结构回归：**18 files / 148 tests 全部通过**。定向三个文件合计 34 tests。
- 018 静态合同验证包含十个来源字段的类型/长度/NULL/排序规则、金额精度、无默认余额、无级联、无 Telegram 及只追加语句约束。
- 真实文件计划经已有离线加载器读取为 **19 文件 / 145 语句**。fixture 使用真实计划和既有 011 correction，验证停在 017 后只执行 018、完成后跳过，以及 018 第一条成功第二条失败时普通 apply 报 `migration_incomplete`，两条 DDL 均不重放。
- 与基线 `8eef0b94` 逐文件 SHA-256 比对：19 个既有迁移/纠正文件和两份冻结 identity JSON，共 **21 个保护产物完全不变**。
- 新增与修改测试文件的 `node --check`、`git diff --check` 通过；相关文档本地链接存在性检查通过。
- 最终代码复审移除了 `CREATE TABLE IF NOT EXISTS`，以严格 CREATE 暴露意外已有对象；没有放宽迁移执行器或改写旧校验和。补半成功回归以区分“完成跳过”和“失败不能重放”。

上述只是离线合同、fixture 与文件证据，**不是 MySQL 引擎语法/锁行为/真实安装或逐用户余额对账证明**。本批未执行真实 DDL、写入源库/旁路库、Redis、Provider、Bridge 或 MT 访问。未改业务运行代码，不运行应用构建或宣称完整注册、会员、财务功能已经补齐。

## 5. 下一确认门

本批结束后建议进入 **P2：账户归属历史区间、用户账户设置与分用途授权合同**，仍先做代码、追加迁移文件和离线测试。当前账户操作权、本人历史记录权限与观摩发布权限必须分开，不能用当前 owner 关系抹掉历史或给新 owner 暴露旧用户私有记录。

其它 154 张源表的 B2 精确评审、B3 回填、完整应用联调和旧表清理仍未完成。当前 MT5 为使用中账户，不执行交易测试。
