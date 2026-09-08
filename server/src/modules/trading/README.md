# Trading 模块

负责账户身份/归属、账户与观摩上下文、连接额度查询及交易数据投影。实际交易执行与风险决策不归本模块。

## 入口与组装

`index.ts`公开业务类型、应用服务与协议。MySQL账户/观摩repository、Redis发布订阅/连接租约和认证适配器已不通过业务入口导出。`composition.ts`仅供bootstrap/entrypoints使用：

- `createTradingApiModule`组装账户/观摩服务、连接额度、HTTP插件和两种认证端口；trade会话与admin会话分别解析。
- `createTradingReader`向分析/交易员/调度角色提供现有查询能力，不公开具体MySQL类。
- `createBridgeTradingModule`提供连接额度能力与Bridge投影用例；保留原投影事务，提交后再发布实时事件。
- `createBrowserTradingModule`组装同一账户/观摩读取器、实时hub及Redis生命周期，返回公开的sessions、publication能力和订阅生命周期。WebSocket层通过sessions.open创建会话；Redis订阅器使用application发布端口，不再引用传输层。启动与关闭仍由运行角色控制，工厂不会自动监听或订阅。
- `createAccountRegistration`由Bridge的同事务工厂调用，使用传入连接完成账户及归属写入，不独立提交。
- `createTransactionAccountClock`将调用方已经开启的事务连接绑定为`AccountClockReader`。推理与执行的repository/guard显式注入该工厂；任务生成、冻结证据复核、规划及派发前检查均使用各自当前事务，不新建连接或独立提交。业务公开入口不再导出时钟SQL实现。

认证请求端口在application/request-authentication.ts声明，不再由infrastructure反向引用HTTP文件。API总注册器使用结构化认证端口，不依赖具体适配器类。

## 数据与依赖

账户身份、归属区间和用户账户设置的当前库增量升级按账户根方案执行。账户切换仍使用revision并在事务内验证所有者/观摩权限；Bridge投影仍核对账户、归属、凭据、档案、epoch及revision。

当前repository还写入trading_contexts、账户运行快照、行情/持仓/挂单投影、来源证明与Bridge交易状态；风险预留吸收仍跨域写risk_reservations_v4/risk_reservation_events_v4。这些是现有事实，不能据此宣称全部表已完成唯一写入者收口。行情归属按P2、风险预留端口按P5继续处理。

## 验证与剩余边界

定向验证覆盖trading-composition、账户离线查询、账户/观摩HTTP、浏览器实时、Bridge投影以及认证边界；服务端完整类型检查、构建与精确越界检查同时执行。

第三十九批移除8个基础设施及2个HTTP公开导出，第四十批另移除事务账户时钟SQL导出，第四十一批移除实时hub/session导出。业务index现在仅导出domain/application能力。createTradingHttp/createObserverManagementHttp负责固定路由前缀，总注册器继续拥有trade/admin的域名隔离。其它域内部依赖、跨域写入与类型依赖环尚未清零。此次组装变更不代表账户模块或全栈重构完成，也不改变数据库就绪状态。

会话close是终止操作，区别于允许后续重新订阅的subscription.unsubscribe。关闭后不接收排队消息；异步授权/订阅迟到时立即释放返回的订阅，旧代次不再发送或关闭当前连接。WebSocket的close/error均调用会话close。

复核：职责侧保留既有业务用例和角色分工，将具体实现组装集中到受限入口；异常侧核对认证scope/CSRF、实时回调与关闭顺序、投影提交和发布顺序保持。剩余问题明确列出，不通过新增边界例外消除检查错误。
