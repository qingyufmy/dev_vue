# 桥接安装授权独立参考库验收

授权：用户在“允许创建独立参考库验证迁移，暂不修改现有业务库”的确认后回复“可以”。本轮只执行该范围。

## 结果

- 实际 MySQL 身份、源结构和 267 步历史与 079 证明一致，才允许创建参考库。
- 源连接强制 `SET SESSION TRANSACTION READ ONLY`，仅读取结构与升级记录。管理连接无默认业务库，只创建/删除已确认不存在、由本次随机生成名称的参考库。
- 在参考库执行 080 四条 DDL，记录真实 `SHOW CREATE TABLE` 和每一步完整 schema hash：315 → 318 表。
- 在另一份参考库逐条模拟 DDL 已生效但确认丢失，四次均恢复，最终 271 步；重跑无新 DDL，旧 267 步 checksum 不变。第二连接无法取得同一迁移锁。
- 空库 bootstrap + 001–028 使用仓库既有、校验和绑定的 011 外键修正链。三张新表完整哈希和 refresh 扩展结构与 inplace 一致。
- 真实 repository 使用 2 个合成用户、8 个请求、5 份授权、5 个档案完成并发与恢复测试；4 次真正 commit 后模拟丢确认均按原键恢复。数据库只保存测试凭据哈希。
- 三份成功尝试参考库均已删除；之前两次失败尝试的参考库也均已删除。原库 schema 和迁移 journal 前后相同。

机器证明：[bridge-installation-reference-v1-20260914.json](architecture/bridge-installation-reference-v1-20260914.json)。不含凭据及真实用户数据。原库业务行未做全量指纹比较，不宣称完成业务数据迁移对账。

## 遇到的问题

第一次尝试已记录四条结构转换，但参考库迁移锁名称超过 MySQL 64 字节限制；改为与随机参考库标识绑定的短锁后继续。第二次尝试通过四次 DDL 恢复，在空库路径遇到旧 011 外键重名；验证脚本改用已有 `loadMigrationCorrections()`，未改历史 SQL。第三次完整通过，失败报告保留在 `D:\dev_codex\.local-runtime\bridge-installation-reference-attempt{1,2}-20260914.json`。

## 代码与离线验证

新 `bridge-installation-upgrade.mjs` 使用真实证明追加 080；不改变旧 steps 对象与 checksum。Bridge、Trading、Execution 的生成门禁随之更新。API 和 Gateway 在监听前检查完整 journal 和本模块四张表的哈希。

证明组合/来源 3 项测试、授权及门禁 26 项测试通过；完整服务端类型检查包含三份生成物一致性检查。门禁缺表、错 checksum、锁名等异常测试为 Fake，和真实参考库事务证据分开记录。

重现入口：`python scripts/run-bridge-installation-reference-local.py <新的绝对报告路径>`。该脚本先在 `bridge/.test-artifacts/installation-reference` 隔离编译 repository，再通过短期 SSH 隧道把数据库凭据以 stdin 交给 Node；不打印凭据，不覆盖运行中的 `server/dist-v4`。入口固定验证原 MySQL 身份与 079 起点，业务库升级以后不能继续将此入口当作任意迁移工具。

上述独立参考库验收本身没有使用真实 MT 终端、发交易、升级业务库、重启或部署。后续用户授权的业务库升级及本地重启已完成，包含默认排序规则纠正与最终 272 条记录，见 `bridge-installation-current-migration-20260914.md`；不要把早期 271 条参考库证明与后续运行结果混为一谈。
