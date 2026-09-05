# M1 B1：加密备份与独立源镜像恢复演练

> 2026-09-05；用户已确认[上一轮精确范围](./stage-m1-b1-server-backup-readiness.md#5-待用户确认的精确执行范围)。实施中，真实结果尚待记录。

## 1. 执行边界

- 源库只读 `dev_vue`；新恢复库仅 `dev_vue_m1_source_20260905_01`。
- 新运行目录 `/www/backup/aurum-v4/m1/20260905-01`；新口令目录 `/root/.local/share/aurum-v4-backup-keys/m1-20260905-01`。
- 不改原库、A/B、现有目录权限、全局变量、授权、应用/PM2/环境配置；不接触 Bridge 或交易终端。
- 本轮目录、文件和新库只能首次创建。遇到既有目标、错误或漂移立即停止；没有覆盖、续跑、清空、删除模式。
- 无 DDL 窗口由已确认的执行条件提供；不加全局锁阻断同实例其它项目。前后完整结构指纹复核只能作为额外检测，不能证明期间绝无瞬时 DDL。

## 2. 执行工具

原 `verify-v4-backup.mjs` 继续只读。新的 `execute-v4-backup.mjs` 是独立、显式授权的 Linux 主机执行入口，不挂到应用启动。

1. source-only bundle 按白名单和 SHA-256 上传新私有目录；不改部署目录。新目录 0700、文件 0600，既有父目录权限不改。
2. 宝塔现有读取接口在内存取得当前 MySQL 凭据；两个匿名 memfd 分别传给 Node 和 MySQL 客户端。客户端只读这份 option file，禁止默认配置/login-path 覆盖。磁盘、argv、日志均不存数据库密码。
3. 核验 Unix socket 上的实例 UUID、精确 schema、8.4 同补丁客户端、对象类型与新库不存在。每阶段检查至少 10 GiB 可用，子进程运行期间每 5 秒复核。
4. 高熵随机口令 + 现有 GPG AES256；先以非敏感样本验证原字节往返与损坏密文失败。
5. `mysqldump → gzip → GPG` 受控管道；每段独立上限 4 GiB、超时、退出码和 hash。任何上游失败，即使下游成功也失败；不输出原始工具 stderr。
6. 完整解密并验证 GPG 完整性之后再解压。解压 SQL 与导出管道原始 SQL 大小/hash 必须一致。SQL 作用域审查完成前不建库、不导入。
7. 只创建新库，保留源 `utf8mb4_general_ci`；MySQL 二进制模式、禁止本地文件导入与断线重连；没有 `--force`。中断的 DDL/导入不自动重放。
8. 恢复后读取完整结构与精确 COUNT；再次按同参数导出镜像，对每张表全部有序单行完整 INSERT 的 hash 和行数比对。原有 DATETIME/JSON/金额/ID 不转换。

较预览参数增加 `--skip-disable-keys --column-statistics=0 --skip-extended-insert --order-by-primary --no-autocommit`：逐行显式列名便于内容对比，逐表事务避免每行独立提交，不导出统计直方图维护命令；不是业务回填器。参数含义以 [MySQL mysqldump 官方文档](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html) 为准。

MySQL `--binary-mode` 保留 CRLF/NUL 行为，并禁用大部分客户端命令，但 **charset/delimiter 仍须由审查器拒绝**；不能只依赖客户端开关。[MySQL 客户端选项](https://dev.mysql.com/doc/refman/8.4/en/mysql-command-options.html)

GPG 使用 `--batch --pinentry-mode loopback --passphrase-fd 3 --no-symkey-cache`，不放宽完整性错误处理。[GnuPG 口令与完整性选项](https://www.gnupg.org/documentation/manuals/gnupg/GPG-Esoteric-Options.html)

显式使用 S2K mode 3 / count 65011712，避免默认向 agent 查询派生成本；保持 `--no-autostart`，不启动或干预其它 agent。[GnuPG S2K 选项](https://gnupg.org/documentation/manuals/gnupg-devel/OpenPGP-Options.html)

## 3. 两轮实施复审

第一轮（职责/复杂度）：复用现有 MySQL/GPG/gzip 和元数据工具，无新服务、数据库账号或运行依赖。备份、原结构恢复、V4 字段转换保持分离。不拿原库前后计数冒充 dump 快照；通过原 dump 与镜像重导出建立内容证据。

第二轮（安全/异常）：源 SQL 必须经过词法/语句白名单，拒绝跨库目标、活动例程/事件、客户端命令及任意表达式型 INSERT。凭据只走匿名文件描述符；完整性验证先于导入；失败保留原始产物，创建状态不确定时报告“可能存在”，不删除重试。哈希依赖本机可信执行环境，不声称抵御已控制 root 的攻击者。

代码复核补充：关闭了版本注释隐藏语句、无 AS 的 CREATE SELECT、反引号函数和索引表达式的绕过；补齐 mysqldump 字符集保存/恢复、DATETIME(3)、带括号的注释、空二进制字面量和双括号 CHECK。子进程不能因最后一段成功而掩盖上游失败；文件写入覆盖和未完成流关闭也有回归测试。

## 4. 尚未跨越的边界

- 同机加密备份和单独口令目录不是异机容灾；异机副本尚未授权。
- 原始恢复内容一致不等于 V4 业务语义/权限/用户可用性迁移成功；A/B 本轮不回填。
- 镜像通过不修改应用连接的方式保持隔离，未创建专用只读账号/GRANT。未来读取工具仍须强制只读事务。
- 所有原始 SQL、密文、口令及含敏感内容的产物只留受限服务器目录；Git 只保存工具、测试与脱敏验收报告。

## 5. 验证与现场结果

本地定向加既有迁移回归：**15 files / 115 tests 通过**。包括 SQL 作用域、执行参数/计数内容对比、新旧 CLI、进程管道、预检、文件 hash、迁移执行/纠正/恢复与交易历史聚合对账。

10 MiB 非敏感正文流审查样本约 2.36 秒；它是本机性能样本，不是服务器全量吞吐承诺。新增 MJS 语法检查、Python AST 语法检查和 `git diff --check` 通过。没有修改应用源码/合同/前端，未将全前端构建或真实业务联调列为本轮证据。

服务器加密备份、SQL 审查、建库、导入和内容校验仍待下方实际结果记录，不预填成功。
