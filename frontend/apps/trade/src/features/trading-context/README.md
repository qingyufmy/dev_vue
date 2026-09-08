# 交易上下文投影

本模块拥有服务端返回的账户目录、当前交易/观摩上下文、观摩频道目录、当前账户快照及首页实时连接状态。它不是页面模块，不授予访问权限、不保存行情或持仓。账户命令恢复逻辑也归本模块，生产传输和页面接线仍待完成。

公开入口 `index.ts` 提供只读投影，以及对应 `applyTradingContext`、`applyTradingAccounts`、`applyObserverChannels`、`applyAccountSnapshot`、`applyRealtimeState` 操作。目录/上下文深复制，账户快照按当前全部标量字段复制，避免调用方保留的对象引用继续修改内部状态；若快照新增嵌套字段须同步升级复制与测试。其它模块不得直接写 ref、数组或嵌套字段。

账户ID、观摩频道或模式变化及退出上下文时清除账户快照和连接状态；同一作用域的revision更新保留快照。`currentAccount`只显示与当前账户ID匹配的快照，否则回退到账户目录。模块不能凭账户ID区分所有异步来源；应用快照前仍须调用方验证用户和请求代次。

调用方先完成已有请求代次、当前用户及账户作用域检查，再应用响应。投影入口不将任意 DTO 当作授权依据。账户命令控制器另行处理持久请求身份及确认；页面仍须完成调用接线和作用域检查。

`createRequestScope`提供按通道独立的最新请求检查。调用方提供包含用户会话与工作区代次的生命周期键，在成功、错误和finally写状态前调用返回的检查函数；它不取消网络请求，也不代替服务端revision或幂等。交易员已接入workspace、decisions、detail、refresh与realtime通道，身份变化同步失效旧生命周期并清理数据；首页context、account-load、snapshot、market、analysis和analysis-strategies使用同一工具。首页stop推进生命周期并停止实时；内部账户加载不再次推进父流程代次。行情仍额外核对账户、品种和周期，身份变化同步清理上下文与页面投影。

依赖 Vue、公共合同类型及 api-client 的错误类型；无其它 feature 或数据库依赖。命令控制器经注入的传输与浏览器存储端口工作，当前尚未接入真实 HTTP/sessionStorage。home、risk、trader、应用壳层与实验室时间读取通过本入口协作。

测试入口：`tests/trading-context-public.test.ts` 验证独立副本、只读状态、作用域清理及错误账户快照隔离；既有观摩切换、迟到请求和时间测试验证消费者行为。首页行情/持仓/revision归home内部，交易员持仓/挂单/revision归每个workspace实例，已删除原lib共享可写运行状态。异步请求协调和完整用户流程尚未统一验收，不能据本模块成立宣称整个交易上下文业务迁移完成。

`createContextCommandController`供home/risk/trader共享一个实例；传输能力负责发送冻结命令、查询原回执、读取当前上下文。scope由userId与稳定的登录会话标识组成，sessionKey应使用authenticated_at等非敏感标识，禁止使用token。注入sessionStorage可在同标签页刷新后恢复，不能改用跨标签页共享的localStorage来覆盖待确认意图。

start持久化最小命令后发送一次；recover只读，不重发；retry必须由明确的重试动作触发，仅发送原键/动作/目标/revision。未查到回执和查询失败均保留意图。确认历史回执后读取当前上下文，当前版本不能早于回执版本，也不能属于其它用户。已发生过未知结果的命令不会因之后收到普通拒绝就被清除。clear只用于登出/会话切换，不提供未知命令的丢弃后重发入口。

`tests/context-command-controller.test.ts`验证刷新、失联、重复点击、会话变化、历史/当前隔离、拒绝分类、存储失败和错误回执。传输及存储均为fixture，不代表HTTP、真实浏览器或三个页面已经接通。
