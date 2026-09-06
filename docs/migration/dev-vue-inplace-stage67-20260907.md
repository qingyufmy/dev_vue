# 阶段 67：推荐账户真实回填与提交未知恢复

恢复副本 `dev_vue_m1_source_20260907_02` 已真实回填 25 条推荐账户。本阶段没有向当前 dev_vue 写入推荐余额。

运行清单先以独占创建和 fsync 保存到远端 `referral-backfill-03/run.json`，冻结 run ID、登记时间、来源 hash、转换 hash、完整 46 步 schema 身份、125 文件工具 hash、批次大小 10。重启复用该清单，任一绑定变化都拒绝执行。

## 真实结果

- 三批完成 25 次目标 INSERT；第一批 MySQL COMMIT 成功后主动销毁连接，事务层报告 commit_unknown，再通过持久批次回执确认 committed，未重放该批业务写入。
- 全批再次执行不产生 DML；独立启动第二次也没有业务 INSERT，并回读全部 25 条目标、行回执和源证据。
- 每用户金额、推荐码、推荐来源码、revision、登记时间均与来源及冻结规则一致。余额总额为 80.00000000，逐用户核对通过；没有以总额相等替代逐行对账。
- 源证据保存旧 created_at/updated_at 原值，明确这是推荐字段投影、没有转换历史时间。目标与源字段没有删除。
- 原 165 表/271007 行指纹仍一致。副本新增的是独立推荐目标记录及迁移元数据。

## 可复查证据

| 文件 | SHA-256 |
| --- | --- |
| dev-vue-referral-backfill-rehearsal-20260907.json | afe9ec63822b0f36f2bb7aed8cb9e9cfafde498191a9c688322ca7ac9807f6ea |
| dev-vue-referral-backfill-repeat-20260907.json | 9fd32e27358ae2c43e064b7f184fa8f7062a46ad632d80f0e732bcccb543ff91 |
| dev-vue-referral-backfill-run-20260907.json | 0c3ae8068ec4fe8910521e5ccb6acfacf41e7e84540f7077c3ca65608ddefac2 |

成功工具包 SHA-256：`9bc6f3aa6612a843285c3032babffa33d4280ed35b9ef3272b6822c3192964e2`，125 文件逐项与本地核验。远端工具、运行清单和回执保留；本地三个临时 tar 已清理。

首次包遗漏两份证据文件，在生成 run 清单前终止。第二次完整包发现 ORDER BY id 解析到 CAST 为字符串后的别名，与转换器数值排序不同；原全库 hash 已通过，未生成 run/未写业务记录。改为 ORDER BY users.id 后实际执行通过。前两次失败现场保留，不能当作成功演练。

## 边界与下一步

本次证明恢复副本的真实提交后断连恢复、三批持久化、目标与来源证据对账；尚未独立逐项核对 ID map 和 checkpoint 内容，需在提升当前库之前补齐。部署时全旧库自动升级、全库领域迁移、财务运行写入协议、旧结构删除门均未完成。下一步绑定本次演练证据至开发库回填入口，补映射/检查点回读后执行同样的 25 行转换，继续保留旧 users 推荐字段。
