# Mimo Task 01 Result: 统一模型管理与服务端解析

## 任务名称
统一模型管理与服务端解析

## 起始 commit
a02d7b56afc42c48758b0aed3adca995ed12dca4

## 完成 commit
9c0f65a

## 推送分支
dev_codex

## 修改文件清单

### 新增文件
| 文件 | 用途 |
|------|------|
| `server/ai-credential.js` | AES-256-GCM 版本化凭据加解密模块，独立主密钥环 |
| `server/routes/ai/model-profiles.js` | 模型 Profiles CRUD + 统一解析器 + 使用日志 + 旧配置迁移 |
| `tests/ai/credential.test.js` | 加解密测试：roundtrip、tamper、错误密钥、legacy 兼容 |
| `tests/ai/model-profiles.test.js` | 解析器测试：用户优先、平台兜底、共享开关、策略绑定、配额 |
| `docs/agent-results/20260715-mimo-01-model-management-result.md` | 本结果文件 |

### 修改文件
| 文件 | 变更 |
|------|------|
| `server/migrations.js` | 新增 migration 056：4 张新表 |
| `server/routes/ai/config.js` | 修复 `getAnalyzeApiKey` 优先级：用户模型优先，不再被管理员共享覆盖 |
| `server/.env.example` | 新增 `AI_CREDENTIAL_KEYS_JSON` 和 `AI_CREDENTIAL_ACTIVE_KEY_VERSION` |

## 数据库迁移
**056_model_profiles_tables** — 4 张新表：
- `ai_model_profiles` — 模型配置（平台/用户），含加密 Key、版本、scope、status
- `user_model_defaults` — 用户统一默认模型
- `platform_model_usage_policy` — 平台模型共享开关（手动/自动/复盘/压缩独立控制）
- `ai_model_usage_logs` — 模型调用日志（用户、profile、来源、用途、token、状态）

## 实现摘要

### 1. AES-256-GCM 加密 (`ai-credential.js`)
- Node.js `crypto` 模块，12 字节 IV + 16 字节 auth tag
- 环境变量 `AI_CREDENTIAL_KEYS_JSON` 存版本化 keyring（JSON: `{"1":"base64_key",...}`）
- `AI_CREDENTIAL_ACTIVE_KEY_VERSION` 指定当前写入版本
- 缺少主密钥时 `encryptCredential()` 抛错，禁止保存新 Key
- `decryptCredential()` 支持 legacy 明文（用于迁移过渡期）
- `isEncryptedEnvelope()` 区分新格式与旧明文

### 2. 统一解析器 (`resolveAiTaskModel`)
- 支持 5 种 usage：`manual`、`auto_private`、`auto_platform`、`review`、`memory_compression`
- 手动推理链：用户显式模型 → 用户默认 → 平台共享（`share_for_manual`）→ null
- 私有自动链：策略绑定 → 用户默认 → 平台共享（`share_for_auto`）→ null
- 平台自动：直接返回平台模型
- 复盘/压缩：用户默认 → 对应共享开关 → null
- 策略绑定失效（profile 被删/inactive）→ 不兜底，返回 error
- 策略绑定无 Key → 不兜底，返回 error

### 3. 共享开关独立控制
- `platform_model_usage_policy` 表 4 个独立开关：`share_for_manual`、`share_for_auto`、`share_for_review`、`share_for_memory_compression`
- 按用户套餐（`allowed_plans`）控制权限
- 用户模型运行失败不会静默切换平台额度

### 4. 旧配置迁移
- `migrateLegacyConfigs()` 从 `ai_configs`、`global_auto_config`、`system_config`、`close_config` 读取明文 Key
- 立即加密写入 `ai_model_profiles`
- 加密后不删除旧字段（清理留给 Task 11）

### 5. `getAnalyzeApiKey` 修复
- 旧逻辑：管理员共享存在时覆盖用户已有模型
- 新逻辑：用户有 Key → 直接返回用户模型；无 Key → 才回退管理员共享

## 运行的测试和结果

```
npx vitest run
Test Files  42 passed (42)
Tests       671 passed (671)
Duration    2.11s
```

新增测试：
- `tests/ai/credential.test.js` — 21 tests（加解密 roundtrip、tamper 检测、错误密钥、legacy 兼容、keyring 管理）
- `tests/ai/model-profiles.test.js` — 16 tests（解析器优先级、共享开关、策略绑定、配额、API 安全）

## 未运行的验证及原因
- `npm run dev` 启动验证：未运行（任务要求只做单元测试，不改变自动调度/前端）
- 数据库 migration 实际执行：未验证（无本地 MySQL，migration 逻辑为 CREATE TABLE IF NOT EXISTS，幂等安全）

## 已知风险
1. `migrateLegacyConfigs()` 需要在生产环境有 `AI_CREDENTIAL_KEYS_JSON` 时才能运行；未配置时跳过并打印警告
2. `api_key_encrypted` 旧字段在兼容期仍保留读取，最终清理留给 Task 11
3. `ai_model_profiles` 表的 `owner_user_id = 0` 表示平台模型，`user_model_defaults` 中 `user_id` 为管理员 ID 的平台默认

## 兼容性说明
- 旧配置表（`ai_configs`、`global_auto_config`、`system_config`、`close_config`）未修改，继续正常读取
- `getAnalyzeApiKey` 修复了优先级 bug，但不影响已有正常工作的用户配置
- 新表全部使用 `CREATE TABLE IF NOT EXISTS`，幂等安全
- `ai_credential.js` 在无环境变量时 `isEncryptionAvailable()` 返回 false，旧代码路径不受影响
- 不涉及前端变更

## 下一阶段前必须处理的问题
1. 生产环境配置 `AI_CREDENTIAL_KEYS_JSON` 和 `AI_CREDENTIAL_ACTIVE_KEY_VERSION`
2. Task 02 需要基于此阶段的 `ai_model_profiles` 表扩展策略 scope 和所有权
3. `getActiveConfig` 的完整回退链需要在后续阶段由统一解析器逐步替代
