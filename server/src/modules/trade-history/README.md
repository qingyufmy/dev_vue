# Trade history

## 职责与边界

模块拥有历史任务、终端历史事实/来源、账户历史投影、同步状态与完成回执。domain使用本域历史事实类型；application经Bridge公开查询端口和trading公开账户/授权能力协作。业务index公开领域与应用端口，MySQL/HTTP实现仅由composition组装；入口负责连接池、队列、轮询与进程生命周期。

## 公开组装

- HTTP：createMysqlTradeHistoryHttp；路由插件拥有/api/v4前缀，总注册器执行trade Host隔离。
- 任务消费：createMysqlHistoryTaskWorker，只接受taskId，由MySQL解析账户并复核当前路由/租约。
- 调度：createMysqlTradeHistoryScheduler，注入trading公开账户锁；同库命名锁串行候选扫描，任务/outbox原子登记。
- 恢复：createMysqlHistoryTaskRecovery，原taskId与固定窗口重投，保留完成摘要。
- 任务启动准入：assertMysqlHistoryTaskSchemaReady，检查191步及11张表。历史只读HTTP保持独立准入。

队列为aurum-v4-bridge-history-task，事件trade.history.task.requested只携带task_id。任务窗口、route、租约、完成摘要和结果都由MySQL持久保存。busy转延迟，completing恢复不重新查终端，完成确认未知以同证据确认，旧token不能分页或结束任务。

旧aurum-v4-bridge-history不再创建或消费。旧trade.history.requested不再被outbox领取；显式投递旧事件会返回outbox_history_legacy_event_retired。旧数据库事件与Redis消息保留，不删除、不改为成功；新的到期调度根据当前账户与持久同步进度创建任务，不依赖旧消息内容。无task绑定的旧采集工厂已移除；基础仓库无绑定分支仅用于历史参考验证，不在运行入口组装。

## 验证与剩余范围

核心证据见[历史任务验收](../../../../docs/history-task-core-acceptance-20260910.md)。已验证MySQL恢复/并发和实际Redis队列的MT5合成分页、闭仓投影及重复消息；这不证明真实终端在线、完整历史覆盖或MT4全链路。

定向入口：history-task-*、history-schedule-transaction、trade-history-collector、history-page-chain、trade-history-money-summary、trade-history-ownership-guard测试，以及scripts/run-history-completion-reference-local.py。参考脚本会操作独立MySQL库和独立Redis前缀，不能作为普通无依赖单测运行。


持仓历史数量读取：OpenPositionLifecycleReader由业务index公开，createMysqlOpenPositionLifecycleReader由composition组装。调用者提供已授权账户和一致快照连接；读取器仅核对MT5稳定持仓ID对应成交与当前数量，不证明完整历史覆盖或策略归属，不可直接当作模型参考组合。定向测试为open-position-lifecycle-reader及open-position-lifecycle。


历史遍历读取：HistoryTraversalReader / createMysqlHistoryTraversalReader核对051回执及当前授权route，合并terminal来源UTC窗口。traversed只证明可验证回执范围连续，completeHistoryProven固定false；不证明终端/缓存完整历史。调用者拥有同一读取快照。验证入口history-traversal-reader.test.ts和scripts/lib/history-traversal-reference.mjs。


任务覆盖声明读取：HistoryTaskCoverageReader / createMysqlHistoryTaskCoverageReader只读取指定成功任务，验证完成摘要与关联回执的正文/hash/列身份。provider_asserted表示供应方声明已绑定完成任务，不是策略归属或执行许可。缺声明的旧任务保持unresolved。测试入口history-task-coverage-reader、history-task-completion及真实任务队列参考。


成交来源核验：HistoryTaskDealSourceReader / createMysqlHistoryTaskDealSourceReader在同一授权快照中读取成功任务覆盖和指定MT5成交的052来源。source_matched仅证明route/sourceRevision/sourceKind与事实hash匹配，不证明具体分页成员或策略归属。真实验证入口为history-task-queued-collection-reference。


窗口覆盖选择：HistoryWindowCoverageReader / createMysqlHistoryWindowCoverageReader在同一授权快照中选择一个覆盖完整UTC窗口的已完成任务，并重建任务与回执证据；不拼接不同快照，旧缺声明可跳过，坏证据直接拒绝。验证history-window-coverage-reader及实际任务队列参考。


持仓历史组合：OpenPositionHistoryReader / createMysqlOpenPositionHistoryReader使用同一授权快照连接完成数量核对、历史窗口选择和成交来源核验，最多10000成交按1000分批。source_matched不证明精确分页成员或策略归属。定向入口open-position-history-reader及实际历史任务队列参考。
