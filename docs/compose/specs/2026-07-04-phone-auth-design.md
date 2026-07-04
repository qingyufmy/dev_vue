# 手机号登录注册系统 — 设计规格

## [S1] 需求总结

| 需求 | 说明 |
|------|------|
| 手机号独立注册 | 手机号+密码即可注册，不需要邮箱 |
| 手机号登录 | 支持密码登录 + 验证码登录（和邮箱一样） |
| 手机号忘记密码 | 短信验证码重置密码 |
| 账号绑定 | 邮箱用户可绑手机，手机用户可绑邮箱 |
| 唯一性约束 | 手机号和邮箱全局唯一，不能重复绑定 |
| 管理后台 | SMS 配置管理（阿里云参数）+ 2个开关（邮箱登录注册/手机登录注册） |
| 阿里云 SDK | SMS 用 `@alicloud/dysmsapi20170525` 官方 SDK |
| 人机验证 | 自建图形验证码（每次发送验证码前验证），防止短信轰炸 |

## [S2] 数据库变更

### Migration 020: users 表扩展

```sql
-- 手机号字段（唯一，可为空）
ALTER TABLE users ADD COLUMN phone VARCHAR(20) UNIQUE DEFAULT NULL AFTER email;

-- 手机号验证状态
ALTER TABLE users ADD COLUMN phone_verified TINYINT DEFAULT 0 AFTER phone;

-- 邮箱验证状态（已有邮箱注册用户默认为1）
ALTER TABLE users ADD COLUMN email_verified TINYINT DEFAULT 1 AFTER email;

-- 注册方式：email 或 phone
ALTER TABLE users ADD COLUMN auth_method VARCHAR(20) DEFAULT 'email' AFTER email_verified;
```

### verification_codes 表扩展

```sql
-- 手机号字段（与 email 二选一）
ALTER TABLE verification_codes ADD COLUMN phone VARCHAR(20) DEFAULT NULL AFTER email;

-- purpose 值扩展：
-- login / register / reset / change / bind_phone / bind_email
```

### system_config 种子数据

```sql
-- SMS 配置（category = 'sms'）
INSERT INTO system_config (category, `key`, `value`, label, sort_order) VALUES
('sms', 'access_key_id', '', 'AccessKey ID', 0),
('sms', 'access_key_secret', '', 'AccessKey Secret', 1),
('sms', 'sign_name', '', '短信签名', 2),
('sms', 'template_code_login', '', '登录验证码模板', 3),
('sms', 'template_code_register', '', '注册验证码模板', 4),
('sms', 'template_code_reset', '', '重置密码模板', 5),
('sms', 'template_code_bind', '', '绑定验证码模板', 6);

-- 登录注册开关（category = 'auth_toggle'）
INSERT INTO system_config (category, `key`, `value`, label, sort_order) VALUES
('auth_toggle', 'email_enabled', 'true', '邮箱注册登录', 0),
('auth_toggle', 'phone_enabled', 'true', '手机号注册登录', 1);
```

## [S3] 后端架构

### 新增：`server/sms.js` — 阿里云短信工具

```javascript
// 功能：
// - loadSmsConfig(): 从 system_config 读取 sms 配置
// - sendSms(phone, templateCode, templateParams): 调用阿里云 API 发送短信
// - sendVerificationSms(phone, purpose): 根据 purpose 选择模板并发送6位验证码

// 依赖：
// - @alicloud/dysmsapi20170525 (阿里云 SMS SDK)
// - @alicloud/openapi-client (API 客户端)
```

### 新增：`server/captcha.js` — 图形验证码工具

```javascript
// 功能：
// - generateCaptcha(): 生成验证码文本 + SVG 图片，返回 { id, svg }
// - verifyCaptcha(id, code): 验证用户输入，返回 boolean

// 实现：
// - 使用 svg-captcha 库生成 SVG 图形验证码
// - 验证码存储在内存 Map 中，5 分钟过期
// - 每个验证码只能使用一次
```

### 修改：`server/routes/auth.js`

| 接口 | 方法 | 说明 |
|------|------|------|
| `POST /api/send-code` | 修改 | 支持 `phone` 参数 + CAPTCHA 校验 |
| `POST /api/verify-code` | 修改 | 支持 `phone` 参数 |
| `POST /api/register` | 修改 | 新增手机号注册方式 |
| `POST /api/login` | 修改 | 新增手机号密码/验证码登录 |
| `POST /api/reset-password` | 修改 | 支持手机号 |
| `POST /api/send-bind-code` | 新增 | 发送绑定验证码（已登录用户） |
| `POST /api/bind-phone` | 新增 | 绑定手机号 |
| `POST /api/bind-email` | 新增 | 绑定邮箱 |
| `GET /api/captcha` | 新增 | 获取图形验证码 |

### 修改：`server/routes/config.js`

| 接口 | 方法 | 说明 |
|------|------|------|
| `GET /api/system-config-public/auth_toggle` | 新增 | 前端读取开关状态（公开接口） |
| `POST /api/system-config/sms/test` | 新增 | 测试短信发送 |

### 修改：`server/routes/user.js`

- `GET /api/profile` — 返回 `phone`, `phone_verified`, `auth_method`

## [S4] 前端变更

### 登录/注册弹窗（`public/src/main.js`）

**新增 AUTH_MODE_META：**
```javascript
login_phone: {
  title: '手机号登录',
  submitLabel: '登录',
  phoneLogin: true,
  passwordLabel: '密码',
  passwordPlaceholder: '请输入密码',
},
login_phone_code: {
  title: '手机验证码登录',
  submitLabel: '登录',
  phoneLogin: true,
  codePurpose: 'login',
},
```

**表单变更：**
- 注册表单：新增"手机号注册"选项卡
- 手机号输入框：带 +86 区号选择（默认+86）
- 模式切换链接：根据开关状态动态显示/隐藏邮箱/手机选项
- 所有验证码发送前显示图形验证码输入框

**模式切换逻辑：**
```javascript
// 根据 auth_toggle 开关决定显示哪些选项
function renderAuthModeLinks(mode) {
  const { emailEnabled, phoneEnabled } = state.authMethods || {}
  // ... 动态生成链接
}
```

### 账号设置页

- 新增"绑定手机号"卡片（邮箱注册用户可见）
- 新增"绑定邮箱"卡片（手机注册用户可见）
- 绑定流程：发送验证码 → 输入验证码 → 确认绑定

### 管理后台

- 系统配置新增"短信服务"tab — 阿里云 SMS 参数表单
- 系统配置新增"登录注册"tab — 2个开关（邮箱/手机）

## [S5] 图形验证码流程

```
用户点击"发送验证码"
  → 弹出图形验证码输入框（显示SVG图片）
  → 用户输入验证码
  → 前端调用 POST /api/verify-captcha { captchaId, captchaCode }
  → 后端校验通过
  → 前端调用 POST /api/send-code { phone, captchaId }
  → 后端再次校验 captchaId（一次性）
  → 发送短信
```

## [S6] 接口开关逻辑

**公开接口 `GET /api/auth-methods`** — 返回 `{ emailEnabled: true, phoneEnabled: true }`
- 前端根据此接口决定显示哪些登录/注册选项
- 关闭邮箱 → 隐藏邮箱登录/注册入口，仅保留手机
- 关闭手机 → 隐藏手机登录/注册入口，仅保留邮箱
- 两者都关闭 → 不可能（至少保留一种）

**服务端校验**
- `POST /api/register` — 检查对应开关是否开启
- `POST /api/login` — 检查对应开关是否开启
- 开关关闭时返回 `{ ok: false, error: '该注册方式已关闭' }`

## [S7] 安全考虑

- 验证码 6 位数字，10 分钟有效期，每分钟限发 1 次
- 图形验证码 5 分钟过期，一次性使用
- 手机号脱敏显示（138****8888）
- 阿里云 AccessKey Secret 在 admin 配置中用 password 类型输入
- 绑定操作需要先验证目标手机号/邮箱的验证码
- 手机号唯一性通过数据库 UNIQUE 约束保证
- 图形验证码防止短信轰炸

## [S8] 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `server/sms.js` | 新增 | 阿里云 SMS 工具 |
| `server/captcha.js` | 新增 | 图形验证码工具 |
| `server/db.js` | 修改 | initDB 新增 phone 字段 |
| `server/migrations.js` | 修改 | Migration 020 |
| `server/routes/auth.js` | 修改 | 手机注册/登录/绑定 + CAPTCHA |
| `server/routes/user.js` | 修改 | profile 返回 phone |
| `server/routes/config.js` | 修改 | SMS 测试 + auth_toggle |
| `server/index.js` | 修改 | rate limiter 适配 |
| `public/src/main.js` | 修改 | 登录/注册/设置/管理后台 UI |
| `package.json` | 修改 | 新增 @alicloud + svg-captcha 依赖 |

## [S9] 测试策略

### 单元测试
- `server/sms.js` — 测试 SMS 配置加载、模板选择
- `server/captcha.js` — 测试验证码生成、验证、过期

### 集成测试
- 手机号注册流程
- 手机号登录流程（密码 + 验证码）
- 忘记密码流程
- 账号绑定流程
- 开关控制逻辑

### 手动测试
- 管理后台 SMS 配置
- 图形验证码显示和验证
- 手机号输入格式验证
- 绑定流程用户体验

## [S10] 实施顺序

1. **Phase 1: 数据库变更**
   - Migration 020: users 表扩展
   - verification_codes 表扩展
   - system_config 种子数据

2. **Phase 2: 后端工具**
   - `server/sms.js` — 阿里云短信工具
   - `server/captcha.js` — 图形验证码工具

3. **Phase 3: 后端接口**
   - 修改 `server/routes/auth.js`
   - 修改 `server/routes/user.js`
   - 修改 `server/routes/config.js`
   - 修改 `server/index.js`

4. **Phase 4: 前端 UI**
   - 登录/注册弹窗改造
   - 账号设置页改造
   - 管理后台改造

5. **Phase 5: 测试**
   - 单元测试
   - 集成测试
   - 手动测试
