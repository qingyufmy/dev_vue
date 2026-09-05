# M1 / B2 / P2：归属历史、账户设置与分用途授权

> 2026-09-05；实施基线 `60598282`。仅追加结构文件、内部合同和纯逻辑测试，不执行真实 DDL/DML、回填、应用接线或终端访问。
>
> 上游：[B2 设计](./stage-m1-b2-identity-target-contract-plan.md)、[P1 交付](./stage-m1-b2-p1-user-state-schema-report.md)。

## 1. 本批范围与两轮复审

第一轮（需求/职责）：不重建交易账户实体，不把每次接管复制成一套交易记录。账户实体、历史归属区间、当前授权投影、用户私有设置分离。额度仍计算在线连接，不对每个用户只能拥有一个账户施加唯一约束。P2 提供结构及可执行的内部权限规则，P3 再同步接入离线查询与历史采集，P4 接入观摩动态授权。

第二轮（安全/数据/并发）：仅根据当前 owner 读取历史会误拒旧用户，仅根据当前采集用户归因又可能泄漏旧用户记录。两者不能半接线。因此本批不单独放开旧历史接口；先定义可信证据输入、负向授权测试、组合外键和重叠检测。唯一生成列仅限制开放 owner，不代替全历史重叠检查、账户事务锁或投影一致性。原时间来源未证明前不转换为 UTC。

## 2. 019 追加结构

[019 文件](../server/db/migrations/20260905_019_account_ownership_intervals.sql) 包含四条语句：

1. trading_accounts：增加可空 margin_mode（不默认 netting）和 ownership_revision。
2. trading_account_ownership_intervals：每次获得/失去归属单独一行，以稳定 id、origin_kind+origin_ref 防重复；开始/结束为半开区间 `[start,end)`。结束不得早于开始；零长度历史可保留，但不授权任何时点。
3. trading_account_ownerships：保留原联合主键，增加 nullable interval_id、revision 和当前开放 owner 唯一保护。组合外键同时校验 interval_id、user_id、account_id、role，禁止串到另一个用户或账户的区间。
4. user_trading_account_settings：按 user_id+account_id 保存别名、隐藏、暂停、旧审核/观摩状态、原删除标记及来源时间。

区间表与当前授权表分别使用 ended_at_utc / revoked_at_utc 条件生成开放 owner 键；role=observer_source 不占 owner 唯一键。多个账户可由同一用户拥有，同一账户也可保留多个旧 owner 区间。

nullable interval_id 仅为扩展阶段保留已有行的占位状态，不是有效授权。新权限规则拒绝缺失或不匹配的区间；后续切流前必须完成回填并验证所有活动 grant 与开放区间一致、granted_at 对应 started_at。组合外键本身不校验开放/关闭状态与时间相等，仍需原子写入及读前一致性检查。

019 没有 IF NOT EXISTS、DML、级联删除、表重命名或旧字段删除；不造 owner、设备或用户。旧 bootstrap、001～018、011 纠正与冻结源 JSON 不修改。

## 3. 旧字段映射与保全门

| 旧来源 | 019 承接 | 本批不擅自决定的事项 |
| --- | --- | --- |
| trading_accounts.margin_mode | 实体 margin_mode | 不从缺失值推导 netting/hedging |
| trading_accounts.user_id + 旧账户映射 | settings 联合主键 | 多旧 ID 合并冲突需逐源对账，不取最后一条覆盖 |
| nickname / review_status / observe_status / anomaly_code | 同名用户设置列 | 保留长度、NULL、空串及来源排序规则，不用旧审核状态授予新风控权限 |
| trading_accounts.is_deleted | settings.legacy_is_deleted | 原标记不是隐藏、归属结束或实体删除时刻 |
| observed_until / identity_verified_at / first_verified_at | 对应 *_utc 列 | 时间证据门未完成前不能填固定偏移 |
| ownership_history.id | 稳定 interval id + origin_ref | 源 bigint ID 与完整原始身份继续保留映射，不当作当前 grant 主键 |
| ownership_history.user_id / trading_account_id | 区间 user/account 关系 | 账户合并与 MT4/MT5 身份必须先确认 |
| ownership_history.started_at / ended_at / end_reason | 区间起止与原因 | 全部历史区间保留；不能只迁当前开放段 |
| ownership_history.created_at / updated_at 与源 server/login | 后续逐行来源 receipt | 与新目标登记时间分开，禁止丢弃或假造 |
| mt5_account_bindings.current_user/account | 当前授权及 interval 关系 | 当前绑定不是设备档案，不制造 installation/profile |

新增文本列保留来源 utf8mb4_0900_ai_ci；账户/用户外键保持目标实体原有类型。所有历史时间仍需可证明的转换，当前结构缺口补齐不关闭 G-TIME/G-RELATION/G-EVIDENCE 等回填门。冻结字段清单不改写为已就绪。

hidden/connection_paused 为新的运行状态列，默认值只适用于明确的新建用例。后续迁移必须显式映射旧用户/账户开关，不能把默认 0 自动当作“旧用户允许连接”。本批不新增设置行，因此没有自动启用连接或交易。

## 4. 内部授权合同

新增 [领域合同和区间校验](../server/src/modules/trading/domain/account-access.ts) 与 [权限实现](../server/src/modules/trading/application/account-access-policy.ts)，经 trading 模块公共出口提供。输入仅允许由服务端 repository/应用用例从权威事实构造；不得从浏览器提交的 owner、版本、会员或已发布标记直接组装。

| 方法 | 必须证明 | 不提供的能力 |
| --- | --- | --- |
| canReadCurrentAccount | 有效系统用户、本人模式、同账户同用户 owner grant 与开放区间、起点一致、ownership revision 一致 | 不证明缓存投影来自同一 owner/epoch，不能代替 P3 快照来源检查 |
| canReadOwnHistory | 本人模式、记录 user/account 一致，完整发生时间范围；不可变系统来源一致，或完整范围属于本人的归属区间 | 不依赖当前 owner，不接受 unresolved，不向接管者授权全部旧记录 |
| canExecute | 当前 owner 权限、会员交易能力、未暂停/未停机/交易发送开启、精确 profile/instance/epoch 和未过期 lease | **不是执行批准**；统一 execution、风险、revision 与指令 preflight 仍必须执行 |
| canObservePublished | 观摩模式、已发布允许资源、active/ready source、active channel、目标与 revision 一致、短期授权未过期，以及 audience 或显式 grant | 私有历史、原始推理、设备秘密、任何交易写操作 |

账户/版本/epoch 使用精确十进制字符串；内部时间统一要求有效 UTC 毫秒 ISO，拒绝无时区、无效日期或未来历史。观摩保持旧受众关系：all；plus/pro 精确匹配；或本人该频道未撤销授权。pro 不隐式继承 plus；assigned 不因同名会员字符串自动允许。没有管理员全局越权捷径。

历史区间边界采用保守规则：记录从首次到最后一次发生的**整个闭区间**必须落在 owner 的半开区间内；最后发生时点正好等于 ended 也不能仅靠区间推导归属。跨接管、部分成交的整单保持 unresolved，除非有独立不可变系统来源证明；不依靠采集者、品种、备注或接近时间猜归属。

validateOwnershipTimeline 检查重复 interval/origin、无效时间、owner 重叠和多个开放 owner；允许 A→B→A、多个账户和独立只读源区间，不改变输入顺序。该函数不是数据库锁，不能阻止另一个事务同时写入；正式写入仍需账户锁、完整权威范围、固定锁序、唯一约束、CAS 与同事务 outbox。

## 5. 尚未接线的明确边界

- 本批没有 repository SQL 读写实现或 HTTP/WS 接线。现有 TradeHistoryService 的 ownsAccount 门和 collector 当前连接用户归因问题**尚未修复为运行能力**，P3 必须同步处理，不能以本批纯规则测试宣称历史接口已修好。
- P3 将处理离线账户、nullable 档案合同、权限事实生产者、记录级来源关联和历史查询/采集防串号；数据归属不确定时不开放给新 owner。
- P4 才将观摩政策接到列表、context、HTTP 和实时订阅，验证撤权传播上界与丢事件恢复。本批 canObservePublished 只是规则测试，不声称已实现网关重鉴权。
- 新区间/当前 grant/账户 revision/连接撤销的事务写入与真实设备登记仍需对应应用用例，不能只依赖 019 外键或本地 bool 方法。
- 018 与 019 均未在真实目标库执行；此前 A/B 的安装证据仍只到 017。新增列的真实 MySQL 引擎约束、锁等待、中断恢复及回填均须后续单独授权演练。

## 6. 验证与最终复审

- 主代理独立复跑备份、字段清单、基础结构、迁移/恢复及 P1/P2 schema：**19 files / 158 tests 通过**；其中四个结构与迁移执行器文件为 44 tests。
- 服务端全量回归：**41 files / 267 tests 通过**，包含新增权限/区间规则 22 tests；`typecheck:server` 与 `build:server:v4` 通过。
- 当前离线文件计划为 **20 文件 / 149 语句**。019 fixture 验证先完成 018、019 四条按序运行、完成跳过，以及第二条失败后普通 apply 拒绝重放；这不是实际 MySQL DDL 执行证据。
- 最终安全复审补充了观摩 source ID 与 revision 双重匹配、非法/无时区/超出 DATETIME 年份的拒绝，以及完整历史时间范围和精确路由失效用例。保留 current/history/execute/observe 四类独立规则，不提前替换运行中的历史查询门。
- 与基线 `60598282` 逐文件 SHA-256 比对：20 个既有 SQL/纠正文件及两份冻结 identity JSON，共 **22 个保护产物完全不变**；六份相关文档的本地链接检查通过。`git diff --check` 与发布前分支检查通过；仅发布当前 dev_vue 源码，不部署。

当前所有测试为离线/模拟，不访问 MySQL、Redis、Provider、Bridge 或终端。MT5 为使用中账户，禁止交易指令测试。

## 7. 下一阶段

建议下一确认门为 **P3：离线账户读模型与历史记录归属防护**。按统一合同同步修改 API 生产者、消费者、查询授权和历史采集关联，禁止仅靠当前 owner 或采集时用户决定旧交易可见性。仍先实现和离线验证，不据此执行迁移、启动服务或访问 MT。
