# Execution 模块边界

负责 operation、intent、命令派发及结果恢复。预留的创建、提交、释放与投影吸收当前归本模块实现，风控判断归 risk；模块整体公开导出与其它跨域 SQL 尚未全部收口。

## 可信投影的同事务能力

`composition.ts` 提供 `createProjectionReservationAbsorber(connection)`，只由运行组装入口注入 trading。实现留在 infrastructure，公开结果仅为已吸收预留 ID；不通过业务 index 导出连接工厂或 SQL。

交易账户可信投影拥有事务：先校验并锁定账户/归属/绑定/连接与投影 revision，写入快照、来源证明和精确 ticket 状态，然后使用同一连接执行吸收。适配器不取得新连接，不开启、提交、回滚或释放事务。

吸收读取本模块的成功 intent/command/result 及 committed 预留，按预留 ID 加锁；要求投影 revision 比命令冻结 revision 新、观察时间不早于完成时间，并通过精确 ticket/字段判断。条件更新后在同事务写审计事件；事件失败必须传播给外层回滚。此批搬迁保持既有 SQL 与算法不变。

验证入口：`mysql-trading-offline-accounts.test.ts` 覆盖实际适配器与同连接编排、成功提交、事件失败回滚及能力缺失拒绝；`bridge-projection-absorption.test.ts` 覆盖精确结果判断。测试连接替身不代表真实 MySQL 锁竞争与恢复验收。

`scripts/verify-projection-absorption-mysql.mjs <新的绝对路径回执>`在当前开发MySQL独立连接建立最小临时InnoDB表，运行构建后的execution适配器，验证真实驱动时间序列化、提交、重复及事件冲突回滚；销毁连接清理临时表。必须先构建server，输出文件不得存在。它不验证正式表/FK、完整投影写入、锁竞争或提交未知。真实验证确认DATETIME(3)拒绝ISO字符串直接绑定，因此写入时间先转换Date，由UTC连接池序列化；非法时间在SQL前拒绝。
