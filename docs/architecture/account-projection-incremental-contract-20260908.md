# 账户与行情投影增量合同

账户样板在154步后仍缺账户/行情/持仓投影及可信来源。038追加六张无同名冲突的表，定义总步骤160；旧market_candles保留并作为独立数据转换包处理。本合同不表示当前库已升级或账户链路已通过。

## 六表结构与写入归属

| 顺序 | 表 | 用途及前置条件 |
| --- | --- | --- |
| 155 | account_runtime_snapshots | 账户资金、权限、时钟投影；FK正式trading_accounts |
| 156 | market_quotes | 账户/品种报价；FK正式trading_accounts |
| 157 | open_position_snapshots | 账户/ticket持仓集合；FK正式trading_accounts |
| 158 | pending_order_snapshots | 账户/ticket挂单集合；FK正式trading_accounts |
| 159 | trading_projection_revisions | 账户/资源kind/id单调版本；FK正式trading_accounts |
| 160 | trading_projection_provenance_v4 | 账户指标、持仓及挂单的可信来源；FK revisions、users、ownership_intervals、terminal_profiles |

沿用003及020最终SQL语义，只移除新表CREATE的IF NOT EXISTS，不改已执行源迁移。金额保持DECIMAL、payload保持JSON、时刻保持DATETIME(3) UTC，来源主体/归属区间/档案/实例/epoch/revision完整保存。

实际投影写入归trading基础设施mysql-trading-repository：先验证owner、绑定、活跃会话及路由，锁定资源revision，再在同事务写投影及来源；持仓/挂单同时处理精确交易状态与预留吸收。replaceCollection的动态表名仅允许两个静态字面量。Bridge通过公开投影能力提交数据，其它业务域不能直接维护第二份投影。

风险、推理、执行、观摩等当前仍存在跨域SQL读取；这是后续公开查询端口/read-model收口项，不因建表而视为模块化完成。不能拆开revision、投影、来源、精确状态和预留吸收的原子提交，也不能为了通过FK关闭校验。

## 初始事实与时间

六表初始为空，不把旧余额、旧连接、历史持仓或V3心跳复制为V4可信投影。缺少来源或revision时沿用已有失败关闭，不把空集合当作“已证明无仓位”。初次有效Bridge快照经过所有权、档案、实例、epoch和revision校验后建立投影；旧历史证据及原始数据继续保留。

timezone_offset_minutes和clock_status沿用服务端可信时钟流程；UTC+3只是指定的展示默认，不能用来填充calibrated或解除执行限制。历史UTC原值不平移，前端实验室显示终端时间、其它页面显示北京时间。

## 旧market_candles的独立迁移

最近恢复副本冻结计划记录market_candles有35,725行、market_data_sources有3行；这是副本证据，当前库数据量执行前重查。旧表有id、source_id、broker_symbol、standard_symbol、open_time_utc_msc、broker_time、spread等；旧唯一键为(source_id,broker_symbol,timeframe,open_time_utc_msc)。V4要求(trading_account_id,symbol,timeframe,open_time_utc)，并有closed和revision，不能给旧行填默认账户ID或直接以CREATE IF NOT EXISTS跳过。

下一数据包必须完成：

1. 冻结目标身份、旧两表schema/行摘要和全部读写引用；旧platform-market-data、period-market-evidence、period-review、review-market-path等消费者必须明确保留/停用/迁移状态，改名后不能仍将新表当旧表使用。
2. 逐source建立账户映射：结合broker_server/account_login、平台身份、账户根映射及主体归属，拒绝只按login或source_id推断。多账户歧义或无映射行保留原表，并记录明确处置，不静默丢弃。
3. 建立独立V4构建表并按旧主键有界回填，保留legacy行映射。品种取值需匹配V4查询语义，不能在broker_symbol和standard_symbol之间未经验证择一；检查合并后同账户/品种/周期/时刻冲突。时间将已有UTC毫秒精确转为DATETIME(3)，不加减时区。
4. closed、revision的初始化必须有明确合同：审计旧写入路径与收线依据，不仅因时间在过去就标closed；旧数据不能伪造当前Bridge来源或会话epoch。原始broker_time/spread等V4不直接消费字段留在旧表，不能以字段缩减为理由丢掉原事实。
5. 逐键价格/量/时间、行映射和冲突对账后，使用独立登记的提升步骤保留旧表并接管V4正式名称。原154/160步的完整表集合及历史结构检查需要明确的改名验证适配，不能放宽为忽略任意表名/日志。原已执行checksum不重写。
6. 测试中断回填、响应未知、冲突拒绝和重入；旧/新读结果对账后切换唯一运行写入口。新写入后的恢复保留增量事实，不逆向DROP新表或覆盖旧备份。

这不是延后保留数据要求：旧表暂时保持原样，038不处理它，K线迁移及对应图表验收继续是账户样板的必需项。

## 执行与验收

038注册先保持154步完整对象，新增六项独立checksum；随后在参考MySQL验证父键、精确数值/JSON、revision/provenance复合外键及资源kind CHECK。新适配器和协调器绑定规范DDL、完整工具、154步完成证据与旧表快照，再演练154→160、未知响应及零DDL重入。参考库成功不替代恢复副本或当前库升级。

六表完成后仍需检查Bridge凭据、额度、精确状态/预留、行情合约及持仓历史等依赖；以实际查询和用例验证结果判定就绪，不仅统计表数量。

## 两轮复核

第一轮（需求、职责）：核对实际写入函数及只读消费者，保留六表同事务关系和唯一写入口；将同名K线表单列为需要数据映射/提升的包，避免用空表或默认账户绕过历史保留。保持当前公开API和SQL语义，不新增冗余缓存或通用投影框架。

第二轮（兼容、并发与异常）：核对原154步不可变、六表外键顺序、UTC/精度、来源/会话/revision绑定及空初态；旧K线合并冲突、closed证据、旧消费者和提升后历史校验仍需实际审计。当前只是结构定义和合同，未执行038或K线迁移。

## 第五十五批验证结果

[真实参考证据](account-projection-reference-20260908.json)已记录六表规范SHOW CREATE及20项MySQL检查：金额/报价精度、UTC毫秒、权限默认值、跨账户键、JSON/ticket、溢出/非法JSON拒绝，以及provenance复合FK、主体/区间/档案FK和kind CHECK。四个最小父键逐项匹配恢复副本，测试事务回滚后十张表均空，参考库已删除；恢复副本结构/行摘要和154条历史前后不变。它不证明会话epoch或projection_revision一致性由数据库自行强制，这些仍归应用事务校验。

[旧K线候选调查](legacy-candle-mapping-probe-20260908-v2.json)在恢复副本只读一致性事务内执行：35,725行、3个来源，无孤立source、空标准品种或不支持周期。按规范化server/login比较，三来源各有一个账户候选，历史owner也各匹配一个；该批尚未证明平台身份和采集主体映射，因此不是已批准回填映射。第五十八批修正归属判据：历史行情可能早于开户形成，不要求逐K线开盘时已持有账户；交易记录仍遵守历史归属区间。

按候选账户、二进制标准品种、周期、UTC毫秒键分组发现5,499组跨来源重复，涉及10,998行；这些组的OHLC及tick_volume全部一致，未发现这些字段的冲突。若后续确认该账户/品种映射，可通过多旧行→同一新键的映射保留来源，而不是由upsert顺序决定结果；不能据此丢掉原broker_time、spread等未比较字段。closed来源和revision初始化、旧消费者处理、构建表与提升校验继续待做。

本轮两项复核：职责上保持参考采集与只读旧数据调查独立，候选统计不改变业务授权；异常上覆盖目标库限制和fixture失败回滚，并将候选重复键与内容分歧分开报告。5项本地注册/助手限制测试通过。恢复副本仍未执行038，当前dev_vue未写入。

## 第五十六批执行协调

account-projection-coordinator.mjs已实现六步离线协调：验证完整160步历史及六表状态后，只剔除精确核验的新增表，把原154条日志及原表快照交给观摩协调器默认只读验证；观摩→终端→账户根三层检查继续执行。没有修改任何旧冻结脚本、允许集合或历史checksum。

适配器契约为verifyPlan/history/tableState/verifyProtected/begin/execute/complete及原154步priorStore。MySQL适配必须在同连接锁下检查冻结计划、完整规范DDL、未完成时旧行摘要和完成后旧结构。新协调器执行前后完整复核，started/DDL/completed未知响应立即退出；无日志同名表、未完成表有数据、完成但缺表或漂移均拒绝。

18项新测试直接调用三层原协调代码，底层存储使用替身；覆盖六步顺序、三类响应未知恢复、历史层缺表/漂移/legacy变化、陌生表、DDL期间旧行变化、默认只读和完成后普通业务行。合计67项协调测试通过。此结果不代表154→160实际MySQL演练；下一步为MySQL适配器、持久化计划与固定副本执行入口。

## 第五十七批MySQL适配

mysql-account-projection-migration.mjs通过原观摩适配器复用同连接身份/锁和三层历史；新计划绑定原154步proof、六表参考证据、160步注册摘要、旧228表快照及全部工具清单。准备时核对MySQL版本、20项约束结果和采集/助手hash，文件独占创建并fsync。

rehearse-account-projection-migration-local.mjs仅支持固定恢复副本，提供准备、只读、执行和DDL响应丢失模拟。每次结果额外比较原228表完整快照、原154条日志摘要和新增表0行。适配器10项测试与各历史层共101项通过；实际运行结果见逐批进度及account-projection-registered系列回执，当前dev_vue执行仍须独立准备。

恢复副本实际160步已完成：首次创建账户快照后模拟响应丢失，只读识别reconcile/pending，恢复仅执行剩余五条DDL，再次执行零DDL，六表0行；每次旧228表快照及154条历史摘要一致。[再次执行回执](account-projection-registered-repeat-20260908.json)保留该证据。

重新构建服务端后，[恢复副本账户读取探针](account-readiness-restored-probe-20260908.json)捕获14条SELECT，12条EXPLAIN通过；symbols的UNION和candles两条均因旧market_candles缺symbol/trading_account_id阻止。此探针只覆盖空结果路径，不验证非空投影/来源、授权、事务、Bridge或浏览器。剩余已观察结构缺口集中于旧K线表，不表示未访问分支已经就绪。

## 第五十八批：旧K线转换合同与只读演练

新增纯转换器legacy-candle-conversion.mjs和固定恢复副本只读入口。来源映射重建旧账户、terminal session及binding证据，要求与已审查账户mappingHash一致，再按server/login唯一候选核对平台和采集主体对应的旧账户设置。缺平台、主体无映射或多平台歧义均拒绝。采集主体不是K线开盘时的账户所有权事件，此转换不增加任何历史访问授权。

转换规则固定为：保留stored standard_symbol的二进制含义；UTC毫秒原值转ISO，不平移；价格DECIMAL(24,10)、量DECIMAL(24,8)保持精确文本；revision初始化1。closed采用legacy-closed-writer/v1，绑定server/routes/ai/platform-market-data.js的SHA-256：257处splitRatesByClosure排除未收线尾柱，772处persistClosedCandles只接收closedRates；普通、精确区间及fallback写入经相同闭合窗口入口。该政策是迁移时继承旧存储语义，不证明每条历史行由当前文件版本写入，也不赋予实时Bridge来源、会话epoch或执行时钟可信度。

新键为账户/标准品种/周期/UTC时刻。相同键只有OHLC、量及目标字段全部一致才能合并；代表行取数值最小legacy ID，不依赖输入顺序。每条旧行保留legacy ID、source ID、目标键和payload/source摘要；旧表保留broker_symbol、broker_time、spread、updated_at等完整原事实。任一冲突或精度不可表示立即失败，不能通过upsert覆盖。

[实际只读演练](legacy-candle-conversion-rehearsal-20260908-v4.json)先验证恢复副本完整160步，再在只读一致性事务内每页500行、最多100000行读取。35725行全部转换，30226个目标键，5499行重复，转换planHash为ad02ff50e68a322d1c572a2b8276e15aeadfe6ef77a4c532590892541d5b3933。前后全表快照和迁移日志摘要一致；数据库写入0。报告绑定转换器/采集脚本和旧writer摘要，未把全部账户登录信息或价格明细写入报告。

真实演练暴露并修正分页缺陷：ORDER BY id解析到CAST后的字符别名，仅读18132行即被总数检查拒绝；改为ORDER BY market_candles.id后完整读取35725行。失败发生在纯读取阶段，没有接受部分转换。18项行为测试覆盖重复冲突、确定性代表行、超大ID、二进制品种、UTC毫秒、DECIMAL溢出及来源拒绝；语法和差异检查通过。

第一轮复核：来源主体和历史交易所有权分开，标准品种不重新猜测，重复行保持可追溯，不新增授权或实时事实。第二轮复核：核实数值游标、全量计数、只读事务、完整旧历史检查、输入上限和前后摘要；旧文件checksum不修改。尚需实现构建表、持久化逐行映射/检查点、实际回填对账、正式名称提升及历史验证适配，当前dev_vue升级和账户全栈验收仍未完成。

## 第五十九批：K线构建表与有界回填协议

追加039三表并独立登记161–163步，原160步对象与checksum不变；本批仅定义，尚未执行DDL。market_candles_build_v4与003正式K线SQL完全一致，仅替换临时表名。legacy_candle_backfill_v4以id=1保留唯一转换计划、源/映射/投影摘要、预计/已写数量、最后legacy ID及filling/verified状态；CHECK限制数量关系和提前verified。legacy_candle_mappings_v4每个legacy ID一行，通过外键指向计划、旧K线、原source和目标复合键；不设目标唯一约束，从而保留多旧行→同一投影。

legacy-candle-backfill.mjs实现纯协调协议，默认只读。进入时校验转换summary/数组摘要、逐legacy数值顺序、目标payload/key摘要及最小代表ID；适配器必须另外用冻结源数据重建转换计划、验证目标身份和完整历史，不能把自洽hash视为批准依据。读取构建区全部有界内容，核对检查点对应的精确前缀及所有目标值，不能只凭行数或last ID跳过旧批次。

每批最多500条旧映射。MySQL适配器须在一个短事务中锁定单例检查点，对比期望计划/前缀，插入或精确比较已有投影、插入所有legacy映射并推进检查点。跨批重复键只有payload一致时共享投影，禁止无条件更新。确认未知立即退出，下一进程读取真实前缀；最终全量核对后单独原子标verified，丢失确认后不得再次回填。全部旧行、旧source与原始字段保留。正式名称提升仍是后续独立步骤，其双表改名和FK引用变化必须用真实MySQL验证，再做旧历史校验适配。

2项注册/目标SQL语义检查通过；8项回填行为测试与18项转换测试共26项通过，覆盖跨批重复键、超安全整数ID、提交前/后失败、verified确认丢失、内容漂移、前缀缺口、外来计划、无检查点孤立行、源变化、空输入及批量限制。这些使用内存适配器，不是真实事务、约束或163步执行证据。

第一轮复核：三张表分离业务目标、legacy保全与迁移进度，保留同一事务和唯一检查点；不把构建区接入运行读取，不改旧writer。第二轮复核：确认全部内容前缀对账、未知结果不自动重放、旧160步完整保留和重复行非丢弃；FK必须在表名提升后继续绑定正确原表和新表。下一步用独立参考MySQL验证规范DDL/CHECK/FK，再补齐163步协调器、持久化证据和MySQL回填适配器。当前库未升级，尚不能宣称K线迁移完成。

## 第六十批：真实构建约束与双表改名验证

新增capture-legacy-candle-reference-local.mjs及独立约束助手。先验证恢复副本160步完整历史和父键类型，在随机独占参考库仅建立3个最小父表及039三表，不复制业务数据。采集真实SHOW CREATE，分别绑定SQL和规范schema摘要。

[真实参考回执](legacy-candle-build-reference-20260908.json)记录20项全部通过：UTC毫秒/DECIMAL边界精度、超安全整数legacy ID、两旧行共享投影、单例检查点、数量越界及提前verified拒绝、旧行/source/run/目标复合FK、删除限制、价格溢出、二进制品种和账户键。CHECK只限制行内数量关系，不替代应用的实际行数/摘要核对；最小父表只证明所需ID类型兼容，不证明完整来源主体或旧行source_id归属。

另用显式提交的合成fixture执行原子RENAME：market_candles→market_candles_legacy_v3，market_candles_build_v4→market_candles。information_schema证实映射的原始行FK指向legacy表，四列目标FK指向新正式表；原始行和新投影删除均被拒绝，两条映射JOIN仍有2行。保留改名前规范定义、改名后定义及FK清单，不能把参考父表DDL当作真实旧market_candles的规范DDL。

普通约束fixture事务回滚；改名fixture按子表到父表的固定顺序删除，确认参考库6张表均0行、恢复副本全表快照与160条历史不变后删除独占参考库。proofHash=8cf22f903708e8f3a9a69f16f88249f95160f138a446036ad8962f76e58b789b。4项本地注册/参考边界检查、语法与差异检查通过。数据库连接和SSH隧道关闭，当前dev_vue没有写入，恢复副本未执行039。

第一轮复核保持参考库与业务源隔离、精确目标结构和多源映射；第二轮区分DDL隐式提交与DML回滚，明确仅清理本次创建且已验证空的参考库，证明改名后的外键指向但不据此跳过正式历史校验。下一步实现163步协调器及持久化计划、MySQL回填适配，正式源/目标/映射全量核对后再执行提升。

## 第六十一批实施前复核

039正式协调器逐项验证完整163步历史、三张新表规范结构和表/日志状态，仅从旧快照移除已精确验证的本批新表；随后调用原160步协调器只读验证，继续沿投影→观摩→终端→账户根检查。持久化计划绑定原160步完成proof、参考MySQL规范DDL、旧表快照和全部工具摘要，独占创建并fsync。MySQL适配每次写日志或DDL前核对同连接身份/锁和冻结工具，响应未知停止并交给下一进程读取实际状态。

第一轮复核：三表仅构建区，不改变运行读写或旧K线；不通过重写旧冻结文件实现兼容，数据回填仍使用独立事务协议。第二轮复核：覆盖begin/DDL/complete确认丢失、无日志同名表、缺表、旧历史漂移和建表期间旧行变化；恢复时不重复已执行DDL。恢复副本实际演练范围为160→163及零DDL重入，保留新增表和日志，当前dev_vue不写入。完成建表不代表回填或提升完成。

## 第六十一批实际演练结果

19项新增协调测试与10项MySQL适配测试通过，连同相关四层历史协调/适配共117项通过。测试覆盖旧投影/观摩/终端缺失、账户legacy行变化、无日志表、未知历史、三处响应丢失、建表中旧行变化和已完成构建表接收数据；旧阶段begin/execute/complete均未调用。

恢复库dev_vue_m1_source_20260907_02实际完成160→163。冻结计划绑定282项工具、旧234表快照、原160步proof和规范参考证据，proofHash=0ee8913abb31631524306a3504d6ce283a54290e67a1944906c3a53aca37f4db，见[计划](legacy-candle-build-registered-plan-20260908.json)及同前缀prepare/lost-ddl/inspect-unknown/reconcile/repeat回执。首张legacy_candle_backfill_v4建成后模拟响应丢失，下一只读进程识别reconcile及两项pending；恢复补记首步，只执行剩余2条DDL。独立重入ddlCount=0，三步均completed。

各回执均额外核对原234表完整快照与原160条日志摘要，全部一致，三张新表均0行；规范结构由协调器校验。旧冻结源/迁移不修改，新增表和日志保留。当前dev_vue未执行本批升级，数据库连接与SSH隧道已关闭。实际回填、逐行对账、名称提升及当前库专属升级仍待实施；下一批接入MySQL回填事务与提交未知恢复。

## 第六十二批：MySQL回填事务适配

新增mysql-legacy-candle-source.mjs，按已审查账户mappingHash重建来源，并检查正式V4目标ID对应的平台/server/login/currency未漂移。每页500条数值主键游标、最多100000条旧K线，逐行验证游标前进与总数一致。锁定模式要求REPEATABLE-READ，账户/终端/binding/source/目标身份使用FOR SHARE，旧K线强制PRIMARY范围读取并包含末页空范围，防止事务内来源变化；调用者拥有事务，助手不自行提交。

新增mysql-legacy-candle-backfill.mjs。强制注入同连接身份/升级锁/工具与结构检查，以及重新读取实际来源的校验器；自洽planHash不能替代已批准源证据。适配器保留独立计划副本，拒绝变更后的候选计划。readState在只读一致性事务内读取有界完整构建区，核对run元数据及每条映射的实际复合键，供协调器比较完整前缀。

applyBatch先核对批次与批准计划的精确切片，然后在同一事务中锁定检查点、共享锁复核源转换，批量锁定已有目标键并精确比较payload；只插入缺失投影，插入全部legacy映射，最后CAS推进计数/游标。检查点缺失但构建区非空拒绝；不使用覆盖式upsert。提交前再次检查连接身份/锁。任何失败回滚并退出，提交确认丢失时不能假定rollback撤回已提交结果，交由下一次完整readState判定。

markVerified在同一事务内锁定检查点和来源，再锁定并逐值核对完整映射/投影，不能仅凭计数标完成。数据库CHECK只作行内约束，应用负责来源重建、源键一致、计划内容与实际行的完整核对。

新增8项适配器行为和4项源读取测试，与既有转换/协调共38项通过。涵盖映射插入失败/CAS失败整批回滚、commit已成功但确认丢失后的接续、锁丢失、源变化、metadata/payload漂移、空输入、数值游标与实际目标身份变化。适配器测试使用SQL替身，尚未证明真实事务隔离、范围锁或实际35725行写入；本批未连接数据库。

第一轮复核保留来源、业务目标和迁移进度分工及单批原子性，增加V4目标身份一致检查。第二轮复核覆盖检查点缺失、重复投影、全量最终核对、源范围锁、超大ID和未知提交；每批全源复核成本需真实演练测量，不以降低数据完整性检查换取速度。下一步实现固定恢复副本持久化计划/执行入口，完成真实回填与提交未知恢复，再接名称提升。
