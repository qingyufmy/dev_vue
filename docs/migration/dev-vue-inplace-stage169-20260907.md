# 阶段 169：MySQL 启动故障只读诊断与备份复核

2026-09-07 在 aurum-vm（192.168.31.254）执行只读检查。SSH 正常；没有 mysqld 进程或 /tmp/mysql.sock。systemd 的 mysqld.service 为 active/exited、ExecMainStatus=0，仅表示启动包装脚本已退出，不能据此声称数据库正在运行。

## 当前故障证据

/www/server/data/debian.err 的 2026-09-07T05:12:09Z 记录包括：

- MY-012655：创建 check sector 文件失败，errno 13。
- MY-012562：扫描日志到 LSN 47993683210，而检查点为 47993683220；日志提示数据库可能损坏。
- MY-013183：InnoDB 在 log0recv.cc:3974 断言失败，启动崩溃。

没有发现配置中的显式 bind-address；客户端地址已经更新。不能将本次启动失败归为 IP 绑定问题，也不能仅凭该日志认定损坏范围或直接选择强制恢复等级。

/www 剩余约 29 GiB；/www/server 为 root:root 755，data 为 mysql:mysql 755；检查时没有 /www/server/check_sector_size 文件。未修改权限、redo 文件或任何数据库文件。

## 数据目录与备份

auto.cnf 中 server UUID 仍为 ac423207-6ef3-11f1-b302-000c29fda104。dev_vue 与 dev_vue_m1_source_20260907_02 数据目录各有 211 个 .ibd 文件，均包含四张学习表及 database_upgrade_steps_v4 文件。文件存在不等于表可读、行数一致或 62 步日志已重新验收；MySQL 当前无法查询。

再次计算 /www/backup/aurum-v4/m1/20260906-01/artifacts/restored.sql：

- 大小 682966225 字节。
- SHA-256 9eebdd97aebf89b94c186bfbeda19dc7c028e672d3b27fae1ee4cf45e162bbee，与既有备份验收值一致。

这证明该历史备份文件未变化，不证明它覆盖故障前全部最新数据、迁移控制记录或后来写入。不能用历史备份直接覆盖当前数据目录并宣称无损。

## 后续边界

已向用户询问更换 IP 前后是否恢复虚拟机快照或复制/替换过 MySQL 数据目录，目前尚无回复。恢复方案需结合该信息，并先保留当前数据与日志的可验证副本；本轮没有执行恢复、导入、删除 redo、权限修改或服务启动/重启。

真实迁移探针和写入演练继续保持待验收。此前 62 步及行数属于故障前证据；服务恢复后必须重新核对 UUID、结构日志、来源与目标数据，不能直接沿用为当前健康证明。全库规范化目标未完成，本次推进是发现实际阻断原因并核实可用历史备份，而非数据库升级成功。
