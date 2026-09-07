# 阶段 185：学习域按 UTC 原值真实回填

## 用户决定与范围

用户明确要求“旧表时间直接当 utc 迁移吧，错了就错了，不影响啥”，并要求继续。此决定替代阶段 182/184 等待历史时区证明的条件：旧 DATETIME 的日历值不变、按 UTC 解释，全部非空时间 offsetMinutes=0。承认可能存在历史偏差，不伪造历史校准事实。

本次仅当前开发库 dev_vue，命令全部从本地 Windows 执行；虚拟机只有 MySQL 承载本次工作。没有公网、网站/Worker/Bridge 启动、真实交易或旧表删除。

## 回填结果

| 目标 | 写入行数 |
| --- | ---: |
| learning_courses | 12 |
| learning_lessons | 12 |
| learning_media_references | 12 |
| learning_progress | 5 |

来源课程 12 行、进度 5 行完整原值前后相同，来源摘要未变化。课程审计与进度审计 differences 均为空，来源归档分别 12/5 条，ID 映射 24/5 条。权限、状态、媒体标识保持原值；观看时长超过总时长的原始记录未截断。

实际 SQL 逐项比较课程 created_at/updated_at 与新 UTC 字段及进度 updated_at，共 29 字段，偏差数为 0。回填后 recover、verify、再次 apply 均 verified，目标计数仍为 12/12/12/5。

## 入口与验证

新增 `--promotion`，只允许绑定这次 course/progress manifestHash、同一 server UUID/schemaHash、接受 UTC 原值语义的清单。读取此前真实本地恢复库演练回执，校验其 SHA-256、提交未知恢复、重复执行、清理及 CLI 结果，并核对已演练 scripts/lib 与 migration 文件摘要；仅更新入口适配层，原转换器、SQL 写入器和事务执行器未修改。

- courses run：`7379e047-2a9d-4bbd-9973-f13a745f6cec`
- progress run：`15e70e7e-243c-489c-a10e-383b57f871b5`
- course manifest：`05feeacdd48cc68e18735892bf52f621d514d0c315f5f1721dedec31bfd7f605`
- progress manifest：`989db1bf640aba4a912094efeb7551ee100f1d087d11e629805b322b92d78be6`

私有目录 mysql-20260907-01 保存 source-review-03/04、utc-policy、real-basis-02、real-evidence、两个 manifest、promotion、live-apply/recover/verify 回执，全部位于仓库外。第一次清单预检发现进度来源列表排序与转换器数值 ID 排序不同，已仅修正清单摘要排序；源数据未变，生成双方清单之前拒绝了第一次预检，没有写库。

## 定向复核与下一步

需求复核：用户选择是迁移语义而非声称旧库真正 UTC，来源存证保留原始时间；不再反复确认同一决定。数据复核：零偏移、NULL、相同源快照、映射、演练工具未漂移、幂等与审计齐全。

本轮定向测试覆盖准入、清单、执行器、课程及进度恢复；真实依赖预检、回填、恢复、验证通过。学习域消费者尚未切换，媒体资源可访问性没有验证。下一步按目标表完善学习域 API/读取与旧数据对照验收，随后继续其他业务域；不等同全面数据库优化完成。
