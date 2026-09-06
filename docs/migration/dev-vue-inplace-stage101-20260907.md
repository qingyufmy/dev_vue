# 阶段 101：会员批次事务与来源归档

新增 inplace-membership-v1 批次合同、runner、factory 和 51 步 MySQL 适配。仅允许 users/membership-v1 流写 memberships；user_id 保持原用户 ID，生成独立会员实体 ID map，不修改用户主键。

目标行、ID map、批次回执、七字段完整来源与解析依据、检查点使用同一事务。来源证据写入后完整回读；任何差异回滚。原用户来源仍由逐行 writer 先锁定核对；不允许冻结快照之后的会员变更被旧来源覆盖。

保持历史工具与证明散列不变，新增会员版本的批次合同与 runner；数据库事务、死锁有限重试和 commit_unknown 行为继续复用既有 MysqlBackfillRepository。完整 51 步及 users 结构参与目标身份指纹，不过滤未知日志。

## 验证

```powershell
pnpm exec vitest run tests/v4-membership-backfill.test.js tests/v4-membership-backfill-runner.test.js tests/mysql-membership-writer.test.js tests/v4-backfill-mysql-repository.test.js
```

31 项测试通过，覆盖来源与依据防篡改、仅写会员目标、回执与来源同连接、证据差异回滚、运行 ID 不一致拒绝、重复与恢复等。当前 dev_vue 的新适配器真实只读身份检查通过，storageMode=inplace-membership-v1；本轮无业务写入。

这些批次测试使用模拟事务/SQL，不能代替整批真实 MySQL 验证。下一步在恢复副本验证提交后断连、来源证据失败、重复和完整归档/目标对账；真实会员回填依据、消费者切换与旧字段删除仍未完成。
