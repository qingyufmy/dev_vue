# 阶段 75：期初账本事务写入器

实现 `mysql-referral-openings.mjs`。调用方持有升级锁并开启事务；writer 核对目标库/UUID、完整 47 步结构、冻结 manifest 与原 migration run，然后锁定来源用户、已迁推荐账户和账本记录。它使用旧 run 原绑定检查 25 条映射、3 批和 checkpoint，不修改或过滤旧 schema 版本；当前结构另由新版 coordinator 完整核验。

原始推荐投影从真实 users 读取，目标余额/revision/登记时间必须仍与原回填一致。源证据逐项核对后才生成 opening。已有账本行必须完整一致；出现其他用户、后续版本或内容漂移都拒绝继续，不能覆盖未知财务历史。缺少的 opening 用参数 INSERT，之后锁定回读完整集合，余额始终不 UPDATE。

`verifyOnly` 模式要求全部期初已存在且一致，缺行即 `referral_opening_not_committed`，不 INSERT。供提交未知恢复调用，不能以重新写入代替查明结果。外层继续使用已验证的事务 commit_unknown 协议；本文件不自行提交或重试。

20 项测试通过：期初规则 5、writer 7、共用 MySQL 事务层 8。覆盖精确重复、余额/来源/版本冲突、未知账本和 verifyOnly 缺行不写。未执行真实 opening INSERT；当前与恢复副本账本仍为空。下一步进行完整事务真实回填和提交后断连恢复，再应用当前库。全库规范化与删除门仍未完成。
