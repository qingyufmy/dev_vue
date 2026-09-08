# HTTP 合同源

`domains/<domain>.json` 是业务合同的唯一编辑入口；`base.json` 仅拥有 OpenAPI 元信息、服务器和标签。`manifest.json` 显式登记全部域文件，未登记文件、缺失文件、重复域、重复路径或组件均拒绝生成。

执行 `pnpm run generate:api-contract` 生成 `contracts/openapi-v4.json`；`pnpm run verify:api-generated` 检查逐字节一致。生成时递归排序对象键、保留数组顺序，不修改引用和业务字段。聚合路径继续供现有工具与消费者读取。

| 合同域 | 所有权 |
| --- | --- |
| common | 通用标量、时间/精确数值、分页、revision、幂等、ETag和错误结构；无业务路由 |
| auth | 身份中心、应用会话、CSRF、实时票据 |
| bridge | Bridge配对、设备凭据与会话令牌 |
| trading | 账户、上下文、观摩管理、连接额度/终端档案读取、行情、宏观和经济日历 |
| execution | 执行命令、分发、operation与仓位合同 |
| inference | 分析任务、分析结果、交易员评估与决策 |
| risk | 风控规则、摘要、手工解除和决策 |
| reviews | 复盘、手工复盘候选与策略记忆 |
| strategies | 策略、版本和订阅 |
| trade-history | 终端历史、归因及详情 |
| audit | 审计查询与执行追踪 |
| learning | 课程、访问及学习完成 |
| commerce | 推荐规则；其它商业功能随全功能矩阵补齐 |
| settings | 管理设置 |

域划分对应当前服务端职责，不按 URL 前缀机械划分：例如 `/bridge/connection-capacity` 属 trading，`/trading-accounts/{account_id}/execution-commands` 属 execution。跨域复用保留明确的组件引用，不复制模型，也不把业务模型全部塞入 common。这里只确立 HTTP 合同所有权，不替代数据库表写入所有权或源码依赖验收。

拆分时聚合合同与上一版本逐字段相等；后续合同语义调整按域记录。没有删除8项尚未实现的路由。Schema可编译、生成一致、运行注册对应、生产者/消费者行为分别验证。

## 前端传输类型

运行 `pnpm run generate:api-types`，由固定版本的 openapi-typescript 从聚合产物生成 `frontend/packages/contracts/src/generated/http.ts`。文件只包含类型，不加入浏览器运行代码。`pnpm run verify:api-types` 检查聚合和类型产物均未漂移，已接入根 `typecheck:frontend`。

contracts包公开ApiWireSchemas、ApiPaths、ApiOperations供业务使用；登录请求/响应、授权参数和应用会话的现有公开类型已切换到生成来源，API客户端相应输入/输出使用这些类型。其它域的现有类型与转换仍需逐项迁移，不直接替换经过camelCase转换的页面模型。

生成类型不能表达长度、正则、日期合法性、oneOf排他性或权限；保留现有运行时校验。当前认证Zod解析结果与生成类型具备编译期双向结构检查，但这不证明两套运行时约束完全等价。客户端解析迁移及其它业务域仍待接续。

## 服务端运行校验

runtime.json显式列出已接入操作，当前为listAuditEvents/getAuditEvent。generate:api-runtime按合同提取参数、各明确状态码下的JSON/problem响应及引用模型闭包，输出server/src/transport/generated/http-contracts.ts；verify:api-runtime拒绝漂移，已接入服务端类型检查和构建。Ajv和格式库是生产依赖；部署产物不依赖仓库contracts目录。

当前适配器只支持GET的path/query及明确状态码的application/json、application/problem+json响应，其它请求体/方法/媒体类型、default状态和空响应需先扩展并验证，生成器不会猜测。路由先认证，再校验参数，再调用应用用例，最后校验DTO。整数query只接受规范非负十进制字符串并在校验副本上转换；原请求不修改，不删除字段、不填默认值。未声明query保持既有忽略语义，不能将其描述为全量未知字段拒绝。

审计分页HTTP上限调整为实际用例上限100；非法分页现在返回400而不静默截断。接口内部其它调用仍保留原有用例归一化逻辑。审计错误媒体类型对齐application/problem+json，认证错误保留401/403；非法响应以不含原始数据或Schema详情的api_response_invalid/503结束。

当前不是Fastify默认schema编译器挂载：为保留先认证顺序，路由明确调用共享校验器；检查器中“显式Fastify schema数量”不能包含这两个操作。审计错误响应也按状态码与媒体类型校验，正文status必须等于HTTP状态；非法错误替换为经过合同校验的固定503，重新生成关联ID，不递归重试或携带原始值。该行为目前只覆盖审计，写操作、其它域、错误映射统一和全量注册覆盖继续推进。
