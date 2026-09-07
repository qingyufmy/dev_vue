# 阶段 154：配置统一迁移入口

新增 scripts/migrate-dev-vue-settings.mjs 与 v4-settings-migration.mjs。当前入口限定 server/.env 的 dev_vue，校验备份 UUID、实际 58 步目标 schemaHash 和阶段 153 固定演练回执及其 212 项源码摘要。此入口是整体升级的一部分，尚非任意公网旧库的全量自动升级器。

## 命令与固定清单

`node scripts/migrate-dev-vue-settings.mjs --check|--apply|--recover|--verify <reviewed-manifest.json>`

- check：验证清单、结构、证据、来源和冻结转换；不创建迁移运行、不写目标。凭据计划必须已经存在。
- apply：prepare run，逐批调用既有事务 runner，最后独立回读来源/目标/保护存证完成审计。异常不自动续写。
- recover：逐批确认已提交情况；首次 not_committed/unknown 立即返回，退出码 2，不转成 apply。全部已提交后执行独立审计。
- verify：仅回读已存在运行及数据验证，不创建缺少的目标。

JSON 顶层精确为 kind/sourceIds/options/spec/batchSize/credentialPlanPath。kind 为 ordinary 或 credential；一个运行不混合两类，避免把凭据交给旧原文存证路径。options 含既有 run/basis/evidenceCatalog，evidenceCatalog 在 JSON 中用二元数组表示。凭据还须 expectedPlanChecksum；credentialPlanPath 相对清单目录解析，普通配置该值为 null。密钥仅从当前环境配置加载，不写入清单。

spec 遵守现有回填合同：固定 run、源/目标、snapshotHash、schemaHash、manifestHash、transformHash 和 stream。manifestHash 由 settingsMigrationManifestHash 对整个清单计算，仅把自身 spec.bindings.manifestHash 暂置 null。来源数据从实际 system_config 按明确 ID 读取；转换集合摘要和 transformHash 不符拒绝。凭据计划缺失时不会自动新建。

清单必须由已审核字段/时间/语义依据和冻结凭据计划生成。本次没有生成伪装获准的真实配置清单；历史非空时间依据仍待解决。

## 事务与验证范围

执行全程持有同库升级锁；各批沿用 run/checkpoint/receipt 锁序。最终审计先核对目标身份并锁定运行，再锁来源、目标和存证，比较十五目标列并还原受保护来源。输出仅状态、运行标识、计数及审计字段，不输出凭据正文。

27 项统一入口编排、原 runner 和凭据独立对账测试通过，CLI 语法与 --help 通过。新编排测试覆盖 apply 后独立审计、commit_unknown 不重试、recover 不补写、verify 不创建、目标变更失败、混合凭据路由拒绝、转换/清单绑定。编排中 runner 调用采用 Mock；底层真实事务证据仍为阶段 153，不能宣称新 CLI 完整实库执行通过。

第一轮复核：不再要求操作者直接拼接底层函数；固定清单是统一入口，普通/凭据显式分流。第二轮复核补充清单自身 hash 定义、防止解密失败自动回填、缺失计划不重建和非零恢复退出码。现有演练回执不因新入口而改写。

本批没有数据库写入或消费者切换。下一步补统一入口的恢复镜像端到端验收，并推进剩余领域及实际历史依据处理。全库自动升级、业务切换和旧结构清理尚未完成。
