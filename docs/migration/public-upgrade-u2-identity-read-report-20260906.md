# U2 身份账户11表完整只读核验

2026-09-06。本批沿用已授权SSH只读路径，在`debian`的冻结镜像`dev_vue_m1_source_20260905_01`读取身份账户11表全部352行。两次独立连接遍历结果一致，每表实际读取数与同一只读事务内COUNT一致。没有源库或A/B写入、服务启动、迁移或部署。

## 执行与现场修复

复用U1字段合同、`openBackfillSourceReader`、`auditIdentitySourceBatch`及账户候选映射。每表专用连接、UTC会话、REPEATABLE READ只读一致快照、固定主键分页；核对实例UUID、165表结构和每表元数据，读取到exhausted后核对COUNT。预算为每表10000行、总信封30MiB，页超限只缩小页重试。原始字段只在远端进程内存处理，输出仅计数、hash及脱敏问题；凭据经匿名内存FD传递，未写入磁盘或日志。

第一次真实读取users失败：`ER_WRONG_ARGUMENTS / HY000`，上层脱敏为`backfill_source_read_failed`。定位为mysql2预处理LIMIT绑定JS number的类型兼容问题；将已经通过1–500整数校验的limit绑定为十进制字符串，保留`LIMIT ?`及参数化查询。修改后完成两次全范围读取。回归替身补充该类型拒绝行为，补齐非法limit拒绝检查；未修改既有SQL或冻结清单。

## 结果

| 表 | 行数 |
| --- | ---: |
| users | 25 |
| verification_codes | 17 |
| bridge_device_pairings | 1 |
| bridge_refresh_sessions | 17 |
| trading_accounts | 4 |
| mt5_account_bindings | 3 |
| mt5_account_ownership_history | 274 |
| bridge_v3_terminal_sessions | 7 |
| ai_observer_sources | 2 |
| ai_observer_channels | 2 |
| ai_observer_channel_assignments | 0 |

- 25用户的已实现生命周期检查无不一致；6条符合旧状态规则的登录候选条件，不代表密码兼容、会员或实际登录已验收。
- 已支持标量规则共检查470个字段值，无blocked；3746个字段值仍走deferred专用转换，不能据此称全部字段转换通过。
- 4条源账户都有同用户终端平台候选证据及有效绑定引用，候选issues为空。形成3个候选组，其中1组含2条不同用户的账户记录；仍保留各旧ID和设置，不合并、不创建新授权。`settingsConflict=false`只表示没有同一用户的重复设置槽位，不表示跨用户归属已解决。绑定币种仅是当前账户候选证据，不能反推全部历史币种。
- 严格字节关系检查发现274条历史归属和3条绑定身份不同；本次逐值分类全部为ASCII服务器名大小写，login没有差异。无缺父记录、多open owner或绑定/open interval不一致。1个重复账户组仍需显式映射，大小写分类本身不批准合并。
- 1427次墙钟字段检查中，1353个非NULL值通过格式/日历/毫秒精度检查，但历史时区未证明；另74个NULL应保留NULL，不能描述成74个时区异常。21次epoch字段检查通过，其中7个非NULL、14个NULL；未验证历史区间先后和重叠。

## 证据及限制

[机器结果](public-upgrade-u2-identity-read-result-20260906.json)保留两轮时间、实例/库、结构hash、11表元数据和有序内容hash、计数、候选定位hash、字段诊断及执行工具hash。运行目录`/www/wwwroot/aurum-ai`，运行分支`dev_codex`，提交`61610c3c3dc055974d1da90700ecf5336f19434c`；只是复用其mysql2依赖运行临时内存探针，没有替换部署代码。

每表各自持有一致快照，两次遍历内容一致，但不是11表共用一个全局事务快照，也没有重新验证加密备份与镜像全部内容。声明的snapshot ID没有因此升级为内容证明。本批只覆盖11表，剩余154表未做内容遍历，未读取目标业务值对账。`completeSourceVerified=false`、`readyForBackfill=false`继续保留。

验证：读取器定向13项通过；相关35文件268项通过；U1静态校验通过且仍为`executable=false`。真实证据覆盖352行完整SQL逻辑值信封、274行三页读取及独立连接重复摘要一致；不代表实际网络故障、全域财务精度或业务迁移通过。

## 接续

下一批优先核实1353个非NULL墙钟值对应字段的旧写入路径/历史时间依据，并制定重复账户组的目标实体、用户设置和历史owner映射。随后实现身份业务writer及独立目标对账，明确首批演练写入范围。登录、账户、Bridge只读页面联调与这批身份语义接续，不必等待其余154表全部完成后才恢复前端工作。真实业务回填尚未开始。
