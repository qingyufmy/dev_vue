# 审计查询模块

业务入口 `index.ts` 只提供 AuditReadApi、查询/分页/结果类型及 AuditError。repository、具体服务和 Fastify 路由不属于跨域公开能力。

受限入口 `composition.ts` 由运行组装层创建模块，生产使用 createMysqlAuditModule；返回查询服务及已绑定依赖的 HTTP 插件。API registrar 只挂载注入插件，不导入模块内部路由或数据库实现。测试可以从内部路径验证单元行为，并通过组装工厂验证真实注册。

模块当前为只读联合投影，读取分析、执行、风控和终端历史事实，不拥有这些源表的写入口。MysqlAuditRepository 中的跨域 SQL 需随各域数据所有权清单审查，当前不宣称这一数据边界已收口。查询必须保持用户/账户范围、有限时间窗和游标过滤绑定。

标识符校验属于审计输入边界，不再借用 trading 的内部校验函数或错误类型。HTTP 既有路径、响应及权限语义保持。

验证：server/tests/audit-core.test.ts，server/tests/browser-realtime-runtime.test.ts 中包含真实审计插件挂载、路由存在性及无账户权限拒绝；完整 server 类型检查。不依赖数据库的测试不替代真实 MySQL 联调和全量 API 合同验收。
