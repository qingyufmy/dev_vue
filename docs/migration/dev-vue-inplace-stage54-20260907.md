# dev_vue 同库升级阶段 54：统一协调器真实恢复演练

## 验收结果

在虚拟机 MySQL 8.4 环境中，新建隔离演练库 `dev_vue_m1_source_20260907_02`，从 20260906-01 已验证备份恢复旧结构，真实运行阶段 53 的统一协调器。当前 `dev_vue` 与已有恢复副本未被写入或替换。

- 日志表 CREATE：1 次。
- 原不可变结构步骤：29 次 DDL，全数完成。
- 6 次执行成功后断连、重新连接：全部识别已生效结构并补完成记录，没有重复 DDL。
- 完成后重复运行：29 步全部 completed，新增 DDL 为 0。
- 旧数据完整对账：原 165 张表、271007 行、全部原列按主键排序后的 hash 与冻结基线一致；在恢复后、每次执行前和最终完成后核验。
- 原结构指纹校验通过；新增列和已登记的新表单独由协调器校验。

## 真实断连点

| DDL 阶段 | 注入位置 |
| --- | --- |
| 增量列 | users.last_seen_at_utc |
| 基础表 | auth_sessions |
| 账户工作表 | trading_accounts_v4_build |
| 源行证据表 | data_migration_source_rows |
| 策略循环外键 | strategies.active_version 外键 |
| 订阅偏好工作表 | subscription_execution_preferences_v4_build |

测试在 MySQL 成功响应后主动销毁连接，模拟“DDL 已提交、尚未写 completed”的不确定窗口。它证明该窗口的物理恢复行为，不等于覆盖网络在任意指令字节处中断、主机断电或全部日志真实响应丢失场景；日志边界的全步骤覆盖仍来自阶段 53 离线测试。

## 工具与证据

- 执行器：`scripts/rehearse-dev-vue-schema-coordinator.mjs`。
- Linux 启动器：`scripts/run-dev-vue-schema-coordinator-host.py`；凭据仅通过匿名内存文件描述符传递。
- 回执：`dev-vue-schema-coordinator-rehearsal-20260907.json`，SHA-256 `b73e5aff9c39203de19c2b2357c24e9b5513cf6d29f543d809d436382296325d`。
- 备份原 SQL SHA-256 `9eebdd97aebf89b94c186bfbeda19dc7c028e672d3b27fae1ee4cf45e162bbee`，与既有 SQL 范围检查凭据绑定；未重新导出或覆盖原备份。
- 工具包 SHA-256 `8c349ba5dca22efa704ff8d184d80d2e8303b36b83084c0d14b69e1b151de240`，101 个文件逐个核对。回执取回后再次与本地逐文件核验一致。
- 远端保留目录：`/www/backup/aurum-v4/m1/20260906-01/schema-coordinator-rehearsal`；本地临时压缩包已删除。
- 定向回归：协调器与有序结构转换共 45 项通过；执行器语法检查通过。

## 复核与剩余工作

需求复核：使用一个全新恢复副本完整跨越所有现有结构阶段，没有借用已经完成的副本状态冒充全路径执行；保持原步骤 ID、SQL 和 checksum。

恢复复核：实例 UUID 与新库名固定，已有目标拒绝覆盖；备份字节和工具包验证后才 CREATE DATABASE。每次断连都重建连接并重新取得升级锁。失败副本保留，不自动 DROP 或重建。

还未完成全域数据转换、业务历史在新接口中可用、切换及开放 V4 写入后的恢复。当前只证明 29 步已实现结构阶段的真实升级和恢复；完整部署自动升级、旧表旧字段删除仍未交付。下一步将已演练协调器接入明确的开发库升级入口，并继续业务回填与语义对账。
