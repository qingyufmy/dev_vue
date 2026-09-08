# Trade history


## HTTP 读取组装

业务 index 公开历史领域与应用服务；MySQL 读取 repository 和 HTTP 路由只从 composition 组装。API 使用 createMysqlTradeHistoryHttp，测试可用 createTradeHistoryHttp 注入服务。模块拥有 /api/v4 路由前缀，总注册器拥有 trade Host 隔离，插件不负责启动监听或建立连接池。

账户归属、金额可比较性、游标筛选与详情证据语义不变；定向测试为 trade-history-core、trade-history-money-summary、trade-history-ownership-guard。采集与调度适配器公开导出、Bridge 类型和跨域 SQL 尚未全部收口。
