# 阶段193：默认值和机器摘要比较规则

当前 dev_vue 已从114步升级到131步，仍222表。16项默认值按冻结V4目标规范化；bridge_refresh_sessions.token_hash 改为 ascii_bin，摘要值和唯一索引保留。已有模型状态、额度、用量、时间均未重写。

恢复副本17次DDL后异常全部恢复记账，重复执行0DDL，临时权限恢复。当前开发库执行17条DDL，内部重复0DDL；两次升级均逐表保护所有221张业务表的原值、其它结构和自增值。当前271,337行业务数据保持，总271,468行包含131条升级日志。独立只读进程再次核验131步及两次完整目录相等，原165张表和原字段全部保留。

67项相关迁移与字段比较测试通过，覆盖17个新步骤逐点中断恢复、历史checksum和属性保留。实际MySQL演练与开发库结果见下方冻结回执。删除ENUM显式默认不代表遗漏字段一定报错：业务入口仍须显式提供并校验scope等字段；现有V4用量writer显式写入凭据来源、请求阶段和状态。

补做VM本机特权只读查询，当前dev_vue的触发器、视图、例程、事件均为0，两次查询一致。该结果只证明观测时对象目录，无权限修改或业务写入。

证据：[预检](dev-vue-default-normalization-source-20260908.json)、[恢复演练](dev-vue-default-normalization-rehearsal-20260908.json)、[开发库升级](dev-vue-default-normalization-upgrade-20260908.json)、[特权对象检查](dev-vue-database-objects-review-20260908.json)、[剩余目录v5](dev-vue-structure-remaining-work-20260908-v5.json)。两轮复审见[方案](../database-default-normalization-plan-20260908.md)。

## 下一批范围

当前11项类型、1项可空性、6项默认、36项排序差异，另有6张同名表缺列及69张根实体依赖缺表。两个users毫秒UTC默认保留；其余4项默认属于账户/行情/任务合同。人类文本排序不能为了匹配旧unicode_ci目标机械降级；账户标识、机器键、密文等须分别检查比较和唯一性语义。

字段比较不覆盖CHECK和索引。已发现模型归属及平台额度单例两个目标CHECK尚未安装，下一批应先核对现有数据和消费者，再做独立恢复演练。源字段转换、目标反向覆盖及查询计划也未全量完成，整体目标继续进行中。

## 当前入口

```powershell
node scripts/upgrade-default-normalization-local.mjs --check <新绝对路径回执.json>
node scripts/upgrade-default-normalization-local.mjs --apply <新绝对路径回执.json>
node scripts/review-database-standardization-local.mjs --read-only <新绝对路径目录.json>
node scripts/review-database-type-data-local.mjs --read-only <绝对路径剩余目录v5.json> <新绝对路径回执.json>
```

旧SQL与历史回执不改。未启动应用、Redis、Bridge或模型调用，未部署公网。
