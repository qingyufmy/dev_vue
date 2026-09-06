# 同库升级第三十七批：最终执行核对冻结窗口

风险决策窗口检查现在联结交易决策与交易员run一致的输入快照，限制purpose、用户和账户，并读取payload。先验证当前窗口允许执行，再校验payload_sha256、subscriptionWindowHash格式及其与当前配置摘要的一致性。历史无摘要、payload损坏或摘要不一致不从当前配置补造证据。分别使用execution_schedule_unproven/execution_schedule_changed，经已有Bridge发送前失败路径记录拒绝并释放预留，无socket发送。

检查复用于创建执行意图及markDispatched事务，补齐“决策产生后配置修改，即使新旧配置均允许当前时刻，也不直接执行旧决策”的边界。读取原快照不更新任何旧payload。

29项执行/命令/冻结证据测试通过，服务端类型和构建通过。SQL捕获升级v3，共8条；在开发参考库dev_vue_m1_a、MySQL8.4.8执行8条EXPLAIN和SELECT并回滚，结果均0行，包含新增快照证据查询。见[输入v3](subscription-window-sql-input-v3-20260907.json)和[回执v3](subscription-window-sql-validation-v3-20260907.json)。远端window-sql-20260907-05工具包3文件SHA与本地一致，旧证据包保留。

尚需：分发目标冻结相同配置摘要，有数据/并发演练，时段转换完整验收，以及其余数据库字段合同和业务回填。空结果真实SQL验证仍不是有数据权限证明；本批没有业务写入、角色启动或交易。全量自动升级和旧结构删除目标仍未完成。
