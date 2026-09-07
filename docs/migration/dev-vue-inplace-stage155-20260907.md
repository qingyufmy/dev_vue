# 阶段 155：统一配置编排的真实 MySQL 验证

在恢复镜像 dev_vue_m1_source_20260907_02 使用 createSettingsMigration 的 apply/recover/verify 编排，验证阶段 154 的真实数据库返回格式及状态处理。开发库 dev_vue 未写入。

## 观察结果

- 两项既有七牛来源经固定密文计划转换；时间与加密密钥明确为演练用途。
- apply 首批真实 COMMIT 后丢失响应，停止并返回 commit_unknown。
- 从磁盘重新加载计划并重建编排。recover 确认第一批已提交、第二批 not_committed，立即返回且七类计数不变；没有自动补写第二批。
- 再次 apply 时注入第二批来源存证失败，整批回滚。随后正常 apply 完成两批并执行统一编排内的独立审计。
- 重复 apply 不增加计数；全部已提交后的 recover 与 verify 都返回 verified。真实 SQL 返回的来源时间与十五目标列成功通过审计。
- 另外复核原有映射、receipt、checkpoint 和保护存证恢复。按运行 ID ffffffff-ffff-4fff-8fff-ffffffffff33 清理测试记录后，目标/maps/receipts/sources/batches/checkpoints/runs 全为 0。密文计划已删除。

前后原始 271,007 行、原表结构和此前新增表数据摘要一致。未修改 system_config 源值，未部署或重启服务。

## 证据与范围

回执 dev-vue-settings-unified-backfill-rehearsal-20260907.json，SHA-256 f436e76d1363ef4157d6567cd85db5ed5f8020179a715e9b55f0396bc9ec312b。215 项工具摘要在远端与本地均核对通过。证据目录 /www/backup/aurum-v4/m1/20260906-01/settings-unified-backfill-rehearsal-01。

CLI 改为校验这份统一编排证据、部分恢复不写入和完整恢复/审计标志，保留旧回执。语法检查通过；底层编排代码本轮没有修改。

此次是 CLI 所调用编排的真实凭据分支验证；没有用真实审批清单从 CLI 命令行执行整条链，也未验证普通配置分支的新编排实库路径。不能把本结果表述为全部配置已回填或自动升级已完成。实际历史时间依据、统一清单生成及其准入仍待完成。

定向复核：故障发生在实际批次提交之后而非只在 prepare 阶段；部分恢复状态和计数单独验证，不用低层单批成功替代全运行成功。清理后再次核对原数据与新增表基线。下一步处理统一入口清单预检/生成和其余数据库领域的规范化覆盖。
