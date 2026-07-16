# 火山方舟 Agent Plan 接入修改方案

## 1. 背景与目标

在 AI 交易实验室的模型配置中增加“火山方舟 Agent Plan”，让以下两条推理链路可以使用 Agent Plan 专属 API Key 和 Responses API：

1. 用户手动推理模型配置。
2. 管理员自动推理的全局模型配置。

目标配置如下：

```text
供应商标识：volcengine_agent_plan
显示名称：火山方舟 Agent Plan
默认模型：deepseek-v4-pro
API 基础地址：https://ark.cn-beijing.volces.com/api/plan/v3
请求接口：POST /responses
完整地址：https://ark.cn-beijing.volces.com/api/plan/v3/responses
```

普通火山方舟 DouBao 接口必须继续保留，不能被 Agent Plan 替换：

```text
普通 DouBao：https://ark.cn-beijing.volces.com/api/v3/chat/completions
Agent Plan：https://ark.cn-beijing.volces.com/api/plan/v3/responses
```

## 2. 实施范围

主要涉及以下文件：

```text
public/ai/index.html
public/ai/app.js
server/routes/ai/config.js
server/routes/ai/llm.js
tests/ai/llm.test.js
```

如模型配置保存入口存在额外校验，还需要检查：

```text
server/bridge-ws.js
```

本次不需要新增数据库字段或数据库迁移。

## 3. 前端模型配置

### 3.1 新增供应商选项

在手动模型配置和管理员全局模型配置的供应商选择器中增加：

```html
<option value="volcengine_agent_plan">火山方舟 Agent Plan</option>
```

两个位置必须同时增加，避免手动推理和自动推理配置能力不一致。

### 3.2 新增供应商预设

在 `public/ai/app.js` 的 `PROVIDER_PRESETS` 中增加：

```javascript
volcengine_agent_plan: {
  models: ['deepseek-v4-pro'],
  url: 'https://ark.cn-beijing.volces.com/api/plan/v3'
}
```

选择“火山方舟 Agent Plan”后，应自动联动：

```text
模型名称：deepseek-v4-pro
API 地址：https://ark.cn-beijing.volces.com/api/plan/v3
```

用户仍然可以手动填写套餐支持的其他模型名称。

切换供应商时，只有当前模型或地址为空、或者属于其他供应商预设值时才自动替换。不得覆盖用户填写的自定义模型名称和自定义 API 地址。

### 3.3 思考模式与思考强度

Agent Plan 使用 Responses API 的 `reasoning.effort` 控制推理强度，前端至少提供：

```text
low
medium
high
```

建议默认值：

```text
思考模式：开启
思考强度：medium
```

项目原有的 `max` 可继续为普通 DeepSeek 保留，但 Agent Plan 不应直接发送 `max`。如果选择 Agent Plan 后仍允许选择 `max`，后端必须将其映射为 `high`。

建议含义：

```text
low：速度优先，推理深度较低
medium：速度和分析深度均衡，适合常规自动推理
high：推理更深入，延迟和消耗通常更高
```

关闭思考模式只代表不主动发送 `reasoning` 参数，不应在界面上承诺模型完全停止内部推理。

### 3.4 API 地址提示

原有 `OpenAI-compatible endpoint` 提示应改为通用描述，例如：

```text
API 基础地址
```

因为 Agent Plan 使用 Responses API，而不是 Chat Completions。

### 3.5 前端资源版本

修改 `public/ai/app.js` 后，必须更新 `public/ai/index.html` 中的版本号：

```html
<script src="/ai/app.js?v=新版本号"></script>
```

确保浏览器不会继续使用旧脚本缓存。

## 4. 后端配置校验

在 `server/routes/ai/config.js` 的供应商允许列表中加入：

```javascript
'volcengine_agent_plan'
```

示例：

```javascript
const supportedProviders = new Set([
  'deepseek',
  'gpt',
  'kimi',
  'qwen',
  'zhipu',
  'doubao',
  'volcengine_agent_plan'
])
```

需要确认以下配置入口都允许保存该供应商：

1. 手动推理模型配置。
2. 管理员自动推理全局模型配置。
3. 配置读取和页面回显。
4. 管理员模型共享配置继承。

API Key 继续沿用项目现有的保存、读取和脱敏机制，不得输出到前端响应、普通日志或错误日志中。

## 5. Responses API 协议适配

### 5.1 协议选择

在 `server/routes/ai/llm.js` 中根据供应商选择协议：

```javascript
const protocol = provider === 'volcengine_agent_plan'
  ? 'responses'
  : 'chat_completions'
```

现有供应商继续使用 Chat Completions，不得改变原请求结构。

### 5.2 请求地址

构造地址前先移除 Base URL 末尾多余的 `/`：

```javascript
const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, '')
```

然后根据协议构造：

```javascript
const url = protocol === 'responses'
  ? `${normalizedBaseUrl}/responses`
  : `${normalizedBaseUrl}/chat/completions`
```

必须避免：

```text
/api/plan/v3//responses
/api/plan/v3/chat/completions
```

### 5.3 Agent Plan 请求体

Agent Plan 请求示例：

```json
{
  "model": "deepseek-v4-pro",
  "instructions": "系统提示词",
  "input": [
    {
      "role": "user",
      "content": "市场数据 JSON"
    }
  ],
  "max_output_tokens": 2000,
  "reasoning": {
    "effort": "medium"
  }
}
```

字段转换关系：

```text
Chat Completions 的 system message -> instructions
其他 messages                         -> input
max_tokens                            -> max_output_tokens
reasoning_effort                      -> reasoning.effort
```

请求头：

```http
Authorization: Bearer <Agent Plan 专属 API Key>
Content-Type: application/json
```

### 5.4 思考参数处理

思考模式开启时：

```javascript
body.reasoning = {
  effort: reasoningEffort === 'max' ? 'high' : reasoningEffort
}
```

思考模式关闭时，不发送 `reasoning`。

Agent Plan 下建议默认不发送 `temperature`。部分推理模型可能不接受温度参数，或者忽略温度参数。界面中的温度配置可以继续为其他供应商保留。

### 5.5 最大输出限制

Agent Plan 必须发送：

```javascript
max_output_tokens
```

不得发送 Chat Completions 的：

```javascript
max_tokens
```

即使开启思考模式，也应保留最大输出限制，防止异常长响应。

## 6. Responses API 返回解析

Agent Plan 响应不能仅按以下路径读取：

```javascript
data.choices[0].message.content
```

解析顺序应为：

1. 优先读取顶层 `data.output_text`。
2. 如果不存在，遍历 `data.output[].content[]`。
3. 收集其中 `type === 'output_text'` 的 `text`。
4. 按原顺序拼接所有文本片段。
5. 将拼接结果交给现有 `parseJsonObject()`。

需要兼容示例：

```json
{
  "output_text": "{\"signal_type\":\"hold\"}"
}
```

以及：

```json
{
  "output": [
    {
      "type": "message",
      "content": [
        {
          "type": "output_text",
          "text": "{\"signal_type\":\"hold\"}"
        }
      ]
    }
  ]
}
```

## 7. JSON 修复流程

模型第一次输出不是合法 JSON 时，系统现有的二次修复机制必须继续工作。

Agent Plan 的修复请求也必须使用：

```text
POST /responses
```

修复输入应包含：

1. 原始用户输入。
2. 模型上一次错误输出。
3. 要求只返回合法 JSON 对象的修复指令。

修复响应仍按照 `output_text` 或 `output[].content[].text` 解析，禁止在修复阶段切回 `/chat/completions`。

## 8. 错误处理与日志

需要覆盖以下错误：

```text
Agent Plan API Key 无效
模型名称不受套餐支持
套餐额度不足
请求频率受限
Responses API 返回内容为空
模型输出不是合法 JSON
请求超时
HTTP 4xx/5xx
```

日志可以记录：

```text
供应商
模型名称
请求协议
HTTP 状态码
请求耗时
是否进入 JSON 修复
```

日志禁止记录：

```text
完整 API Key
Authorization 请求头
完整账户敏感数据
包含用户隐私的完整推理请求体
```

## 9. 自动推理兼容性

管理员保存 Agent Plan 全局模型配置后，统一自动推理调度器读取配置时应得到：

```text
api_provider=volcengine_agent_plan
model_name=deepseek-v4-pro
api_base_url=https://ark.cn-beijing.volces.com/api/plan/v3
```

调度器本身不需要感知 Responses API。调度器仍调用统一的 `maybeAiSignal()`，协议差异全部封装在 LLM 请求层。

不得修改：

```text
调度器订阅关系
行情数据来源
信号广播逻辑
交易执行逻辑
后端风控逻辑
```

## 10. 测试要求

在 `tests/ai/llm.test.js` 增加以下测试：

1. Agent Plan 使用 `/responses`。
2. Base URL 末尾有 `/` 时不会生成双斜杠。
3. 请求体包含 `instructions`。
4. 请求体包含 `input`。
5. 使用 `max_output_tokens`，不使用 `max_tokens`。
6. 开启思考模式时发送 `reasoning.effort`。
7. `max` 自动映射为 `high`。
8. 关闭思考模式时不发送 `reasoning`。
9. 能解析顶层 `output_text`。
10. 能解析 `output[].content[].text`。
11. 非法 JSON 修复仍使用 Responses API。
12. Agent Plan 供应商可以保存和读取。
13. 原有 DeepSeek、Qwen、DouBao 请求结构不发生变化。

执行：

```powershell
npm test
```

验收要求：

```text
全量测试通过
无新增测试失败
无 JavaScript 语法错误
git diff --check 通过
```

## 11. 人工测试步骤

管理员进入：

```text
AI 交易实验室
-> 自动推理配置
-> 全局模型/API 配置
```

填写：

```text
模型供应商：火山方舟 Agent Plan
模型名称：deepseek-v4-pro
API Key：Agent Plan 专属 API Key
API 地址：https://ark.cn-beijing.volces.com/api/plan/v3
思考模式：开启
思考强度：medium
```

保存后验证：

1. 刷新页面，供应商、模型、地址和思考参数正确回显。
2. API 地址没有被改回普通 DouBao 地址。
3. 发起手动推理，请求发送到 `/api/plan/v3/responses`。
4. 自动推理运行时，请求同样发送到 `/api/plan/v3/responses`。
5. 后端日志中的模型名称为 `deepseek-v4-pro`。
6. 正常 JSON 响应可以生成并保存信号。
7. 非法 JSON 响应可以进入二次修复。
8. 切换回 DeepSeek 或普通 DouBao 后，原有推理仍正常。
9. API Key 不出现在浏览器响应、服务器普通日志和审计日志中。

## 12. 非改动范围

本次不做以下修改：

1. 不新增数据库字段或迁移。
2. 不修改市场数据结构。
3. 不修改提示词内容和输出 Schema。
4. 不修改自动推理调度间隔。
5. 不修改订阅用户管理。
6. 不修改信号表和信号分发表。
7. 不修改订单执行与后端风控。
8. 不将普通 DouBao 接口替换为 Agent Plan。

## 13. 使用风险

上线前必须向火山方舟确认：自建 AI 交易系统通过 Agent Plan Base URL 和专属 API Key 直接调用 Responses API，是否属于允许的 Agent 工具使用范围。

如果该使用方式不在订阅授权范围内，应停止使用 Agent Plan，并改用普通火山方舟按量 API，避免订阅停用、账号限制或后续计费争议。

## 14. 最终验收标准

只有同时满足以下条件，任务才算完成：

1. 手动模型配置能选择并保存 Agent Plan。
2. 全局模型配置能选择并保存 Agent Plan。
3. 默认模型为 `deepseek-v4-pro`。
4. 默认地址为 `https://ark.cn-beijing.volces.com/api/plan/v3`。
5. Agent Plan 请求只走 `/responses`。
6. 普通供应商继续走 `/chat/completions`。
7. 思考强度正确转换为 `reasoning.effort`。
8. `max` 不会原样发送给 Agent Plan。
9. Responses API 正常响应和修复响应都能解析。
10. 自动推理与手动推理都能使用该供应商。
11. API Key 不泄露。
12. 全量自动化测试通过。
13. 人工推理测试通过。
14. 已确认 Agent Plan 的实际使用方式符合火山方舟订阅规则。
