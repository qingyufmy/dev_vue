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

[旧K线候选调查](legacy-candle-mapping-probe-20260908-v2.json)在恢复副本只读一致性事务内执行：35,725行、3个来源，无孤立source、空标准品种或不支持周期。按规范化server/login比较，三来源各有一个账户候选，历史owner也各匹配一个；尚未证明平台身份及逐K线时刻归属，因此不是已批准回填映射。

按候选账户、二进制标准品种、周期、UTC毫秒键分组发现5,499组跨来源重复，涉及10,998行；这些组的OHLC及tick_volume全部一致，未发现这些字段的冲突。若后续确认该账户/品种映射，可通过多旧行→同一新键的映射保留来源，而不是由upsert顺序决定结果；不能据此丢掉原broker_time、spread等未比较字段。closed来源和revision初始化、旧消费者处理、构建表与提升校验继续待做。

本轮两项复核：职责上保持参考采集与只读旧数据调查独立，候选统计不改变业务授权；异常上覆盖目标库限制和fixture失败回滚，并将候选重复键与内容分歧分开报告。5项本地注册/助手限制测试通过。恢复副本仍未执行038，当前dev_vue未写入。
