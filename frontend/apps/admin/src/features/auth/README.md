# Admin 认证模块

职责：维护 admin 应用会话，只接受包含 admin 权限的会话，提供加载/退出与登录页动态加载。权限判断不代替服务端授权。

公开入口为 `index.ts`：`useAdminSession` 和 `loadLoginView`。其它模块读取只读的会话快照及展示状态，不能导入内部 session 文件或直接修改 ref/嵌套用户字段；load 返回值同样只读。

依赖仅为 Vue、公共 api-client 与合同类型；本模块拥有会话状态，不依赖 trade 应用，不直接写数据库或浏览器持久存储。

验证入口：`tests/auth-public-session.test.ts`、既有 settings/router 测试与 admin 类型检查/构建。
