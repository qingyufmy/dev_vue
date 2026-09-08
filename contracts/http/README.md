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

本轮拆分保持聚合合同与上一版本逐字段相等；没有删除8项尚未实现的路由。Schema可编译、生成一致、运行注册对应、生产者/消费者行为分别验证；类型生成与Fastify运行时同源校验仍待接续。
