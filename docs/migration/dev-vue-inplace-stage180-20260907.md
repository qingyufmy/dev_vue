# 阶段180：原 MySQL 实例恢复并启动

2026-09-07，用户明确授权修复虚拟机 MySQL 并启动数据库，沿用原数据库连接。阶段179提出的独立3307实例方案取消。

## 结果

原 `mysqld` 服务已恢复到 `/www/server/data`、3306、MySQL 8.4.8；`innodb_force_recovery=0`、`read_only=0`、`super_read_only=0`。实例 UUID、12个账号及原密码、权限、TLS/RSA文件均保留。本地 `server/.env` 未修改，实际认证、211表及62条完成的升级记录检查通过。

9个业务及验证库共1,586张表、1,633,674行，与隔离恢复源逐表全列数据摘要和结构核对一致：

| 数据库 | 表 | 行 |
| --- | ---: | ---: |
| dev_vue | 211 | 271288 |
| dev_vue_m1_a | 131 | 40 |
| dev_vue_m1_b | 115 | 34 |
| dev_vue_m1_source_20260905_01 | 165 | 271007 |
| dev_vue_m1_source_20260906_01 | 185 | 271036 |
| dev_vue_m1_source_20260907_02 | 211 | 271288 |
| dev_xiang | 37 | 108 |
| dev_xin | 165 | 293112 |
| huaerjie | 366 | 255761 |

另核对 mysql 系统库34表、3,787行以及 sys_config 的6行。视图、存储过程、触发器和事件定义分别一致。mysql 的两张 InnoDB统计表由新实例重建，未复制优化器统计；general_log、slow_log源表均为空。sys恢复时发现自带触发器重复，改为仅恢复配置数据，随后独立核对触发器定义一致。

## 恢复过程与保全

- 从已授权的 force-recovery=6 隔离副本导出全部业务库和系统数据；没有使用跳过错误的导入参数。11份压缩导出已复制到本机，解压后的SQL大小和SHA-256全部核验。
- 在离线新目录正常初始化、恢复并对账，随后保留阶段178已证明的13个 dev_vue 自增历史水位。
- 切换前原文件内容摘要全部一致。发现 `/etc/my.cnf` 权限从冷备时的0600变为0644，内容未变；恢复0600后，全部1,764文件清单与冷备基线一致。
- 原故障目录完整保留为 `/www/server/data-failed-20260907`，通过同文件系统目录改名切换；没有删除原始redo/undo。现存5份binlog复制保留，新索引只列实际存在的文件；原索引及故障文件仍在保全目录。
- 首次启动保持只读，全部表计数及13个自增水位再次核对。之后恢复读写并正常重启，完成独立临时测试表的持久写入、读取和删除。
- 原始冷归档SHA-256再次核验为 `e8752c476d253f2822624d56edf70d9f74c399b0825cb9537c651c5fd82655d5`。只清理了此前生成、已停止且失败的第一份隔离工作副本；原目录、force6副本、独立重放副本和备份保留。

## 启动错误修复

原启动失败的直接原因是 InnoDB redo/checkpoint 恢复断言。通过逻辑恢复到正常数据目录解决，未把强制恢复模式作为运行配置。

正常启动后另外处理了 `check_sector_size` 权限错误：`innodb_data_home_dir` 原值缺少末尾 `/`，MySQL 8.4.8该检测函数截取最后一个路径分隔符之前的部分，导致尝试在 `/www/server` 创建检测文件。仅为该配置补上末尾 `/`，实际数据目录不变，没有扩大父目录权限。[MySQL 8.4.8源码](https://github.com/mysql/mysql-server/blob/mysql-8.4.8/storage/innobase/os/os0file.cc#L5787)

修正后再次正常重启，新增启动日志没有 ERROR；最终配置SHA-256为 `8c54b4beeee661e5790bdcf32f18fabc842c0297a0e9f17efc12203ee9700652`。旧参数弃用、包大小上限和自签CA警告不属于本次启动故障，未顺带改动。

## 证据范围与下一步

私有证据保存在 `D:/dev_codex/_private-recovery/mysql-20260907-01`：full-export、full-parity.json、full-objects-parity.json、original-service-parity.json、full-cutover.json、mysql-repair-complete.json、sector-check-fix.json等。账号数据、SQL、完整清单不入Git。

全实例对账证明恢复库与可读取的隔离恢复源一致；dev_vue另有阶段179的历史备份加binlog独立重放证明。其他库未逐一完成这种独立历史重放，不能扩大为对所有未记录写入的证明。原始文件保留供后续核查。

本次完成数据库服务恢复，未启动网站、Worker或Bridge，未实施新的业务迁移。数据库全面规范化仍继续按既有方案推进，下一步恢复 learning 真实数据库演练并刷新实例证据。
