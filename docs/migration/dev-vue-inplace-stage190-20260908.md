# 阶段190：现有目标表UTC毫秒精度升级

当前 dev_vue 已从75步升级至91步，表数仍为222。6张现有目标表的16个旧DATETIME字段已提升到DATETIME(3)，没有给旧时间加减时区，没有修改旧值、NULL或引入自动更新时间。

## 范围与真实验证

变更字段见[精度升级方案及两轮复审](../database-temporal-precision-plan-20260908.md)。追加 `inplace/026_utc_datetime_precision.sql`，保留前75步checksum。users.created_at/updated_at 保留实际可空能力，原DEFAULT(now())改为毫秒now(3)；不借类型升级补假时间或强制NOT NULL。其它默认值原样保留。

第一轮真实预检覆盖43项类型差异：数值列无负数，16个时间列无零年/月/日。恢复副本实际完成16条ALTER，每条之后注入中断，全部通过reconcile且无重复ALTER。当前dev_vue应用同批16步，内部重复0DDL。两库临时权限恢复；全过程服务和脚本在本地，虚拟机仅MySQL。

前后保护221张既有业务表，当前库271,337行业务数据一致；总271,428行包含91条升级日志。时间字段以六位微秒DATE_FORMAT参与逐列摘要比较，保留NULL，既解决驱动返回字符串格式差异，也不掩盖任何时间数值变化。结构比对只允许经审查的16行精度/默认表达式变化，全部其它定义和自增值不变。

证据：[43字段预检](dev-vue-type-data-review-20260908.json)、[恢复演练](dev-vue-temporal-precision-rehearsal-20260908.json)、[当前库升级](dev-vue-temporal-precision-upgrade-20260908.json)、[升级后剩余目录v2](dev-vue-structure-remaining-work-20260908-v2.json)。SQL在恢复副本执行后保持不变。

## 当前待办

新的独立只读进程确认91步结构与checksum，两次全库目录一致。当前222表、3,275列、781索引、115个CHECK、99个外键。原165表及原字段保留。类型差异从43降到27；27项再次真实聚合预检无负数，但不因此批准主键重映射、状态收窄或所有权转换。剩余69张依赖缺表、6张同名表缺列仍待对应领域接续。

下一批继续检查字符串容量、计数精度与符号字段中可独立升级的部分；主键、策略归属、状态和快照引用先有业务映射。源字段全量处置、反向目标覆盖和查询/索引审核仍未完全收口，不能宣称数据库优化已完成。

## 工具与验证

33项相关测试通过，其中19项时间精度回归覆盖16条ALTER各自中断续接、重复0DDL、默认值/NULL冲突阻断，以及结构兼容比较不吞掉其它字段变化。更新后的只读目录和类型预检也在当前91步库实际执行通过。

```powershell
node scripts/upgrade-temporal-precision-local.mjs --check <新的绝对路径回执.json>
node scripts/upgrade-temporal-precision-local.mjs --apply <新的绝对路径回执.json>
node scripts/review-database-standardization-local.mjs --read-only <新的绝对路径目录.json>
node scripts/review-database-type-data-local.mjs --read-only <绝对路径剩余目录v2.json> <新的绝对路径回执.json>
```

91步库使用上述入口；旧62/64/75步CLI作为历史工具保留，遇到更高版本会拒绝。旧回填的结构与来源格式必须经当前版本适配，不能绕过旧校验重跑。没有部署公网、启动应用/Redis/Bridge或执行交易。
