# 阶段 176：时区复验后执行隔离副本正常启动诊断

用户要求先验证时区，再做数据库。时区两组现场样本均支持 UTC+3，详见 ../stage-terminal-clock-chain.md；该结果不用于转换历史数据库时间。

原 MySQL 保持停止。当前配置无 include 指令，未发现 mysqld.my 组件清单；核对 lower_case_table_names=1 与 innodb_data_file_path=ibdata1:10M:autoextend。目录外表空间/密钥依赖仍未完全排除。

工作副本使用 /var/lib/aurum-mysql-recovery-20260907-01，以便 mysql 用户使用独立可遍历父目录，替代阶段175的候选路径。新建前检查不存在，空间大于两份源字节数加 2 GiB。复制数据目录的 1,763 个文件，逐文件 SHA-256 与已保全清单相符；复制前后原数据及配置摘要一致。原冷归档未改写。

先运行 systemd 隔离探针：mysql 用户可写副本、无法读取 /www/server/data、无法写 /etc。启动单元使用 ProtectSystem=strict、ProtectHome、PrivateTmp、PrivateNetwork、NoNewPrivileges、InaccessiblePaths 原数据目录、仅副本 ReadWritePaths、仅 AF_UNIX；不接入现有应用。mysqld 使用 --no-defaults，相同 8.4.8 二进制，独立 socket/pid/log，关闭 TCP/MySQL X/binlog/复制自动启动/事件调度；innodb_force_recovery=0，Restart=no，运行时间上限 120 秒。

首次 normal-01 因漏传已核对的 ibdata1:10M:autoextend，默认 12 MiB 与实际 10 MiB 不符，在恢复前退出。补齐该兼容参数后以 normal-02 执行；该修正不是提高恢复级别。

normal-02 在 2026-09-07T06:32:27Z 重现原异常：redo 扫描至 47993683210，checkpoint 为 47993683220，log0recv.cc:3974 断言。单元已终止，MainPID=0，ExecMainStatus=2；未自动重启。副本日志未出现原 check_sector_size 权限错误，说明不能仅通过修复该权限来解释当前恢复失败。

两次副本启动结束后，重新采集原数据和配置全部 1,764 个文件，大小、mtime、权限、uid/gid、SHA-256 与冷备前清单完全一致；私有 source-after-isolated-start.json 保存核验结果。

没有连接 SQL、执行迁移、回填或删除结构；没有启动原 MySQL，没有删除 redo/undo/ibdata1。副本失败日志保存于本机私有冷备目录 isolated-normal-start-logs.txt。下一步是副本的紧急只读导出诊断，须先确定允许的恢复级别；原始数据、已保存冷归档和历史 SQL 备份继续保留。正常启动失败不能推断全部数据已丢失，也不能称为恢复完成。

## 经确认执行最低恢复级别

用户随后确认继续，范围为副本 innodb_force_recovery=1，失败停止、不自动提高级别。沿用同一隔离配置，额外启用 super_read_only，关闭自动重启，单元最长运行 300 秒。2026-09-07T06:41:02Z，aurum-mysql-recovery-force1-01 仍因相同 LSN/检查点异常与 log0recv.cc:3974 断言退出，MainPID=0、ExecMainStatus=2。没有形成 SQL 连接或导出产物。日志保存于本机私有目录 isolated-force1-start-log.txt。

退出后重新读取原始数据和配置的 1,764 个文件，清单及全部 SHA-256 与保全前一致；source-after-force1.json 保存该证据。

后续可评估在重新生成的工作副本上逐级尝试 2–6，任一级能够启动即停止提高并尝试只读导出，失败保留日志。每次都从保全源重建工作副本，不把上一级可能改变的文件当作新基线；空间不足则先停止，不覆盖原数据或冷归档。该范围尚未执行，也不包含修复原实例或切换应用。

官方定义：2 停止后台处理，3 跳过事务回滚，4 跳过插入缓冲合并，5 跳过 undo 扫描，6 跳过 redo 前滚。4 及以上可能永久破坏被操作的副本文件，5/6 的可读结果也不能代表完整已提交事实。所有导出均需与历史备份、迁移回执和业务不变量独立核对，不能据此直接宣布无损恢复。[MySQL 8.4 强制恢复说明](https://dev.mysql.com/doc/refman/8.4/en/forcing-innodb-recovery.html)
