# 既有 A/B 目标库补齐018–025的批准范围

本范围经用户在明确安装请求后回复“继续”批准，2026-09-06已执行并复核；见[执行报告](public-upgrade-u2-ab-install-report-20260906.md)及[机器证据](public-upgrade-u2-ab-install-result-20260906.json)。以下保留批准时的范围和前提。

目标仅为SSH `aurum-vm`（192.168.1.254）、MySQL UUID `ac423207-6ef3-11f1-b302-000c29fda104`上的`dev_vue_m1_a`和`dev_vue_m1_b`。依据[现场只读证据](public-upgrade-u2-live-observation-20260906.json)，两库已有bootstrap及001–017共18条完成记录，登记checksum与当前计划相同；源镜像`dev_vue_m1_source_20260905_01`、dev_vue、dev_xin及公网库不在写入范围。

| 文件编号 | SQL数/每库 | 变更 |
| --- | ---: | --- |
| 018 | 2 | users新增状态字段；新增user_referral_accounts |
| 019 | 4 | trading_accounts和trading_account_ownerships追加字段/约束；新增归属区间和用户账户设置表 |
| 020 | 2 | 新增投影来源表；account_trade_records_v4追加来源字段/约束 |
| 021 | 3 | 新增observer_sources；observer_channels和observer_channel_accesses追加字段/约束 |
| 022 | 3 | 新增observer_management_registry、observer_management_operations；插入registry控制行(id=1,revision=0) |
| 023 | 1 | bridge_connection_sessions移除旧route/epoch唯一索引，增加profile/epoch普通索引 |
| 024 | 1 | 新增bridge_v4_pairing_requests |
| 025 | 5 | 新增5张迁移run/checkpoint/batch/ID map/receipt表 |

合计每库21条计划语句：13个CREATE TABLE、7个ALTER TABLE、1个控制行INSERT；另由现有runner记录迁移状态、checksum及语句进度。不是业务数据回填；不重跑已完成bootstrap/001–017，不自动执行额外correction，不生成用户/设备/会话/队列任务。

操作前重新只读核对目标实例、物理结构、现有表约束与数据计数、迁移/correction记录，确认新增唯一键/FK前提；若状态漂移、存在与演练假设不符的业务数据或待恢复迁移则停止并报告，不清库或强行恢复。使用现有`runSchemaMigrations`受控runner及已提交SQL，逐库先A后B执行，仅准入这8份checksum绑定文件。语句不可整体事务回滚，中断时按已记录进度及实际结构判定，不盲重放DDL。

完成后核验两库完整迁移记录、物理字段/约束与既有数据计数，随后才设计025的受控事务测试；测试行写入/清理需要具体范围，不包含在本次安装许可内。业务回填、备份导出/恢复、配置切换、服务启动/部署及真实终端均不在此范围。

批准依据应明确上述两库和018–025；`AGENTS.md`第7节要求“未经用户明确授权，禁止执行DDL/DML、真实回填、切换读写、清理旧表或删除用户数据”。此前泛指“持续推进”未被当作安装许可；本次依据是在明确列明两库、21条语句和边界后，用户回复“继续”。该批准不扩大到真实业务回填或事务测试数据写入。
