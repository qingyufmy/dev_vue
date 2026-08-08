# Task 11 迁移、灰度、监控与最终硬化结果

## 结论

Task 01–11 的实现已完成并通过最终整合审查。Task 11 初始实现提交为 `a6cfae9`，后续由 Codex 补齐运行时双写、手动推理快照、付费配对、规则级 Shadow、前端权限与移动端验收。未合并 `main`。

## 本任务实现

- 新增 065 `ai_rollout_governance`：全局/用户功能开关、规则级发布状态、凭据迁移记录和用户匿名化字段。
- 服务启动在 scheduler、review worker、compression worker 之前强制检查 056–065 migration tracking、关键表、关键列和关键索引；失败即退出。
- 复盘、经验、压缩默认关闭；全局与用户开关共同生效，用户不能绕过全局关闭；经验支持 retrieval shadow，paired experiment 需要双层开关。
- ownership、entitlement、账户审核、Kill Switch、数据完整性、幂等和手数边界被标记为 `forced_enforce`，拒绝切换 Shadow。
- 新增管理员健康状态：模型来源/错误、订单意图、uncertain 年龄、风控拒绝、outcome backlog、review queue、compression stale、memory tokens 和平台共享 Token 成本代理。
- 新增凭据轮换和旧字段清理流程。轮换在事务内解密检查并重加密；旧字段只有逐条验证匹配后才整批清空，失败回滚且不记录凭据。
- 旧 WebSocket 配置入口不再写明文 Key，统一写入加密 model profile；旧隐式读取默认关闭，仅保留显式紧急回滚环境开关。
- 智能平仓模型改用统一 resolver，不再读取 `close_config`/`ai_configs` 的旧 Key。
- 管理员删除用户改为匿名化：禁用登录、销毁 Key、关闭 scheduler/订阅/账户；保留订单、风险、推理快照、复盘证据和审计。
- 管理员与用户页面均增加灰度开关；全局风控页显示聚合健康摘要，不展示复盘/记忆正文或秘密。
- 新增部署、运维、回滚、凭据轮换和数据留存手册。

## 迁移清单

| Migration | 主要对象 | 失败行为 |
|---|---|---|
| 056 | model profiles / defaults / usage policy / usage logs | 失败不标记，阻止启动 |
| 057 | strategy ownership / accounts / subscriptions | information_schema 幂等补列；失败阻止启动 |
| 058 | order intents / reservations | IF NOT EXISTS；失败阻止启动 |
| 059 | risk policies / decisions | IF NOT EXISTS；失败阻止启动 |
| 060 | stateful risk / recovery / kill switch | 幂等；失败阻止启动 |
| 061 | inference snapshots | IF NOT EXISTS；失败阻止启动 |
| 062 | outcomes / deals | IF NOT EXISTS；失败阻止启动 |
| 063 | review cases / versions / jobs | IF NOT EXISTS；失败阻止启动 |
| 064 | memory / summaries / compression / injection logs | IF NOT EXISTS；失败阻止启动 |
| 065 | rollout flags / rule modes / credential runs / user deletion | 幂等补列建表；失败阻止启动 |
| 066 | paired inference decision evidence | 仅保存脱敏摘要/hash；失败阻止启动 |
| 067 | manual inference snapshots | 允许手动推理以空 strategy_id 保留不可变快照；失败阻止启动 |

## 测试与静态验证

- 最终 `npm test`：56 个测试文件、814 项测试全部通过。
- 关键并发覆盖：订单意图幂等与租约、Redis 锁丢失、Bridge 发送后 uncertain、pending reconciler、风险预留与状态风控。
- `node --check`：migrations、governance、model profiles、AI routes、workers、scheduler、admin route 和前端脚本通过。
- 秘密/正文日志扫描：无 `console` 输出 API Key、Authorization、Bearer、evidence/content JSON 或 lesson text 的匹配。
- `rg -n "mt5Bridge.*'(open|pending)'" server`：无匹配。
- 任务中的双引号宽松正则命中 `pending_list` 与 `cancel_pending`；逐项确认均为查询/撤单，不是 `open` 或 `pending` Bridge 新单动作。新单发送仍只在 durable order-intent gateway 内执行。

## 启动验证

- `npm run dev` / `node server/index.js`：服务成功监听 `:3000`。
- `/health`：`status=ok`、MySQL connected、Redis connected。
- 数据库确认：056–067 已应用；`assertAiGovernanceSchemaReady()` 返回 ready，服务在 worker 启动前完成 migration/readiness 检查。
- JWT_SECRET：当前环境已配置。
- AI credential keyring：当前环境未配置 `AI_CREDENTIAL_KEYS_JSON` / active version；模型调用按失败关闭策略禁用，未进行真实模型请求。
- Bridge：管理员 WS health 的进程内连接数为 0；数据库存在近期状态记录，但不能据此声称当前 Bridge 实际在线。因此 MT5 实盘开仓/挂单链路未做真实执行验证。
- 验证结束后停止本次启动产生的 Node 进程并释放端口 3000。

## 剩余生产风险

1. 生产密钥环尚未在当前环境配置，必须由部署人员生成并通过秘密管理系统注入，不能提交仓库。
2. 未连接真实 Bridge，真实 MT5 账户身份、报价、下单与回报链路仍需在 Kill Switch 开启或模拟账户环境完成冒烟。
3. 平台成本目前以请求数与 Token 聚合为代理指标；若需要精确货币成本，需要维护供应商/模型价格表。
4. 旧字段清理是不可自动回退的数据动作，必须完成备份、轮换、连接测试和观察窗后由管理员显式执行。
5. 配对实验已接入手动与私有自动推理，但只有管理员授权且用户显式同意时才额外调用一次；必须纳入单独成本预算，对照结果不下单。

## 生产启用顺序

1. 备份 MySQL，配置并验证 JWT、Redis、Bridge 和独立 AI credential keyring。
2. 保持平台/账户 Kill Switch 可用，部署并确认 056–067 与 readiness。
3. 迁移旧 Key，测试每个 model profile；先不清旧字段。
4. 验证订单意图、uncertain、风控拒绝和 outcome 指标。
5. 小用户组开启复盘生成。
6. 开启经验记忆但保持 retrieval shadow。
7. 审查相关性和 Token 后，小范围实际注入；随后才开启压缩。
8. 轮换验证和观察窗通过后，显式清理旧 Key 字段。
9. Bridge 模拟账户冒烟通过后，再分账户解除 Kill Switch。

详细操作见 `docs/compose/runbooks/2026-07-15-ai-governance-rollout-runbook.md`。
