# Trade 认证模块

职责：维护当前 trade 应用会话，提供身份展示、加载/退出操作和登录页加载入口。服务端仍负责最终授权。

公开入口为 `index.ts`：`useTradeSession`、只读 `TradeSessionSnapshot` 和 `loadLoginView`。其它模块不能导入 `session.ts` 或写入会话 ref/嵌套身份字段；load 的返回值同样只读。登录页保持动态加载。

依赖：Vue 响应式、公共 api-client 和合同类型；不依赖其它 feature。状态由本模块拥有，不直接写数据库或浏览器持久存储。加载/退出通过现有会话 API 完成，模块不承担交易上下文和账户缓存的所有权。

验证入口：`tests/auth-public-session.test.ts`、既有 router/观摩/Bridge 测试及 trade 类型检查/构建。账户切换与异步会话请求的完整恢复属于后续账户流程验收，不能从本次公开边界验证推断完成。
