# 阶段 176：时区复验后执行隔离副本正常启动诊断

用户要求先验证时区，再做数据库。时区两组现场样本均支持 UTC+3，详见 ../stage-terminal-clock-chain.md；该结果不用于转换历史数据库时间。

原 MySQL 保持停止。当前配置无 include 指令，未发现 mysqld.my 组件清单；核对 lower_case_table_names=1 与 innodb_data_file_path=ibdata1:10M:autoextend。目录外表空间/密钥依赖仍未完全排除。

工作副本使用 /var/lib/aurum-mysql-recovery-20260907-01，以便 mysql 用户使用独立可遍历父目录，替代阶段175的候选路径。新建前检查不存在，空间大于两份源字节数加 2 GiB。复制数据目录的 1,763 个文件，逐文件 SHA-256 与已保全清单相符；复制前后原数据及配置摘要一致。原冷归档未改写。

先运行 systemd 隔离探针：mysql 用户可写副本、无法读取 /www/server/data、无法写 /etc。启动单元使用 ProtectSystem=strict、ProtectHome、PrivateTmp、PrivateNetwork、NoNewPrivileges、InaccessiblePaths 原数据目录、仅副本 ReadWritePaths、仅 AF_UNIX；不接入现有应用。mysqld 使用 --no-defaults，相同 8.4.8 二进制，独立 socket/pid/log，关闭 TCP/MySQL X/binlog/复制自动启动/事件调度；innodb_force_recovery=0，Restart=no，运行时间上限 120 秒。

首次 normal-01 因漏传已核对的 ibdata1:10M:autoextend，默认 12 MiB 与实际 10 MiB 不符，在恢复前退出。补齐该兼容参数后以 normal-02 执行；该修正不是提高恢复级别。

normal-02 在 2026-09-07T06:32:27Z 重现原异常：redo 扫描至 47993683210，checkpoint 为 47993683220，log0recv.cc:3974 断言。单元已终止，MainPID=0，ExecMainStatus=2；未自动重启。副本日志未出现原 check_sector_size 权限错误，说明不能仅通过修复该权限来解释当前恢复失败。

两次副本启动结束后，重新采集原数据和配置全部 1,764 个文件，大小、mtime、权限、uid/gid、SHA-256 与冷备前清单完全一致；私有 source-after-isolated-start.json 保存核验结果。

没有连接 SQL、执行迁移、回填或删除结构；没有启动原 MySQL，没有删除 redo/undo/ibdata1。副本失败日志保存于本机私有冷备目录 isolated-normal-start-logs.txt。下一步是副本的紧急只读导出诊断，须先确定允许的恢复级别；原始数据、已保存冷归档和历史 SQL 备份继续保留。正常启动失败不能推断全部数据已丢失，也不能称为恢复完成。
