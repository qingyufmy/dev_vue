# 阶段 178：恢复库自增水位修正及 binlog 线索核对

继续阶段177恢复核查，操作对象仅隔离验证库 /var/lib/aurum-mysql-recovery-verify-01/data，innodb_force_recovery=0。原实例、server/.env、其他数据库未改变。

## 自增水位

从故障前已验证 restored.sql 提取 97 张表的 AUTO_INCREMENT 记录，与阶段177干净恢复库 SHOW CREATE TABLE 比较，发现 13 张表回退：ai_feature_flags、ai_inference_preferences、ai_model_purpose_defaults、auto_scheduler、chan_structure_anchors、close_signal_tickets、history_range_preferences、market_candles、market_data_sources、membership_expiry_notifications、post_tags、signal_outcome_deals、system_config。

全部先核对恢复前水位，再在隔离验证库执行 13 条 ALTER TABLE AUTO_INCREMENT，仅提升到备份记录的已知水位。SQL 标识符与整数来自封闭核查清单；执行前验证实际 datadir 与 recovery=0，执行后 SHOW CREATE TABLE 逐项回读。未向已执行迁移文件追加恢复专用固定 ID，也未修改已安装迁移 checksum。

修正后全库数据摘要仍为 1eaddc12888b9cb96f088d944742be7fc7be0b14fec0392d0a97af1b0c2e61fd，与阶段177的 211 表、271,288 行一致。实际重启隔离验证实例后重新检查全部 97 张表，无低于历史水位者。只证明已记录历史水位保留，不声称证明未记录的分配/回滚水位。

检查过程中 information_schema.TABLES.AUTO_INCREMENT 与已记录 SHOW CREATE TABLE 数值不一致，初次保护检查在执行 ALTER 前中止；改用与基线一致的 SHOW CREATE TABLE 路径，先检查全部目标才执行。本次未据此修改业务数据或将较低统计值作为新的事实。

## binlog 只读检查

mysqlbinlog 对现存 mysql-bin.000048 至 000052 开启 checksum 验证，读取命令退出 0。基线后扫描从 source-after.json 的 2026-09-06T13:17:16.362Z 所在秒开始（向下取整，避免遗漏该秒），统一 TZ=UTC；最后可见事件时间为 2026-09-07 02:39:22 UTC。

该区间识别出的 dev_vue 语句包括：62 次升级记录 INSERT/UPDATE、2 个迁移 run、2 个 checkpoint 创建及6次推进、6个 batch、各46次映射/行回执/来源存证插入、21次 memberships、25次 user_referral_accounts 与25次 referral_credit_ledger 插入。数量与已恢复控制/业务行的规模相符；没有在该语句摘要中发现原始业务表 INSERT/UPDATE/DELETE。

限制：这是语句清单和数量线索，不是事务提交边界及每个 SQL 参数的逐项证明。现存 binlog 文件可校验不代表未记录操作不存在；该基线后摘要不包含 row-based 事件。最后一个文件另有行事件摘要，显示 dev_xin 的行情写入；不能用它概括此前所有文件。尚未执行 binlog 重放，不将此结果升级为完整提交一致性验收。

## 保存与当前状态

修正库以普通模式、single-transaction 重新导出，命令退出0。dev_vue-counter-repaired.sql 为 616,117,580 字节，SHA-256：795f12c7aeca97267a9f1b118365f027be0d3c0dd29e3634bdb474a5132e6d85。本机 D:/dev_codex/_private-recovery/mysql-20260907-01 已下载并校验；原始紧急导出仍保留，未覆盖。

同目录保存 counter-baseline-audit.json、counter-repair.json、counter-restart-check.json、counter-repaired-export.json、last-binlog-inventory.json、last-binlog-statements.json、post-baseline-binlog.json。归档及具体凭据不入 Git。

验证实例已停止，MainPID=0、inactive。下一步核对基线后全部事件类型、事务边界与控制记录内容，再确定开发库恢复/连接方案；不得把仅含 dev_vue 的恢复实例替换包含其他库的原 MySQL 实例。全域数据库规范化、自动升级和旧结构删除仍未完成。
