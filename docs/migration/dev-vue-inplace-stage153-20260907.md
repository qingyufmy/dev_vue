# 阶段 153：凭据完整回填的真实事务与恢复演练

在 aurum-vm 的恢复镜像 dev_vue_m1_source_20260907_02 执行新凭据回填链路。目标身份先通过 58 步适配器和原备份 UUID 校验；全程持有独立升级锁，原始结构/行摘要与此前新增目标表数据在前后分别核对。

选用镜像 system_config 的两项既有七牛旧文本。时间规则明确标为 synthetic，仅用于事务演练，不作为历史 UTC+8 的事实证明。加密使用临时随机测试密钥，未调用供应商或读取运行密钥。计划独占写入隔离演练目录，恢复时提供已固定 checksum。

## 真实观察

1. 创建迁移运行和 checkpoint；第一批实际 COMMIT 后注入响应丢失并销毁连接。runner 返回 backfill_commit_unknown。
2. 从磁盘重新加载凭据计划，未提供活动加密版本；重新构造批次后 transformHash 与绑定值一致。恢复查询确认 committed，verify-only 回读目标通过。
3. 第二批在目标写入之后注入来源存证失败；事务回滚，目标、映射、receipt、source、batch、checkpoint 和 run 计数与失败前一致。
4. 正常执行第二批，得到目标/映射/receipt/source/batch 各 2，checkpoint/run 各 1。重复两批后计数不变。
5. 实际回读全部十五目标列、ID map、receipt、checkpoint 与保护存证，独立审计差异为零，并能从保护存证恢复原八字段。
6. 仅按本次 runId ffffffff-ffff-4fff-8fff-ffffffffff32 和来源 ID 删除测试目标及本次迁移记录；最终七类计数全部为 0。删除本次临时密文计划并清零内存测试密钥。

原始 271,007 行及原表结构复核通过，此前新增目标表数据摘要与演练前一致。当前 dev_vue 未写入，原 system_config 未改写。未部署、重启、切换消费者或执行旧结构删除。

## 证据

回执：dev-vue-settings-credential-backfill-rehearsal-20260907.json。

SHA-256：876ab4d02bdfe35719c7bdc64622fe5927424cf38bb8a0a3f857efe0b74843e9。

212 个工具/依赖文件摘要在远端运行前验证，取回回执后再次与当前源文件核对一致。远端证据目录为 /www/backup/aurum-v4/m1/20260906-01/settings-credential-backfill-rehearsal-01。host 脚本语法检查通过，实际执行输出 verified。

定向复核：回执只含摘要、身份、计数和验证状态；不含凭据、测试密钥或密文计划正文。恢复证明覆盖真实数据库提交响应丢失和重新加载计划，不证明操作系统断电、异机密钥恢复或整个服务重启。fixture 时间不解除真实回填时间门。

下一步是把该已演练链路纳入实际配置迁移的统一入口与准入清单，并继续其它领域的转换/升级覆盖。全域自动升级及旧结构清理尚未完成。
