# Strategies


## 目录与 HTTP 组装

API 和后台入口通过 composition 的 createMysqlStrategyService 创建业务服务，createStrategyHttp 组装固定 /api/v4 路由。模块业务 index 不导出 MySQL 目录和 HTTP 实现；推理仍可使用 StrategyService 业务能力。连接池、队列和进程生命周期由入口负责。

定向回归为 strategy-management、strategy-market-plan、strategy-entry-methods。订阅执行偏好 SQL 的跨模块公开调用仍是待收口项，须保留同事务读取和并发语义；静态边界通过不代表完整策略、数据和前端流程验收。
