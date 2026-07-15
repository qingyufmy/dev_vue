# AI 策略、风控、复盘与记忆上线手册

## 上线原则

- 所有新开仓和挂单必须经过 `order_intents`、核心风控、状态风控和 Bridge 发送状态机。
- ownership、entitlement、账户审核、Kill Switch、数据完整性、幂等和手数边界始终 Enforce，不能切换为 Shadow。
- 复盘生成、经验记忆、记忆压缩默认关闭；经验启用时先保持 `retrieval_shadow_enabled=1`，观察后再实际注入。
- 迁移或 Schema readiness 失败会阻止服务启动，不允许半启用。
- 管理员健康接口只返回聚合状态，不读取或返回 API Key、复盘正文、证据正文或记忆正文。

## 生产前准备

1. 备份 MySQL，并确认可以按时间点恢复；备份 Redis 仅用于运行态恢复，数据库仍是事实来源。
2. 配置独立于 `JWT_SECRET` 的凭据密钥环：

   ```text
   AI_CREDENTIAL_KEYS_JSON={"1":"<32-byte-key-base64>"}
   AI_CREDENTIAL_ACTIVE_KEY_VERSION=1
   AI_LEGACY_CREDENTIAL_READ_ENABLED=false
   ```

3. 新版本首次启动必须完整应用 056–065；服务随后检查 migration tracking、关键表、关键列和关键索引。
4. 确认数据库、Redis、JWT、Bridge 和模型供应商网络分别可用。任何缺失都只能标记为“未验证”，不能视为通过。

## 迁移清单

| 版本 | 内容 | 回滚边界 |
|---|---|---|
| 056 | 加密模型档案、默认模型、共享策略、使用日志 | 保留旧配置字段 |
| 057 | 策略归属、交易账户、订阅 | 只停用新订阅，不删表 |
| 058 | 订单意图与风险预留 | 关闭新开仓，不删意图 |
| 059 | 版本化风控与决策 | 回切旧服务只读，保留决策 |
| 060 | 状态风控、恢复申请、Kill Switch | 关闭执行，保留状态 |
| 061 | 推理快照 | 永不删除原始证据 |
| 062 | 交易结果归因 | 停止 reconciler，保留结果 |
| 063 | 复盘案例、版本和队列 | 关闭复盘开关 |
| 064 | 个人记忆、摘要、压缩与注入日志 | 关闭记忆开关，不删历史 |
| 065 | 灰度开关、规则发布、凭据迁移记录、用户匿名化字段 | 所有生成开关默认关闭 |

DDL 采用可重入的 `CREATE TABLE IF NOT EXISTS` 或 information_schema 判定。单个迁移失败时不写 `schema_migrations`，进程退出；修复原因后重启即可从未完成版本继续。

## 凭据迁移、轮换和旧字段清理

1. 启动阶段只迁移旧 Key 到 AES-256-GCM profile，不清空旧字段，因此失败时旧版本仍可回滚。
2. 管理员先检查模型连接、模型来源、使用日志和 `/api/ai/admin/rollout-health`。
3. 密钥轮换：先把新版本加入 keyring 并设为 active，再调用 `POST /api/ai/admin/credentials/rotate`。所有旧 envelope 必须成功解密后才会在事务内重加密；失败会回滚，不记录明文。
4. 稳定观察后，调用 `POST /api/ai/admin/credentials/finalize-legacy-cleanup`，请求体必须为：

   ```json
   {"confirm":"CLEAR_VERIFIED_LEGACY_CREDENTIALS"}
   ```

   清理前逐条比较旧来源与加密 profile。任一来源无法验证时整批回滚；验证通过后才清空 `ai_configs`、`global_auto_config`、`close_config` 和 `system_config` 的旧 Key 字段。
5. 完成清理前不要从 keyring 删除旧版本。轮换完成并确认所有 profile 的 `key_version` 已更新后，才可在下一维护窗移除旧 key。
6. `AI_LEGACY_CREDENTIAL_READ_ENABLED=true` 只用于紧急短时回滚；恢复后必须重新设为 `false`。

## 灰度顺序

1. 保持全部生成开关关闭，验证模型来源、订单意图、风险拒绝和 outcome 指标。
2. 小范围用户开启 `review_generation_enabled`，观察失败率、队列长度、Token 与平台成本。
3. 开启 `experience_memory_enabled`，同时保持 `retrieval_shadow_enabled=1`；只记录会选择的记忆，不注入提示词。
4. 验证检索相关性、隔离边界和 Token 预算后，对小范围用户关闭 retrieval shadow，实际注入经验。
5. 数据规模达到阈值后再开启 `memory_compression_enabled`。
6. `paired_experiment_enabled` 只赋予实验资格；必须另有成本预算和明确实验组，不得自动扩大仓位。
7. 新的可调风控规则先写入 `risk_rule_rollouts` 的 Shadow 观测，再由管理员切换 Enforce。065 中标记 `forced_enforce=1` 的规则拒绝 Shadow 修改。

## 监控与告警

管理员读取 `GET /api/ai/admin/rollout-health`。核心指标包括：

- 模型来源、状态、错误码、请求数和 Token；平台共享 Token 作为成本代理值。
- 订单意图各状态；`uncertain` 数量与最老年龄。
- 风控拒绝码分布。
- outcome backlog 数量和年龄。
- review queue、compression queue 和失败数。
- 活跃/撤销记忆数量与 Token。
- 最近一次凭据迁移/轮换结果。

默认告警：不确定订单超过 5 分钟为 Critical；复盘失败任务为 Warning；压缩排队/租约超过 1 小时为 Warning；凭据迁移失败为 Critical。告警出现时先关闭相关生成或执行开关，再排障，不通过重复发送 Bridge 命令“试错”。

## 用户删除与数据留存

- 删除用户改为匿名化：禁用登录、清除联系方式和第三方身份、随机化密码、销毁模型 Key、关闭 scheduler/订阅/交易账户。
- 保留 orders、trade_audit_logs、order_intents、risk_decisions、inference_snapshots、signal outcomes、复盘证据和相关审计，以满足交易追踪和事故调查。
- 不物理删除历史表、不可变版本或原始证据。产品内容、通知和验证码等非交易个人数据可删除。
- 管理员只能查看聚合健康与账户治理数据，不能通过健康接口查看用户复盘正文或个人记忆正文。

## 回滚

1. 立即开启平台和账户 Kill Switch，阻止新开仓。
2. 关闭 review、memory、compression 和 paired experiment 全局开关。
3. 停止新服务进程，保留数据库与 Redis 现场；不得删除 056–065 表。
4. 若尚未清理旧字段，可临时启用旧服务和 `AI_LEGACY_CREDENTIAL_READ_ENABLED=true`。若已清理旧字段，旧服务不具备模型凭据，必须修复新服务或从受控备份恢复，禁止把 Key 写回日志/工单。
5. 对 `uncertain` 订单只运行 reconciler/人工核对，不重放开仓。
6. 回滚后记录版本、时间、开关、migration 状态和未决订单清单。

## 发布后检查

```powershell
npm test
rg -n "mt5Bridge.*'(open|pending)'" server
rg -n 'mt5Bridge.*"(open|pending)"' server
npm run dev
```

启动日志必须分别记录：MySQL 是否连接、migration/readiness 是否通过、JWT 是否配置、Redis 是否可用、Bridge 是否实际连接。静态启动成功不代表 Bridge 或模型供应商链路已经验证。
