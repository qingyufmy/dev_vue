# 阶段 179：基线加 binlog 独立重放与恢复库全量对账

沿阶段178继续核查故障前已记录的提交效果。全部写入仅发生在新建隔离实例 /var/lib/aurum-mysql-recovery-replay-01，原 MySQL 目录、其他数据库及开发连接配置未修改。

## 事务提取

逐个读取现存 mysql-bin.000048 至 000052 的事件头、长度、Query、XID、Table_map 和行事件，核对 CRC。格式描述事件清除 BINLOG_IN_USE 标志后校验 CRC；最初未处理该标志的检查在最后文件格式头失败，修正后全部通过，与此前 mysqlbinlog --verify-binlog-checksum 的结果一致。没有把解析失败当作源数据损坏，也没有跳过不匹配事件。

以备份 source-after.json 的 2026-09-06T13:17:16.362Z 所在秒为起点，目标 dev_vue 共 196 个完整事务或独立查询：133 个 XID 提交、63 个独立 DDL，合计 412 条查询事件（CREATE 46、ALTER 17、INSERT 281、UPDATE 68）。未发现跨越该边界的目标事务、未完成目标事务、目标行格式事件或起点之后的未支持事件类型。完整 SQL 与事务位置仅保存在私有证据中。

该清单说明现存日志中的目标事件范围，不证明关闭 binlog 或未记录的写入不存在。

## 独立重放

1. 再次验证故障前 restored.sql 的 SHA-256 为 9eebdd97aebf89b94c186bfbeda19dc7c028e672d3b27fae1ee4cf45e162bbee。
2. 初始化全新 MySQL 8.4.8，recovery=0，建立与备份一致的 dev_vue（utf8mb4 / utf8mb4_general_ci），导入原始备份，退出0。
3. 使用 MySQL 自带 mysqlbinlog，固定 --database=dev_vue、起点、TZ=UTC、checksum 校验及 --skip-gtids，保留事务边界和日志中的会话设置，生成重放 SQL。
4. 执行前确认 USE 只指向 dev_vue；写操作种类及数量与二进制事务清单完全一致，412 条原始 Query SQL 均包含于重放文件。未添加 --force、忽略重复或跳过失败语句。
5. 在新实例核对 datadir 和 recovery=0 后执行，mysql 客户端退出0。凭据仅为独立无网络验证实例的本地临时 root；原数据库不可访问、文件系统仅该副本可写。

## 对账结果

| 项目 | 独立重放结果与修正后的恢复库比较 |
| --- | --- |
| 表集合 | 211 表一致 |
| 全列、逐主键顺序数据摘要 | 271,288 行，全部一致 |
| 全表摘要目录 hash | 1eaddc12888b9cb96f088d944742be7fc7be0b14fec0392d0a97af1b0c2e61fd |
| 结构 | 项目既有 tableDefinitionHash 下全部一致 |
| 自增当前值 | 单独比较，全部一致，不依靠结构规范化忽略它们 |
| 升级记录 | id、checksum、status、started_at_utc、completed_at_utc 全部一致 |

现存日志中记录的基线后提交效果已通过独立重放验证，阶段177/178中的这一待验项获得补充证据。未记录写入仍不可由日志证明，报告保留 unloggedWritesVerified=false。

## 证据与后续

私有目录 D:/dev_codex/_private-recovery/mysql-20260907-01 保存 read-binlog-transactions.py、dev-vue-committed-events.json、dev_vue-replay.sql、replay-execution.json、replay-parity.json。完整事件与 SQL 不入 Git。

重放实例已正常停止，MainPID=0、inactive；所有恢复目录、原冷归档、原紧急导出和修正导出均保留。尚未启动正式开发数据库服务或修改 server/.env。

停止所有临时实例后，重新读取原始数据及配置全部 1,764 个文件，清单和 SHA-256 与冷备前完全一致，私有 source-after-replay.json 保存结果。

下一步采用独立 dev_vue 开发实例恢复连接，先核对端口、数据库账号权限及实例身份，再刷新该实例的迁移/备份证据并继续真实演练。不能用仅恢复 dev_vue 的目录覆盖包含其他库的原实例；旧实例问题仍单独保留。全域标准化、自动升级入口和旧结构清理仍需继续实施。

### 待确认的开发连接恢复范围

已核对 192.168.31.254 的 3307 无监听，当前 server/.env 为 MYSQL_HOST=192.168.31.254、MYSQL_PORT=3306、MYSQL_DATABASE=dev_vue、MYSQL_USER=dev_vue。拟建立独立 aurum-dev-vue-mysql.service，使用已重放核验的 /var/lib/aurum-mysql-recovery-replay-01/data，绑定该 VM 地址的 3307，recovery=0，禁用事件调度及复制自动启动。

启用网络前设置受保护的管理凭据；开发账号沿用本地 env 凭据，仅授权 dev_vue.* 并限制开发机来源。原 datadir 在服务沙箱内仍不可访问。启用后只将本地 MYSQL_PORT 改为3307，验证 TCP认证、数据库身份、211表/行摘要及62条升级记录；不启动网站、Worker或Bridge。失败则停止新服务并恢复本地端口配置，保留恢复数据。

上述网络服务和配置切换尚未执行；下一步确认的对象是这一具体范围，不是再次执行数据恢复或覆盖原实例。
