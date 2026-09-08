# 阶段189：全库复核与独立目标表升级

按用户最新目标回到数据库结构主线，暂停扩展页面/SSO。当前 dev_vue 已从64步升级到75步、从212表增加到222表。11条DDL包含10张新表及1条记忆库当前版本外键，没有生成业务任务、风险策略、配对请求、观摩初始化或记忆内容。

## 真实执行与数据保护

本地脚本连接 env 中的 192.168.31.254 MySQL 8.4.8，数据库 dev_vue，UUID `ac423207-6ef3-11f1-b302-000c29fda104`。恢复演练仅使用既有 `dev_vue_m1_source_20260907_02`，临时权限原样恢复，虚拟机未运行应用/Redis/Worker/Bridge。

新增表：ai_manual_analysis_cooldowns、outbox_events、global_risk_controls、strategy_memory_libraries_v4、strategy_memory_library_revisions_v4、strategy_memory_injection_logs_v4、trade_history_migration_checkpoints_v4、observer_management_registry、observer_management_operations、bridge_v4_pairing_requests。

追加SQL为 `inplace/025_independent_runtime_structures.sql`，定义逐语句绑定原目标迁移及真实SHOW CREATE。原64步checksum不变；复合外键保证记忆库当前版本属于同一库。参考建表成功后精确清理本轮空表，没有关闭外键检查或删除业务数据。

恢复演练逐DDL完成后注入异常，11次均识别为reconcile，不重做已完成DDL；重复apply为0DDL。当前库实际执行11条DDL，内部重复0DDL。升级前后211张既有业务表、271,337行的逐列摘要、完整结构和自增值一致。升级日志增加11行；当前总271,412行包含75条日志，新10表为空。后续独立只读进程重新验证完整75步checksum/结构，两次全库目录一致，原165表和原字段全部保留。

证据：[参考建表](dev-vue-independent-structure-reference-20260908.json)、[中断恢复](dev-vue-independent-structure-rehearsal-20260908.json)、[当前库升级](dev-vue-independent-structure-upgrade-20260908.json)、[剩余工作目录](dev-vue-structure-remaining-work-20260908.json)。完整元数据目录保存在私有恢复目录，公开目录记录其SHA-256，不含业务行正文。

## 剩余工作

当前222表、3,275列、781个索引、115个CHECK、99个外键。目标缺表由79降到69，外键列初筛已无独立缺表候选；这不代表所有结构整改完成。

- 69张目标表依赖账户、订阅、推理快照、模型任务四类根结构切换，或其下游。每表DDL来源、FK和实际阻断已列入机器目录；需结合构建表、ID映射及对应领域消费者验收，不能直接替换同名表。
- 6张现有目标同名表缺必需字段；43项类型差异中16项是旧DATETIME到DATETIME(3)，其余包括字符串容量、计数符号/精度和根ID差异。下一批继续真实数据预检、原默认值/NULL/自动更新时间保留及可独立升级判断，尚未修改这些列。
- 风险控制行需保留旧停机事实；观摩管理revision需与旧观摩事实迁移一致。两者不能按空库seed擅自初始化，随对应领域补齐，不宣称已可运行。
- 当前目录只反映应用账号可见的触发器、例程和事件；空列表不证明特权对象不存在。源字段转换、目标反向覆盖和查询计划仍需逐项收口。

完整边界和两轮复审见[结构收口方案](../database-structure-completion-plan-20260908.md)。需前后端配合的部分可延期，可独立实施的数据库整改持续推进。

## 验证与当前入口

54项迁移定向测试及补充2项类型比较回归通过，覆盖11个DDL各自中断恢复、重跑不执行、末端未记账表在任何写入前拒绝、历史checksum漂移拒绝、ENUM格式空格不误报。未运行无关前端构建或交易测试。

```powershell
node scripts/upgrade-independent-structure-local.mjs --check <新的绝对路径回执.json>
node scripts/upgrade-independent-structure-local.mjs --apply <新的绝对路径回执.json>
node scripts/review-database-standardization-local.mjs --read-only <新的绝对路径目录.json>
```

75步数据库使用上述入口。旧62/64步工具保留冻结语义，遇到新步骤会拒绝；后续领域回填必须适配完整75步并独立验证，不能重跑旧回填覆盖新业务。已完成恢复演练的库不重复运行要求“首次11DDL”的故障脚本，使用check或普通apply核对当前状态。没有部署公网或启用应用写入口，本阶段不是全域优化完成声明。
