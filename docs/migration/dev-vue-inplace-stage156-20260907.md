# 阶段 156：审核依据生成固定迁移清单

新增 prepare-dev-vue-settings.mjs 和 v4-settings-manifest.mjs。生成器从实际 dev_vue 只读一致性快照读取指定来源 ID，核对备份 UUID 与 58 步结构，复用普通/凭据转换推导 snapshotHash、transformHash、stream 和 manifestHash。输出在事务结束后独占创建，不写数据库。

命令：`node scripts/prepare-dev-vue-settings.mjs --write <reviewed-basis.json> <manifest.json>`。

reviewed-basis 顶层精确为 kind/sourceIds/options/logicalSourceId/mirrorDatabase/admission/batchSize/credentialPlanPath。options 使用已有 run、逐字段 basis 和 evidenceCatalog 二元数组；凭据另需 expectedPlanChecksum，既有计划相对输入文件解析，输出时重算相对输出文件的路径。生成器不创建新的凭据计划，不生成时间偏移、语义证据或批准标志。

生成结果可交给 `migrate-dev-vue-settings.mjs --check`，通过后按已授权范围 apply/recover/verify。整个清单 hash 由统一入口同一函数计算；只有自身 manifestHash 字段以 null 参与，避免自引用。

凭据清单只含计划路径和预期摘要，不包含 keyring、密文计划正文或原凭据；其它 options 未知字段拒绝。证据登记表也验证标识和 SHA-256 形状。已有同内容清单可重复读取；已有冲突或部分文件不会被覆盖。

## 验证与复核

11 项清单/统一编排测试通过；新 CLI 语法和 --help 通过。覆盖普通清单确定生成并被入口接受、凭据数据不序列化、缺失证据/时间偏移/准入拒绝、未知字段和计划摘要不符拒绝、文件重复及冲突不覆盖。文件测试临时目录清理完成。

第一轮复核：取消操作者手算摘要，不把生成清单视作审批，不用默认时区填补历史。第二轮复核：生成与执行均绑定来源与转换，来源变动会使执行预检失败；只读快照不是停写证明，最终切换仍需写入边界控制。私有输出目录权限、凭据计划备份由升级流程负责，不宣称命令已经验证这些外部条件。

本次没有生成冒充获准的真实配置清单，也未执行数据库写入。当前历史时间依据仍待补齐；生成器完整实库命令及 CLI 执行链尚需验收。下一步继续实际依据与全域覆盖工作；自动全库升级及旧结构删除未完成。
