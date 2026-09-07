# 阶段 174：学习域真实事务演练脚本准备

新增 rehearse-learning-backfill-host.mjs 与私有 FD launcher。目标固定既有恢复副本；验证工具摘要、备份/列基线、当前 62 步身份与原始全行对账后才允许演练。要求四张学习表为空，指定两个 run 和演练逻辑来源映射未占用，避免混入已存在数据。

演练调用真实 MySQL repository 和学习域执行器。learningRehearsalFaultPool 在每条借出连接核对数据库及 VM UUID，只在真实 batch COMMIT 成功之后注入一次确认丢失；普通 run 登记提交不触发。之后流程要求：

1. 观察 backfill_commit_unknown；只读恢复返回部分未提交，不启动进度，全部受保护行摘要不变。
2. 显式继续 apply，课程和进度业务审核及控制记录审核均通过。
3. recover、verify、再次 apply 均通过，受保护全行摘要不变。
4. 原始全行对账通过后，在单事务中只清理指定 run 的学习行、来源存证、回执、映射和控制记录。
5. 再次比较原始数据及全部新增受保护表，完全回到演练前才生成验收回执。

中途失败不自动删演练数据，保留指定 run 供诊断；清理事务本身失败会回滚。媒体 AUTO_INCREMENT 计数可能消耗，本脚本只证明业务行和控制行恢复，不声称自增计数回退。该演练为应用层集成，回执明确 cliEndToEndVerified=false，不冒充实际 CLI 全链路证据。

## 验证与边界

故障池 3 项、演练输入 3 项测试通过。覆盖实际 commit 先成功才注入、仅一次注入、真实 commit 失败不误报注入、rollback 清除批次状态，以及当前 dev_vue 拒绝。Node/Python 语法检查通过；本地加载 62 步计划，确认六张 data_migration 控制表均包含在受保护集合中。

没有运行真实演练，没有连接 MySQL，没有写入或清理数据库。脚本本身不是演练通过证据，尚无本阶段真实回执。仍需先解决数据库启动故障并重新验收现状，再运行本脚本和实际 CLI 演练；当前库回填提升与全域自动升级仍未完成。

## 2026-09-07 事务适配器联接验证补充

补充故障池与实际 MysqlBackfillRepository.transaction 的组合测试，底层连接仍为 Mock。成功 COMMIT 后注入确认丢失，经适配器得到 backfill_commit_unknown，业务回调只调用一次，连接销毁且不 rollback/release；误指向 dev_vue 时，在 BEGIN 和业务回调前拒绝。故障池 5 项、课程 runner 15 项、进度 runner 15 项，共 35 项通过。该结果只补齐适配器之间的离线行为证据，不证明真实 MySQL 提交、持久化或恢复成功。
