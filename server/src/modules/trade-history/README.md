# Trade history


## HTTP 读取组装

业务 index 公开历史领域与应用服务；MySQL 读取 repository 和 HTTP 路由只从 composition 组装。API 使用 createMysqlTradeHistoryHttp，测试可用 createTradeHistoryHttp 注入服务。模块拥有 /api/v4 路由前缀，总注册器拥有 trade Host 隔离，插件不负责启动监听或建立连接池。

账户归属、金额可比较性、游标筛选与详情证据语义不变；定向测试为 trade-history-core、trade-history-money-summary、trade-history-ownership-guard。采集与调度适配器公开导出、Bridge 类型和跨域 SQL 尚未全部收口。


采集和调度现由 composition 的 createMysqlTradeHistoryCollector/createMysqlTradeHistoryScheduler 创建，只返回 collect/schedule 能力。业务 index 不导出 MySQL 实现；运行入口负责连接池、队列、轮询和生命周期。采集用例/端口通过 Bridge 公开入口取得协议类型，领域投影的 Bridge 内部类型依赖仍待移除。定向回归增加 trade-history-collector 和 trade-history-currency，源码验证不代表执行过真实历史同步。
