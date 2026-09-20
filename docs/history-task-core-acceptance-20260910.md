# 历史采集核心验收（2026-09-10）

状态：持久任务主链路的本地/隔离依赖验收完成；完整历史业务域及整体核心重构未完成。应用服务未启动，没有真实终端或交易指令。

| 要求 | 已验证证据 | 范围 |
|---|---|---|
| 当前数据库可增量升级且保留旧数据 | architecture/history-task-current-proof-20260910.json | dev_vue 190→191，256张保护表及旧账本保持一致 |
| 故障后按实际DDL/账本续跑 | architecture/history-task-restored-proof-20260910.json | 三类确认丢失、重放零DDL |
| 固定任务窗口、租约接管与旧实例隔离 | architecture/history-completion-transaction-reference-v29-20260910.json | taskClaims/taskCollector，真实MySQL |
| 完成回执与同步/汇总/outbox/task原子完成 | 同上taskCollector/taskQueue | 提交前回滚、提交确认丢失恢复 |
| 过期任务恢复且不篡改准备摘要 | 同上taskRecovery | 同任务重投、冷却、并发与未知提交 |
| 到期账户调度及双实例并发 | 同上taskScheduler | 合成会话筛选、20轮双调度，命名锁避免登记死锁 |
| 实际队列投递、延迟与恢复 | 同上taskQueue | VM Redis DB3随机前缀、真实BullMQ，资源已清理 |
| 新任务分页与闭仓投影 | 同上taskQueue.collection | MT5合成query port，订单页+两页成交、两份来源、一笔归属闭仓 |
| job被清除后同事件重投 | 同上taskQueue.collection | 持久任务确认，无重复查询或写入 |
| 旧账户事件退役 | 同上taskQueue.legacyEventPreserved | 原事件pending/attempts0，无删除或伪造完成 |

生产入口只组装taskId worker；调度与Gateway要求191步结构。outbox启动/健康检查覆盖新历史任务队列与instrument队列。旧账户队列未执行破坏性清理，旧事件从领取白名单排除。

## 尚未完成与后续衔接

- 真实MT4/MT5终端、断线重连、长期运行与浏览器流程验收，按用户要求留在Bridge/前端阶段具体处理。
- MT4完整队列采集、复杂部分平仓/费用/跨历史快照覆盖不能由当前MT5两笔夹具证明。
- 历史完整覆盖与策略归属、组合持仓提供器接入、策略/订阅业务转换、策略运行缺口及执行上下文仍属于核心剩余工作。
- 累计混合工作区未提交推送。此记录不构成生产发布或完整核心完成证明。
