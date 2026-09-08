# 当前 dev_vue：147 → 165 升级接入方案

本方案落实全栈模块化方案第 14 节工作包 4。当前状态以 [本次只读回执](current-dev-vue-upgrade-observation-20260908.json) 为准；恢复副本的既有回执只证明工具演练，不能充当当前库的执行许可或源数据摘要。

## 1. 当前事实

- `.env` 指向的库为 `dev_vue`，MySQL 8.4.8，实例 UUID `ac423207-6ef3-11f1-b302-000c29fda104`，检查连接使用 UTC。
- 当前 222 张表，147 条迁移日志全部 completed，并与目标 165 步注册表的前缀逐项匹配。完整旧协调器的结构检查通过。
- `users` 25 行、旧 `trading_accounts` 4 行、归属历史 274 行；四张账户构建表均为 0 行。
- 尚有 18 个注册步骤；`trading_context_changes_v4` 不存在。新账户消费者目前不能直接启用。
- 307 项冻结迁移文件摘要仍匹配。检查执行于本地；没有数据库业务写入、DDL 或服务启动。

这是一次一致性只读数据事务及重复元数据观察，不是新备份、全表数据对账，也没有证明所有写入者已停止。

## 2. 执行顺序与具体产物

| 顺序 | 工作与产物 | 进入下一步的条件 |
| --- | --- | --- |
| A | 补当前库专属准备入口；读取源账户、终端与归属事实，重新计算映射、转换及保护表摘要，持久化不可覆盖的 manifest | 当前 UUID/147 步结构与日志匹配；冲突清单为空；新 manifest 引用本次源数据，不能复制副本 targetIdentity |
| B | 识别本地应用、Worker、Bridge 及数据库事件等潜在写入来源；准备当前快照备份并恢复验证，备份文件保存在本地 | 写入窗口已控制；备份可恢复且数量/主键/精确数值/UTC 摘要一致；只有数据库运行于 VM |
| C | 账户源数据回填到四张构建表，复用 v2 转换、批次日志、源行证据和提交未知恢复 | 旧 4 行账户与 274 行归属历史全部有可追溯处理结果；合并通过映射解释，禁止用简单总行数相等代替对账；原表及旧 ID 保留 |
| D | 035：账户根原子提升，148 步；036–038：终端、观摩、上下文、运行投影，160 步 | 每段生成当前库自己的 proof，执行后使用原协调器复核；旧表重命名保留，原外键与软引用逐域处理 |
| E | 039：K 线构建/映射/检查点，163 步；有界回填及对账；040：原子提升，164 步 | 源 K 线按当前快照重算，保留旧表和一对一源映射；精确数值、时间与有序查询核验通过 |
| F | 041：命令回执表，165 步；独立进程重新检查结构与日志、保护表及新增对象 | 全部步骤 completed，未知 DDL/commit 先对账；重入不重复数据、不修改历史 checksum |
| G | 增加明确的运行就绪检查，再启动本地 API/Redis 与浏览器联合验收 | 缺表、版本不匹配、未完成步骤均拒绝启用；账户权限、同键重放、丢失响应、刷新和多标签页有真实依赖证据 |

每段遵循短事务和同连接升级锁；外部访问、备份及浏览器检查不放入业务事务。升级锁只协调升级工具，不能据此认定业务写入者已停止。

## 3. 工具边界与兼容

新增 `review-current-dev-vue-upgrade-local.mjs` 只接受 `--read-only` 和绝对输出路径，输出用 `wx` 防覆盖；凭据只从本地 `.env` 读入，不输出。它明确把 `migrationReady` 和 `runtimeReady` 记录为 false，不能将检查成功当作升级完成。

后续执行入口应固定目标 `dev_vue`、显式接受该库 proof 路径，并复用已有 domain/coordinator/MySQL adapter。不得把 `rehearse-*-local.mjs` 的恢复副本常量改成当前库后直接运行：这些入口还引用副本 manifest、投影证据和故障注入流程。不得修改已冻结的脚本、SQL 或历史报告；新增编排文件承接当前库参数和证据链。

旧 `freeze-dev-vue-account-wave.mjs` 仍使用旧身份读取器及 20260906 固定产物，不能替代当前 147 步 v2 准备入口。旧备份执行器限定 Linux host，也不符合本阶段备份执行留在本地的要求；新入口必须解决本地备份/恢复能力及受限凭据传递，不能偷偷把应用工具搬到 VM。

旧时间按 UTC 零偏移迁移，金额、价格和手数维持十进制精度。实验室的终端时间、其它页面的北京时间只在展示层处理。

## 4. 中断与回退

准备失败不写库；批次写入失败复用原 run/batch 身份恢复。提交未知先查询批次/业务回执；DDL 响应未知先通过日志、规范结构和保护摘要判定，不盲目重放。失败输出仅包含稳定错误码，不包含 SQL 凭据或业务原文。

启用新消费者前可停止在已核验阶段，保留日志与构建结果。启用后出现新写入，不得直接恢复旧备份丢弃新增事实；应停写、保留增量，再依状态进行前向修复或经过对账的恢复。

## 5. 两轮复审

第一轮（需求与职责）：当前缺口是目标库接入，不能继续仅提升恢复副本。保留现有转换和协调器，新增当前库入口，不引入另一套迁移框架。调整为账户回填先于 035，K 线回填位于 039 与 040 之间；18 个 DDL 步骤不能代替两次数据回填。

第二轮（兼容、并发与证据）：147 条旧日志/结构与 307 项工具均已实时核对，但本次观察未冻结写入者、未生成完整当前备份和源行摘要。因此只读回执不能成为 apply proof。调整为独立的当前库 manifest、备份恢复及各段 proof 链，保留未知状态确认与增量事实。剩余风险是当前写入来源、备份可恢复性、源数据变化和新消费者真实权限验证，分别由 B、A/C/E、G 关闭。

当前交付：只读观察脚本、实际数据库回执和具体升级接入顺序。A–G 尚未执行完成，当前库仍为 147 步。

## 6. 当前数据准备结果（第八十一批）

新增prepare-current-account-wave-local.mjs与独立准备模块，复用既有v2身份、映射、转换及快照读取器。实际只读执行生成[current-account-wave-preparation-20260908.json](current-account-wave-preparation-20260908.json)：当前222张表全量数据/DDL摘要、147条日志摘要、全部转换输入摘要与309项工具摘要已记录，不输出源行正文。账户4行转换成3个实体，归属274行转换成274个区间及4条授权；每个批次记录稳定ID、序号与行数，历史时间使用UTC零偏移。

本次执行未调用writer或迁移协调器的apply模式。旧账户表、构建表及日志未写入；源数据处于一致性只读事务，结束前复查每张表DDL、表集合和日志。27项原映射/转换/写入器测试通过。该清单仍明确executable=false：备份恢复、写入者停写以及apply前数据/工具重验未完成，不能凭manifestHash直接回填。

复核：不把副本中的3实体/4授权常量硬编码为当前转换规则；转换结果来自当前输入。整个表集合保留摘要，包括已有迁移账本，后续只能追加新事实。准备模块与CLI分离，后续执行入口复用准备过程核验源漂移，不重新实现业务转换。A的数据准备产物已具备，B的本地备份恢复是下一依赖。

## 7. 本地备份基础能力（第八十二批）

本机未发现可用MySQL命令行客户端，已从[MySQL官方归档](https://cdn.mysql.com/archives/mysql-8.4/mysql-8.4.8-winx64.zip)下载8.4.8 ZIP，仅准备mysql/mysqldump及运行依赖，未安装/初始化数据库服务。两程序版本实测8.4.8，Windows Authenticode均为Valid、签名者Oracle America；路径、SHA-256见[本地客户端回执](local-mysql-client-provision-20260908.json)。260MB临时ZIP已清理，客户端保留在工作区外层.tools。

新增local-backup-stream.mjs，使用Node内置AES-256-GCM对有界流加密；元数据包含随机IV、认证标签及明密文SHA-256，密钥由调用者另行保存。解密必须完整验证认证标签与摘要，成功后才返回可用文件；失败删除本次创建的未验证明文，已有文件拒绝覆盖。修复了初版FileHandle输出流无法结束的问题，改为显式串行写入、fsync与finally关闭；8项本地行为测试全部通过，覆盖二进制/中文、密文/密钥/标签/摘要损坏、大小上限、禁止覆盖及上游中断。

职责复核：不修改冻结Linux备份实现；新模块仅处理流和文件生命周期，Windows ACL、密钥保存、mysqldump退出状态、DDL锁及SQL作用域审查留给本地编排入口。异常复核：不能把未经认证的解密流直接接mysql；进程导出失败不能因流正常结束而算成功。后续必须同时检查子进程退出码与流结果，并先验证SQL作用域再导入独立恢复库。

当前只完成客户端与加密传输基础能力，尚未产生当前库备份或执行恢复。下一步实现本地私有目录/密钥与子进程编排，复用inspectBackupDatabase和inspectBackupSql，实际完成导出→校验→恢复→数据/结构对账。测试通过不代表备份可恢复性已通过。

## 8. Windows目录与客户端生命周期（第八十三批）

新增private-local-backup-directory.ps1：拒绝已有目录覆盖和任一祖先reparse point，创建后关闭ACL继承，仅当前SID及SYSTEM保留可继承FullControl，再独立核验owner和全部规则。实际Windows测试验证正常创建、重复创建拒绝、Everyone授权加入后拒绝、普通继承目录拒绝；临时目录均已删除。针对PowerShell7父进程调用Windows PowerShell5.1时的模块搜索路径冲突，显式从子进程PSHOME导入Security模块，未修改系统配置。

新增local-backup-process.mjs：shell=false、windowsHide、有限环境、静默丢弃provider stderr；同时等待stdin管道、stdout消费者和进程退出。任何环节失败或超时都会终止进程、关闭流，并等待实际结束后返回统一错误。不能因为导出stdout已结束就产生成功备份记录；消费者异常也不能让客户端继续运行。

18项定向测试通过：加密流8项、客户端进程8项、实际Windows ACL2项。进程测试覆盖正常stdin/stdout、输出完成后非零退出、stderr隐私、中断/超时、消费者失败、输入失败、启动失败和输出上限。源码语法与diff检查通过。

本批没有连接数据库，完整备份编排入口仍待接入上述两个工具、已准备客户端以及既有数据库/SQL审查器；DDL锁、当前库导出、独立恢复、完整对账尚未执行。不把工具测试当作备份可恢复证据。

## 9. 当前库真实导出与SQL审查缺口（第八十四批）

新增backup-current-dev-vue-local.mjs，接入私有目录、凭据临时文件、认证加密、进程退出码、数据库身份、备份DDL锁、源全表对账及隔离恢复流程。通过本地SSH隧道读取数据库，根凭据只从stdin接收，不进入argv或日志。目标限定新的dev_vue_m1_source_20260908_03；源库身份/版本及该目标不存在均已核验。

已实际完成当前库加密导出：683686779字节，位于D:/dev_codex/.backup-current-20260908-03/source.sql.enc；密钥位于独立私有目录。导出前后全表数据/DDL摘要与当前准备清单一致；解密认证成功。随后旧SQL作用域审查返回backup_sql_function_forbidden，流程停止于导入前。没有CREATE DATABASE，也没有恢复写入；根连接释放DDL锁，临时明文及客户端密码配置已清理。该备份尚未证明可恢复，失败产物保留，禁止重新导出掩盖审查失败。

只读DDL诊断确认13张表包含旧审查器不支持的函数：char_length、cast、concat、regexp_like、json_type。涉及经济日历、学习、钱包、宏观、策略订阅和设置表；这是当前规范化结构与旧审查器的兼容缺口，不放宽为任意函数。原审查器处于307项冻结工具集合，保持不改。下一步新增明确版本的审查器、列出实际需要的确定性内置函数并验证危险调用仍拒绝，再对现有加密备份认证/审查/恢复，不复用失败执行为成功proof。

63项既有备份与本地基础工具测试通过，当前导出提供真实依赖证据，SQL审查失败也如实保留。完整恢复流程未通过，不把代码中的后续CREATE/恢复/对账分支当作已执行。本次补充失败cause稳定码，避免后续只留下统一失败而无法定位。

## 10. 当前备份恢复通过（第八十五批）

新增独立v2 SQL审查器，保留冻结v1的全部扫描和拒绝规则，只增加当前DDL所需的cast、char_length、coalesce、concat、convert、json_contains_path、json_type、length、regexp_like、trim，并将NOT括号判为限定位置的一元语法。新版本复用30项既有安全回归并新增18项兼容/攻击拒绝测试；7组备份相关测试111项通过，309项冻结工具未改。新版与v1的实际源码差异仅版本标识、允许函数和NOT语法，未放宽INSERT、跨库引用、客户端命令或任意函数。

使用已有加密文件完成认证、全量SQL审查，并仅创建和导入dev_vue_m1_source_20260908_03一次，没有重新导出。初次原始DDL摘要比较失败，未重跑CREATE/导入。只读诊断发现6张表8处新增显式CHARACTER SET utf8mb4；原结构使用同一字符集的COLLATE utf8mb4_unicode_ci。

新增restore-ddl-equivalence仅接受已核验列元数据对应的这一个精确token差异，长度、默认值、collation、ENGINE或其它DDL变化仍拒绝，8项专项测试通过。随后独立只读进程完成源/恢复两库全表数据摘要、完整列元数据和DDL语义比较，见[成功回执](current-local-backup-restoration-20260908.json)：222表、271484行全部一致，源库与当前准备清单完全一致。回执明确byteIdenticalDdl=false，原始两套DDL摘要保留，没有伪造逐字一致或修改旧fingerprint算法。

职责复审：固定03失败备份的续接入口只认原加密产物、未开始CREATE的旧失败状态及不存在的目标；写前持久化create-attempt，已开始创建的运行不能重试导入。后置等价验证独立只读，不修改恢复库或源库来制造一致。兼容复审：保留首次SQL审查失败、首次严格DDL比较失败及最终语义通过三个证据；未知状态不变成重新创建/覆盖。

备份和密钥继续保存在本地独立私有目录，恢复库作为数据库验证产物保留在VM；临时SQL及客户端密码文件已清理。当前dev_vue依然147步且本批写入0。工作包B的本次备份可恢复性已通过，但写入窗口控制仍须在当前库实际回填前重验；下一步准备当前库执行manifest与写入者核对，再实施账户构建表回填和148–165增量步骤。后续执行器必须引用本次语义差异回执，不能将其冒充旧版要求的原始schemaSha256逐字相等证明。

## 11. 当前账户执行清单与源写入保护（第八十六批）

本地进程观察未发现命令行包含dev_vue的Node/Python/.NET进程；这不是所有写入者停写证明。新增account-source-freeze，以独立连接的REPEATABLE READ事务按稳定主键全范围FOR SHARE锁定users、trading_accounts、mt5_account_ownership_history、mt5_account_bindings和bridge_v3_terminal_sessions五张转换输入表。目标写入使用其它连接，保持源记录及空隙锁直到回填工作结束；每批须调用assertHeld检测事务是否仍在。范围锁释放与升级命名锁是不同职责，不以GET_LOCK代替数据库写入保护。

真实MySQL双连接探针证明：源UPDATE、已有表INSERT、空表INSERT均超时拒绝；构建表引用源users的FK写入成功；释放后源写入成功。随机临时库已核验删除，当前dev_vue写入0。另5项单元测试覆盖失败释放、事务丢失、释放后禁用、rollback失败销毁连接和缺少主键提前拒绝。见[真实探针](account-source-freeze-probe-20260908.json)。

当前库实际持有升级锁和五张源表范围锁后，用另一连接重新执行完整准备校验，结果与备份对应manifest完全一致。新[执行清单](current-account-wave-execution-plan-20260908.json)冻结两个runId、账户2批/4行、归属5批/274行、每批ID、UTC零偏移、目标身份及备份回执SHA；mirrorDatabase明确为已验证03恢复库，源/目标均为dev_vue，已通过既有validateSpec范围验证。没有写批次日志或构建表，applied=false。

职责复核：源锁仅覆盖实际五张转换输入表；其它保护表和旧迁移账本仍必须在执行前后对账，不把范围锁宣称为全库停写。并发/恢复复核：清单runId不可重新生成；执行入口必须重验锁、源摘要、保护表及既有回执，中断后沿原run/batch恢复。事务锁失效时不得启动新批次，已有已提交批次保留事实，不通过删除日志或回滚源库清场。下一步实现并执行这一固定清单的回填和最终投影验证。

## 12. 当前库账户回填完成（第八十七批）

新增执行入口和独立源重建/状态核对模块。入口验证执行manifest、备份回执及所有冻结工具，在升级锁与五张输入表范围锁内复用既有v2事务writer；先recover固定批次，只有not_committed才写入，unknown立即停止。四张构建表已有数据必须是期望投影的精确子集，额外行或字段冲突拒绝；过滤本次两个固定runId后，旧六张账本的完整行摘要必须与原快照一致。

实际当前dev_vue已回填：账户实体3、用户设置4、归属区间274、授权4。新增2个run、2个checkpoint、7个batch，以及各278条ID映射/行回执/源行证据。212张保护表全部行和DDL摘要不变，六张旧账本原记录保持。主键、字段、UTC精度、逐行来源/目标摘要、ID映射、最终游标与累计行数均已对账，见[完成回执](current-account-wave-applied-20260908.json)。

首次七批提交后，验收器把数据库生成列open_owner_account_id当成写入字段而失败；修正为只对比可写字段，生成表达式仍由147步结构协调器验证。随后修复checkpoint查询使用MySQL保留字cursor作别名的问题。两次均没有删除数据、改runId或重建批次；最终恢复执行七批全部replayed=true，没有重复业务写入，逐行对账通过。23项定向测试通过，包含新增生成列、异常目标行、旧账本缺失和保护数据变化的拒绝回归。

职责复核：源转换复用既有业务转换器；新模块仅负责当前库编排、恢复和对账。异常复核：应用后验证失败不等于事务未提交，以数据库回执为准；保留已提交事实并用同run/batch核对。源表和旧ID未删除，当前schema仍147步、222表，尚未执行035 RENAME或启用V4账户消费者。下一步准备当前库自己的账户根提升proof，执行148步，再串接149–165步骤。

## 13. 根表提升的 DDL 写入保护（第八十八批）

新增 `account-root-write-freeze`：专用 autocommit 连接核对目标身份和完整表清单，一次获取全部现有 InnoDB 表的 WRITE 锁；另一独立连接从 performance_schema 核验锁拥有者、表名和实际锁模式。升级命名锁仍由外层协调器持有。本工具不替代前后数据快照，也不阻止其它连接创建新表；每次 assertHeld 都重读完整表清单，遇到新增/缺失拒绝继续。

依据 [MySQL 8.4 RENAME TABLE 文档](https://dev.mysql.com/doc/refman/8.4/en/rename-table.html)，WRITE 锁可随多表原子重命名转移。真实双连接临时库验证 7 项：外部写受阻、日志 autocommit 后锁保留、重命名后锁转移、新旧表名写入均受阻、外键跟随新根表、提前 UNLOCK 被检测、释放后写入恢复。最终[回执](account-root-write-freeze-probe-20260908-v4.json)记录工具摘要和临时库已清理。当前 dev_vue 业务写入为 0，本批没有执行根表提升。

首轮探针发现持锁连接直接读取 performance_schema 会触发 ER_TABLE_NOT_LOCKED，改由独立观察连接核验。随后实测元数据锁的 duration 为 TRANSACTION，不能只接受 EXPLICIT；最终要求相同连接拥有 SHARED_NO_READ_WRITE，接受实测事务/显式两类时长，并用真实外部写超时验证其效果。前三次失败回执保留，不能替代最终成功证据。

8 项新增生命周期测试和既有根表协调器/适配器测试合计 29 项通过，覆盖失败释放、获取结果未知、释放失败销毁、锁丢失、弱锁、表集合变化、释放后禁用及观察连接隔离。范围复核：只冻结调用者提供并与实际一致的表集合，不授予新迁移 SQL 权限；恢复复核：未知 DDL 仍由既有 proof/日志/快照协调器判定，禁止自动重放。下一步将该保护与当前回填证据接入当前库专属 035 入口，验证完整协调器在持锁会话中的查询兼容性，再实际提升。

## 14. 当前 dev_vue 根表提升完成（第八十九批）

新增 `promote-current-account-root-local.mjs`，固定 dev_vue，分 prepare/inspect/apply；在同连接升级命名锁和全表 WRITE 锁下执行既有 035 协调器。prepare 重验当前147步结构、源输入、四张精确构建投影、212张保护表、6张旧账本，以及278条逐行回执/来源/映射与最终游标；没有重新创建回填 run 或写入业务数据。独立只读回执核验模块复用既有执行器的对账逻辑，新增11项行为测试拒绝错误归属、目标、来源、批次、数量和游标。

当前库专属[proof](current-account-root-proof-20260908.json)绑定当前完整表/行快照；[配套绑定](current-account-root-proof-20260908.json.current.json)固定当前回填清单、备份、最终锁探针及新入口/核验器摘要。旧协调器所需冻结工具清单继续保留；它引用的历史文件仅作为工具冻结输入，不能替代当前库数据证据。prepare 在持锁会话中调用完整协调器成功，证明本次所需结构、快照、回执和旧注册核验查询兼容 LOCK TABLES。

实际[应用回执](current-account-root-applied-20260908.json)为 applied、ddlCount=1，当前库由147到148步，222张表。旧trading_accounts改名为trading_accounts_legacy_v3（4行）；正式账户3行、设置4行、归属区间274行、授权4行。协调器按当前proof验证全表行摘要、重命名/外键后的DDL以及历史147步结构，再完成日志。随后[重复执行](current-account-root-repeat-20260908.json)返回completed、ddlCount=0，未重复DDL。proofHash为`6b2f763e36c3571d7e76c938401132a16b0fcb564554cb6d7391b27d47a70829`。

47项定向测试通过，覆盖回填保护、回执、DDL锁、根表协调器及MySQL适配器。职责复核：当前入口只准备/协调035，不直接执行任意SQL，不把恢复副本身份传给当前库；异常复核：输出路径执行前排他创建，proof与绑定fsync，已持久化proof不得重新生成覆盖；DDL结果未知沿同proof核对。此次未启用应用消费者，149–165及当前库K线回填仍待完成；下一步接续036终端绑定/连接会话增量表及后续协调器。

## 15. 当前终端路由表升级完成（第九十批）

当前dev_vue已从148升至150步、224表，新增terminal_account_bindings和bridge_connection_sessions，两表均为空；未从旧会话推断在线终端或复制过期路由。见[应用回执](current-terminal-route-applied-20260908.json)及[重复执行回执](current-terminal-route-repeat-20260908.json)：首次DDL2次，重复DDL0次，两个步骤均completed；原222表完整数据/结构与原148步日志一致。

新增当前库专属入口 `upgrade-current-terminal-route-local.mjs`，使用当前根表proof和绑定摘要，prepare检查当前父键类型，并在唯一空参考库执行原036 SQL、读取真实SHOW CREATE，再删除和确认参考库不存在。当前源快照与日志前后相等后，固化[036 proof](current-terminal-route-proof-20260908.json)及[工具/参考绑定](current-terminal-route-proof-20260908.json.current.json)。执行仅调用既有登记协调器，逐步骤验证状态和完整规范结构；输出在动作前排他创建，proof/绑定fsync，未知结果继续沿同proof核对。

锁方案定向复核：MySQL禁止持有LOCK TABLES时CREATE TABLE，见[官方说明](https://dev.mysql.com/doc/refman/8.4/en/lock-tables.html)。本批尝试独立RR行/间隙冻结，真实临时库发现外键CREATE同样被父表事务锁阻塞，见[失败探针](inplace-create-source-freeze-probe-20260908.json)，临时库已清理；未保留不适用的工具实现。036是纯新增空表，不改写旧业务行，采用现有命名锁、每步前开发库其它连接检查、严格旧数据前后对账和逐步日志恢复；这属于观察与变更范围约束，不宣称全库停写锁。检测到其它连接或对账变化即停止，不恢复旧备份覆盖新数据。

29项Vitest协调器/适配器测试与1项Node原生注册表测试通过。注册表文件最初误用Vitest导致“No test suite found”，改用其实际node:test运行器后通过，未修改冻结测试或SQL。当前应用消费者仍未启用；下一步151–154观摩/上下文表，再接155–165及K线回填。

## 16. 当前观摩与交易上下文表升级完成（第九十一批）

当前dev_vue从150升至154步、228表，新增observer_sources、observer_channels、observer_channel_accesses和trading_contexts，均为空。首次DDL4次，随后沿同proof重复执行DDL0次；原224表的完整行/结构与原150步日志一致。见[应用回执](current-observer-context-applied-20260908.json)及[重复回执](current-observer-context-repeat-20260908.json)。未把旧观摩状态自动激活，也未启用应用消费者。

新增当前库入口和版本化MySQL适配器。旧适配器固定引用恢复副本reference，不能直接用于当前库，因此保留其冻结版本，当前版绑定[当前reference](current-observer-context-reference-20260908.json)，把自身及入口摘要纳入268项proof工具清单，并再次验证reference正文摘要、库身份、父proof及清理标记。当前版12项适配器测试包括拒绝另一数据库的重签reference、拒绝保留旧摘要的正文篡改。

prepare在当前MySQL版本下建立唯一临时参考库，核对父键类型，执行原037 SQL并读取规范DDL；复用既有约束探针，18项真实检查通过，包括默认禁用/待配置状态、外键、默认频道唯一性、布尔值、模式与账户/观摩字段组合。探针事务回滚后7张参考表均为空，参考库删除并确认不存在，当前库前后数据/日志对账通过，再固化[当前proof](current-observer-context-proof-20260908.json)及[配套绑定](current-observer-context-proof-20260908.json.current.json)。

33项定向测试通过（29项Vitest、4项Node原生），另有上述18项真实MySQL约束检查。首次混用运行器导致原生测试文件被Vitest报告无suite，按文件实际导入的node:test单独运行后通过；未更改旧测试。职责复核：新版本只调整当前reference与工具绑定，原037 SQL、状态协调及既有适配器不改；异常复核：逐步重验、其它客户端观察、旧数据严格对账及未知状态核对继续有效。下一步155–160账户/行情投影表，再做161–165与当前K线回填。

## 17. 当前账户与行情投影表升级完成（第九十二批）

当前dev_vue已从154到160步、234表。新增account_runtime_snapshots、market_quotes、open_position_snapshots、pending_order_snapshots、trading_projection_revisions、trading_projection_provenance_v4，六表均为空；没有把旧终端快照或时区推断为可信实时事实。首次DDL6次，沿同proof重复执行DDL0次，原228表完整行/结构及旧154步日志一致。见[应用回执](current-account-projection-applied-20260908.json)和[重复回执](current-account-projection-repeat-20260908.json)。

当前专属入口接续当前根表、终端路由和观摩proof链；新增版本化投影适配器，使用当前观摩适配器与[当前reference](current-account-projection-reference-20260908.json)，原执行版本及038 SQL保持不变。prepare检查四张父表主键类型，在唯一临时参考库执行原SQL和20项约束测试；覆盖DECIMAL精度/溢出、UTC毫秒、账户隔离、默认权限及来源外键。探针回滚后10张参考表全部为空，参考库删除并核验不存在，源库快照/日志前后相等后固化[proof](current-account-projection-proof-20260908.json)及[配套绑定](current-account-projection-proof-20260908.json.current.json)。

35项定向测试通过（12项当前适配器、18项协调器、5项Node注册/参考探针测试），包含拒绝其它数据库reference、正文篡改、旧数据变化、错误schema和未知状态恢复；另20项真实MySQL约束检查通过。309项原冻结工具、278项投影proof工具及10项当前绑定工具摘要已核对一致。

职责复核：六表只承载可重建投影，历史K线保留/映射/提升仍由039–040独立协议完成；本批未写入市场或账户实时状态。异常复核：仍按每步前客户端观察、登记协调器和严格前后对账执行，观察不等于数据库停写锁；结果未知保留同proof，不重建历史或恢复旧备份覆盖数据。下一步161–163构建表、当前历史K线回填与164提升，再执行165上下文回执表，之后做应用真实联合验收。

## 18. 当前 K 线构建表与转换清单就绪（第九十三批）

当前dev_vue由160升至163步、237表，新增legacy_candle_backfill_v4、market_candles_build_v4、legacy_candle_mappings_v4，均为空。首次DDL3次，重复执行DDL0次；原234张表的完整行/结构及旧160步日志一致。见[应用回执](current-legacy-candle-build-applied-20260908.json)、[重复回执](current-legacy-candle-build-repeat-20260908.json)。

新增当前库专属构建入口与版本化适配器，接续当前投影/观摩/终端/根表proof链，旧版本与039 SQL保持冻结。唯一临时参考库验证20项真实约束，包含超过JavaScript安全整数范围的旧ID、多个来源映射到同一目标、DECIMAL和UTC毫秒、回填计数上限、删除保护及重命名后的来源/目标外键。保留[当前reference](current-legacy-candle-build-reference-20260908.json)中的提升后DDL及外键证据，参考库清理并确认不存在；[proof](current-legacy-candle-build-proof-20260908.json)和[绑定](current-legacy-candle-build-proof-20260908.json.current.json)已固化。

另外新增当前库只读转换入口，使用当前账户准备清单的mappingHash、已冻结旧K线写入器摘要、完整163步结构和当前构建proof；复用既有有界分页源读取与转换器。实测35725条原始K线→30226条目标投影，5499条同键同值重复来源保留各自ID映射，不删除原记录；转换planHash为`ad02ff50e68a322d1c572a2b8276e15aeadfe6ef77a4c532590892541d5b3933`。历史epoch时间按UTC保留，timeOffsetMinutes=0。见[当前转换清单](current-legacy-candle-conversion-20260908.json)，源库前后完整快照与日志一致，转换阶段业务写入0。

构建部分35项定向测试通过，转换/分页读取22项测试通过，另20项真实MySQL约束验证通过。309项旧冻结工具、288项构建proof工具和12项当前绑定工具摘要一致。职责复核：构建/转换就绪不等于实际回填，不把旧副本转换报告当作当前输入；异常复核：未知结果沿原proof核对，后续每批必须重新核验源范围和来源计划，结果未知不得另建回填身份。下一步根据本次当前转换清单准备回填proof，完成实际回填/恢复对账，再执行164提升与165上下文回执表。

## 19. 当前历史 K 线回填完成（第九十四批）

新增当前库回填入口和版本化proof绑定，复用冻结的有界转换器、事务写入器和断点协议。绑定当前163步结构、当前账户映射、旧写入器摘要和当前转换清单，298项工具/输入摘要核验一致；不修改已执行SQL或旧副本工具。见[执行proof](current-legacy-candle-backfill-proof-20260908.json)和[准备回执](current-legacy-candle-backfill-prepare-20260908.json)。

实际回填72批，每批最多500条：legacy_candle_mappings_v4为35725行，market_candles_build_v4为30226行，账本单行为verified，lastLegacyId为3530414。5499条同键同值重复来源仅合并目标投影，原market_candles所有35725行和旧ID保留；UTC epoch原值转换、不加时区偏移。234张受保护原表的完整行/结构和163步历史日志前后相等。见[应用回执](current-legacy-candle-backfill-applied-20260908.json)。

沿同proof再次执行apply，完整内容对账通过，新增批次0、verificationCommitted=false、currentDevVueWritten=false，三张回填区域表摘要与首次结果一致。见[重复回执](current-legacy-candle-backfill-repeat-20260908.json)。本次未注入提交丢失；提交未知和断点协议的26项定向测试通过，另对真实proof检查298项摘要唯一且一致，并验证身份、转换、源计划、原表快照、历史日志五类绑定篡改均被拒绝。真实重复执行证明已完成断点恢复读取和无重复写入，不代替故障注入证据。

职责复核：本批只回填三个构建区域表，schema仍163步、237表，未切换应用消费者。异常复核：写入事务重读并共享锁定来源范围，比较完整目标前缀、CAS推进断点；提交未知停止并沿同proof核对，不创建新回填身份；回执单独记录验证状态提交，避免最后验证单独写入时误报零写入。下一步绑定本次当前回填重复回执完成164原子提升和165上下文回执表，再验证本地应用/API/浏览器账户流程。

## 20. 当前 K 线原子提升完成（第九十五批）

当前dev_vue由163升至164步，仍237表。原market_candles重命名为market_candles_legacy_v3，market_candles_build_v4提升为market_candles；单条原子RENAME保持35725行旧K线、30226行正式K线、35725行ID映射和单行verified账本。提升后的目标/映射schema与当前参考库已验证的DDL一致，来源外键指向legacy表、目标外键指向正式表，逐表行数及内容摘要符合冻结的前后映射。

新增当前版本适配器和专属入口，原040 SQL、状态协调器及已执行旧工具保持不变。prepare绑定当前库零写入重复回填回执、当前账户/终端/观摩/投影/构建proof链、全237表快照、311项工具/输入摘要。拒绝旧副本身份、只读检查代替重复apply、未完成回填以及非零写入回执。执行proof见[当前提升凭据](current-legacy-candle-promotion-proof-20260908.json)，prepare实际DDL为0。

复用经真实探针验证的全表WRITE隔离：同一连接持有升级锁并执行日志与RENAME，独立观察连接检查每张表的锁拥有者及SHARED_NO_READ_WRITE；提升后按新表名继续检查，释放锁前完成全量快照/历史验证。首次DDL1次；沿同proof重复apply为completed、DDL0次、currentDevVueWritten=false，完整快照摘要和旧163步日志摘要一致。见[应用回执](current-legacy-candle-promotion-applied-20260908.json)和[重复回执](current-legacy-candle-promotion-repeat-20260908.json)。

42项定向测试通过：当前适配器9项、提升协调13项、历史兼容12项、写入隔离8项。覆盖凭据身份、来源/目标内容变化、未知DDL与历史状态恢复、危险SQL拒绝、锁丢失和释放失败；本批没有在当前库注入DDL丢失。311项摘要已核对唯一且一致。

职责复核：本批仅提升已完整回填的K线，未创建新行情或启用运行消费者；旧记录和迁移证据永久保留。异常复核：提升未知沿同proof确认真实表名及日志状态，不重跑回填、不重建proof、不恢复旧备份覆盖新增数据。下一步使用当前164步证明创建165上下文回执表；之后完成本地服务/API和浏览器账户流程验收。

## 21. 当前上下文回执表升级完成（第九十六批）

当前dev_vue从164升至165步、237增至238表，新增trading_context_changes_v4为空。当前专属适配器与入口接续当前K线提升proof链；041 SQL、原协调器和已执行旧适配器均保持不变。当前proof绑定321项工具/输入摘要、237表快照和完整164步日志，见[proof](current-context-changes-proof-20260908.json)。

在当前MySQL实例重新运行既有临时参考探针，13项真实约束检查通过并删除参考库：UTC毫秒、用户/请求唯一键、结果版本唯一键、用户外键、版本跳跃/上限、目标与结果作用域一致性、观摩只读以及回执事务回滚。见[当前参考结果](current-context-receipt-schema-reference-20260908.json)。prepare再核验实际users.id为INT主键且不可空、MySQL版本相同，前后原表/日志快照一致后固化凭据；没有把参考库测试当作实际上下文权限或并发证明。

首次执行DDL1次、日志写入2次；沿同proof重复apply为completed、DDL0次、日志写入0次，新表schema匹配且0行。原237表完整数据与结构及旧164步日志对账一致。见[应用回执](current-context-changes-applied-20260908.json)和[重复回执](current-context-changes-repeat-20260908.json)。每次写入前检查其它当前库客户端，持有同连接升级命名锁；客户端观察不等于数据库全局停写隔离，本次仅追加空表。

19项定向测试通过（当前适配器7、协调器8、历史连接3、原生注册1），涵盖当前身份、旧副本拒绝、参考未清理/发生既有库写入、错误版本、来源摘要和历史状态异常；321项工具摘要唯一且一致。职责复核：回执表存储幂等请求结果，不以历史回执替代当前权限与账户事实。异常复核：未知DDL/日志沿原proof对账，重复已完成升级不写表或日志；不改旧迁移、不覆盖历史、不启用运行消费者。

当前账户根/K线/上下文的147–165专属升级链已完成，下一步是应用就绪核验与账户真实API/浏览器联合验收。全域数据所有权、其它业务迁移、服务端110条存量边界债务和前端扫描盲点仍属于后续全栈方案，不因本批升级完成而关闭。
