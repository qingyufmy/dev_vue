# Reviews


## 运行组装边界

业务 index 公开领域和应用端口/服务；MySQL repository 与 HTTP 路由由 composition 私有组装。API 通过 createMysqlReviewHttp 接收插件，模块拥有 /api/v4 路径，总注册器拥有 trade Host 隔离。Worker 通过 createMysqlReviewWorker 接收 process 能力，运行入口持有队列、模型解析端口、连接池和生命周期。

定向测试包括 review-worker、review-memory-core、review-lock-projection。租约与 fencing、模型额度、复盘内容和策略记忆规则保持原实现；真实流程、数据所有权和合同全覆盖仍需验收，不能以静态边界清除视为全部完成。

运行记忆读取：公开RuntimeStrategyMemoryReader仅返回已授权策略的当前库状态及修订；实现由composition组装，SQL与记忆数据所有权留在reviews。不存在库返回absent；off/shadow或非active库返回disabled且不含正文；active当前修订核对复合归属、UTF-8字节数与SHA-256，正文超过64KiB拒绝。该字节上限不是模型token预算验证。类型/范围错误或断裂证据不能当作无记忆。定向入口：server/tests/runtime-strategy-memory-reader.test.ts；真实MySQL参考入口：scripts/lib/runtime-memory-reference.mjs（由隔离参考库runner调用）。后续inference输入冻结和注入审计尚待接线。

周期复盘：PeriodReviewWorkflow 应用状态机由 MySQL 工作项存储，scheduler-trade-history 经 bootstrap 登记自然周期，worker-review 的周期消费者推进；MySQL due 恢复器重建唤醒。HTTP 和模型 Worker 不承担周期发现。实际覆盖及剩余项以 refactor-delivery-checklist-20260911.md 最新记录为准。
