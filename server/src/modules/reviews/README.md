# Reviews


## 运行组装边界

业务 index 公开领域和应用端口/服务；MySQL repository 与 HTTP 路由由 composition 私有组装。API 通过 createMysqlReviewHttp 接收插件，模块拥有 /api/v4 路径，总注册器拥有 trade Host 隔离。Worker 通过 createMysqlReviewWorker 接收 process 能力，运行入口持有队列、模型解析端口、连接池和生命周期。

定向测试包括 review-worker、review-memory-core、review-lock-projection。租约与 fencing、模型额度、复盘内容和策略记忆规则保持原实现；真实流程、数据所有权和合同全覆盖仍需验收，不能以静态边界清除视为全部完成。
