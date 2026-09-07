# 阶段 152：凭据专用行转换、保护存证与独立对账

已追加凭据专用 rows/writer/backfill/source/audit 模块，复用现有事务 runner 和 58 步 repository。原普通配置模块、已执行 SQL 和历史 proof 均保留。

转换使用 settings-credential-import/v1 依据，强制固定 expectedPlanChecksum，计划绑定 runId 和完整来源集合摘要；每行格式决策与 semantic_review/credential_plan_authenticated 证据必须匹配。保留原 ID、标签、排序、原始行摘要及独立时间规则，目标值来自已认证冻结密文，类型 credential、敏感度 secret。

Writer 在当前事务锁定 system_config 来源行，并与封闭保存的原八字段比较。目标只插入不存在的行；全十五字段相同才接受重复；任一字段冲突均拒绝覆盖。来源原文仅保留在 writer 内部比对状态，不进入可序列化批次。

来源存证使用 settings-credential-source/v1。旧文本以冻结密文及 encrypted_plaintext 编码保存，已有密文原字节保留，空值明确 empty；附原始行摘要、计划 checksum、时间与语义依据。批次和 source_payload_json 均不新增原文明文凭据。源库既有旧文本尚未修改，不声称数据库原有明文已清理。

独立恢复 API 使用 AES-GCM 认证解密，还原原八字段并核对原始行摘要；返回值仅允许在迁移进程内使用。Audit 不调用 rows 或 writer，独立计算目标元数据/时间，逐字段比较十五列、存证内容，并执行来源恢复验证。其计划认证与转换共享凭据协议校验，不宣称所有逻辑完全独立实现。

## 验证与定向复核

42 项定向测试通过：凭据计划/转换、目标 writer、批次来源存证、独立审计和原事务 runner。新增验证包括批次及存证不含原凭据、源漂移拒绝、十五目标字段冲突不覆盖、verify-only 不插入、错误回读、插入响应未知不重放、同事务存证、存证错误回滚、独立还原原八字段、错误密钥/来源摘要拒绝。

第一轮检查来源与目标分离：不能把受保护存证冒充原八字段字节；sourceHash 始终绑定原行，encoding 表明恢复方法；writer 原文比较封闭在内部。

第二轮检查并发与恢复：保留固定来源锁和目标锁顺序、原事务 receipt/checkpoint 行为，转换计划必须预先固定；未更改或绕过 58 步结构验证。原 runner 回归通过并不等于本批凭据真实事务已演练。

本批尚未对数据库执行 DDL/DML。下一步在已授权恢复镜像运行凭据专用完整事务，验证真实提交响应丢失、从持久化计划恢复、存证失败回滚及独立对账，再删除本批精确标识的演练目标/存证。当前 dev_vue 真实配置回填仍待历史时间依据，自动全库升级和旧结构清理未完成。
