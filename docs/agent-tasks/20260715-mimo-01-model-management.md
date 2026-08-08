# Mimo Task 01：统一模型管理与服务端解析

## 前置

- 仓库：`D:/dev_codex/wall-street-skill-local`
- 分支：仅 `dev_codex`
- 必读：
  - `docs/compose/specs/2026-07-15-private-strategy-shared-signal-risk-gate-design.md`
  - `docs/compose/plans/2026-07-15-private-strategy-risk-review-memory-mimo-plan.md`
- 保留所有与本任务无关的未跟踪文件，不得清理工作树。

## 目标

建立一套模型配置同时服务手动推理、私有自动推理、复盘和记忆压缩，并修正“管理员共享模型覆盖用户已有模型”的问题。

## 必须实现

1. 使用下一个可用 migration ID 新增：
   - `ai_model_profiles`
   - `user_model_defaults`
   - `platform_model_usage_policy`
   - `ai_model_usage_logs`
2. 不得沿用当前名为 `api_key_encrypted`、实际保存明文的行为。使用 Node `crypto` 的版本化认证加密（建议 AES-256-GCM），独立环境主密钥，不复用 JWT_SECRET；保存 key version、nonce、ciphertext、auth tag。环境 keyring 使用 `AI_CREDENTIAL_KEYS_JSON`，active version 使用 `AI_CREDENTIAL_ACTIVE_KEY_VERSION`，并更新 `.env.example`，不得写真实 Key。
3. 缺少加密主密钥时禁止保存新 Key 和启用模型调用，不得回退明文；测试使用专用临时密钥。
4. 为 `ai_configs`、`global_auto_config`、`system_config` AI provider keys 和 `close_config` 制定受控迁移：读取旧明文后立即写入新加密 profile；验证成功前不删除，最终清理留给 Task 11；全过程不打印 Key。
5. 新增统一解析器 `resolveAiTaskModel({ userId, strategyId, usage })`，至少支持：
   - `manual`
   - `auto_private`
   - `auto_platform`
   - `review`
   - `memory_compression`
6. 用户模型优先；仅用户“没有配置可用默认模型”时允许平台共享兜底。
7. 策略显式绑定模型失效、用户 Key 错误、欠费、限流、超时不得静默切换平台额度。
8. 平台共享权限按 usage 独立控制，并支持套餐、单用户次数和 Token 配额字段。
9. 每次模型调用记录安全的 usage log：用户、profile、credential source、usage、Token、状态和错误 code；不记录提示词正文和密钥。
10. 为现有模型配置提供兼容读取/迁移，不删除旧字段。
11. 修正 `getAnalyzeApiKey` 当前可能覆盖用户已有模型的优先级；逐步由统一解析器接管隐式回退。
12. 返回安全元数据：profile id、模型名称、`credential_source`、usage；绝不返回密钥。
13. 添加加解密 tamper、错误主密钥、旧明文迁移、解析器、越权、配额和共享开关测试。

## 非目标

- 不改自动调度共享/私有运行方式。
- 不做前端页面。
- 不实现策略 scope、风控、复盘或记忆。
- 不删除旧配置表。

## 验证

```powershell
npm test -- tests/ai/config.test.js tests/ai/manual-prompt.test.js
npm test
```

至少覆盖：加密后数据库不含原 Key、auth tag 篡改失败、错误主密钥失败、用户自有优先、无配置手动/自动兜底、共享关闭、显式绑定失效不兜底、用户运行错误不兜底、API 不泄密。

## 交付

1. 写结果：`docs/agent-results/20260715-mimo-01-model-management-result.md`
2. 结果包含起始/完成 commit、迁移、文件、测试、未验证项和风险。
3. 提交信息清晰，推送 `origin/dev_codex`。
4. 完成后停止，不执行 Task 02。
