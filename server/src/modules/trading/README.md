# Trading 模块

负责账户身份/归属、账户与观摩上下文、连接额度查询及交易数据投影。实际交易执行与风险决策不归本模块。

## 入口与组装

`index.ts`公开业务类型、应用服务与协议。MySQL账户/观摩repository、Redis发布订阅/连接租约和认证适配器已不通过业务入口导出。`composition.ts`仅供bootstrap/entrypoints使用：

- `createTradingApiModule`组装账户/观摩服务、连接额度和HTTP插件，接收独立的trade/admin认证端口。会话Cookie解析和CSRF归auth实现，由API入口注入；trading不依赖AuthService或持久会话结构。
- `createTradingReader`向分析/交易员/调度角色提供现有查询能力，不公开具体MySQL类。
- `createBridgeTradingModule`提供连接额度能力与BridgeProjectionPort投影能力；Bridge仅通过公开输入合同调用，不依赖BridgeStreamProjector具体类。保留原投影事务，提交后再发布实时事件；具体类不再从业务index导出。

可信持仓/挂单投影的预留吸收通过ProjectionReservationAbsorber消费方端口执行。Bridge运行入口注入execution的同连接工厂；trading保有事务，execution负责预留SQL与审计。工厂缺失或能力失败时回滚，不默认为空结果。只读repository无需该能力；Bridge投影组装必须显式传入。快照哈希使用shared/canonical-json技术工具，不依赖execution领域文件；其它跨域SQL仍待收口。
- `createBrowserTradingModule`组装同一账户/观摩读取器、实时hub及Redis生命周期，返回公开的sessions、publication能力和订阅生命周期。WebSocket层通过sessions.open创建会话；Redis订阅器使用application发布端口，不再引用传输层。启动与关闭仍由运行角色控制，工厂不会自动监听或订阅。
- `createAccountRegistration`由Bridge的同事务工厂调用，使用传入连接完成账户及归属写入，不独立提交。
- `createTransactionAccountClock`将调用方已经开启的事务连接绑定为`AccountClockReader`。推理与执行的repository/guard显式注入该工厂；任务生成、冻结证据复核、规划及派发前检查均使用各自当前事务，不新建连接或独立提交。业务公开入口不再导出时钟SQL实现。

认证请求端口在application/request-authentication.ts声明，不再由infrastructure反向引用HTTP文件。API总注册器使用结构化认证端口，不依赖具体适配器类。

## 数据与依赖

账户身份、归属区间和用户账户设置的当前库增量升级按账户根方案执行。账户切换仍使用revision并在事务内验证所有者/观摩权限；Bridge投影仍核对账户、归属、凭据、档案、epoch及revision。

当前repository还写入trading_contexts、账户运行快照、行情/持仓/挂单投影、来源证明与Bridge交易状态；风险预留吸收仍跨域写risk_reservations_v4/risk_reservation_events_v4。这些是现有事实，不能据此宣称全部表已完成唯一写入者收口。行情归属按P2、风险预留端口按P5继续处理。

## 验证与剩余边界

运行在线证据通过AccountLiveRouteReader消费方端口读取，不导入BridgeGatewayLeaseStore。端口只提供账户、用户、平台/服务器/login、档案、终端实例及连接ID/epoch；连接声明不代表授权，仍与MySQL当前归属、绑定、新鲜心跳联合检查。租约不可用或不匹配保持离线；私有投影代次不匹配拒绝返回旧快照。Bridge实现以结构兼容方式注入，无需共享其完整路由类型或写租约能力。

定向验证覆盖trading-composition、账户离线查询、账户/观摩HTTP、浏览器实时、Bridge投影以及认证边界；服务端完整类型检查、构建与精确越界检查同时执行。

第三十九批移除8个基础设施及2个HTTP公开导出，第四十批另移除事务账户时钟SQL导出，第四十一批移除实时hub/session导出。业务index现在仅导出domain/application能力。createTradingHttp/createObserverManagementHttp负责固定路由前缀，总注册器继续拥有trade/admin的域名隔离。其它域内部依赖、跨域写入与类型依赖环尚未清零。此次组装变更不代表账户模块或全栈重构完成，也不改变数据库就绪状态。

会话close是终止操作，区别于允许后续重新订阅的subscription.unsubscribe。关闭后不接收排队消息；异步授权/订阅迟到时立即释放返回的订阅，旧代次不再发送或关闭当前连接。WebSocket的close/error均调用会话close。

复核：职责侧保留既有业务用例和角色分工，将具体实现组装集中到受限入口；异常侧核对认证scope/CSRF、实时回调与关闭顺序、投影提交和发布顺序保持。剩余问题明确列出，不通过新增边界例外消除检查错误。

## 当前账户结构就绪检查

投影中的账户观察时间、报价观察时间、K线开盘时间、来源证明和精确ticket观察时间在MySQL绑定处转换为Date，由UTC驱动序列化；JSON payload内的ISO时间保持原合同。非法时间抛出trading_context_invalid并回滚。

真实时间验证：构建后运行`node scripts/verify-projection-times-mysql.mjs <新的绝对路径回执>`。脚本在独立连接复制当前四表为临时表，执行applyProjection验证账户/报价/K线毫秒UTC读回、重复revision和非法时间回滚，结束销毁连接。LIKE不复制外键，因此它不证明FK、可信路由、来源证明或ticket完整链路。正式业务数据写入0。

`assertTradingSchemaReady`只从composition向API运行组装公开。API启动前及`/health/ready`调用它；检查失败不会监听启动端口，运行中的健康检查返回不就绪。它不自动迁移、不证明所有API/其它业务域就绪，也不代替停写窗口或逐请求授权。

当前支持`inplace-account-165/v1`升级档案：165条登记checksum全部完成，后续新增步骤允许存在但必须完成；23张账户读取/上下文/投影依赖表的规范化DDL与触发器检查一致。依赖表检查不改变其业务写入所有者。新建库使用其它迁移账本、升级改变这些表、或MySQL产生非等价DDL时均失败关闭，须补充已验证的兼容档案，不得跳过检查。自增计数及等价utf8mb4显式字符集写法不属于结构漂移。

这是当前升级到运行的过渡检查：整表DDL摘要会拒绝消费方不使用的新列，跨域表仍存在物理结构耦合。账户样板收口时须随SQL访问端口化，将跨域依赖改为所有者发布的兼容能力检查；无关新增列不应要求trading改动。该项未关闭前不能以本检查宣布模块独立性验收完成。

生成源为登记迁移与当前165步证明，不绑定VM身份或行数据。更新时运行`node scripts/generate-trading-schema-readiness.mjs`，核对兼容性并执行`node scripts/generate-trading-schema-readiness.mjs --check`和`tests/trading-schema-generation.test.js`；生成测试会拒绝源与产物漂移。既有package脚本属于历史冻结输入，本批未修改。就绪检查短暂持有同连接升级锁，仅读取有界日志与元数据；释放不确定则销毁连接并拒绝就绪。

实际只读核验入口为`node scripts/verify-current-trading-reads-local.mjs <新绝对路径回执.json>`，先构建server。使用server/.env应用账号和UTC连接池，在只读一致事务内核验账户读取及归属拒绝；不会建立会话或写入用户上下文。HTTP、Redis、浏览器与正向观摩授权仍需独立验收。
