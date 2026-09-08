# API 合同 Schema 编译接续

本地实现选择：当前 OpenAPI 3.1.0 的 Schema 使用 Ajv 8 的 JSON Schema 2020-12 编译器，格式由 ajv-formats 校验；两个依赖显式固定在根开发依赖。没有新增另一份手写 Schema，也没有把当前 Fastify 默认编译器当作已兼容全部 2020-12 语义。

## 已实现

`pnpm run inspect:api-schemas` 枚举 components 模型、参数、请求体、响应、响应头以及 paths/webhooks/pathItems 下的内联 Schema；解引用结构对象，拒绝远程、缺失和循环的结构引用，不访问网络。尚不支持的 callbacks 明确报错。

最新实际合同共827个 Schema 使用位置（含公共响应在不同操作中的使用），全部可编译。此前416个只计直接声明；现在额外覆盖结构引用后的使用位置。该数字不是827个独立模型或业务接口。

7项检测器行为测试验证本地引用、结构引用、错误引用、未知关键字、非法约束、null/nullable/enum、oneOf 唯一匹配、allOf 与 unevaluatedProperties、非法日期、额外字段及输入不变性。验证不转换类型、不删除额外字段、不填默认值，避免把不合法写请求静默修正为合法请求。

## 语义与后续接入

- 新合同用 `type: ["string", "null"]` 明确空值。Ajv 支持的旧 nullable 不会自动扩展 enum；枚举允许空值必须显式声明。联合类型以 oneOf/anyOf 的实际语义验收。
- discriminator 仅登记为 OpenAPI 注解，不替代 oneOf 分支校验。readOnly/writeOnly 同样不自动完成请求/响应方向裁剪；后续类型生成与传输接入必须分别验收。
- 当前是离线编译检查，尚未生成前端类型、挂载 Fastify validator/serializer，或保证实际响应符合合同。不得直接把 inspect 重命名为完整 verify:api-contracts。
- 当前服务端适配器保留已有手工业务授权和输入检查。正式接入需明确先认证与机械校验顺序、错误映射、请求头大小写、query 类型转换规则、状态码/媒体类型选择，以及响应校验失败时不泄露正文。
- 域合同拆分后保持 openapi-v4.json 为确定性聚合产物；聚合生成、消费者类型和运行时校验共同引用域源，再做生成差异检查。当前聚合文件仍为手工来源，尚未完成这一步。

本工具不做完整 OpenAPI 文档结构合法性验收，也不证明权限、幂等、分页、数据库、业务路由覆盖或浏览器流程。P0剩余事项仍以实施方案和逐批进度为准。
