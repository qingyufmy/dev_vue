# Bridge 模块

负责设备凭据、配对、会话票据、网关连接和路由租约，以及终端数据流和只读采集传输。交易决策与风险计算分别由 inference/risk 拥有；命令意图、派发状态和结果账本由 execution 拥有。

## 公开入口与依赖

`index.ts` 暴露领域合同、应用服务和业务端口。`composition.ts` 创建 MySQL/Redis 适配器及 HTTP 组装，仅供 bootstrap/entrypoints 调用；其它业务域不得通过它取得具体仓库。跨域数据写入通过注入的公开端口，禁止调用其它模块内部目录。

网关收到终端数据后交给相应投影端口，不在设备网关运行模型、风险或复盘任务。Bridge 设备路由与浏览器实时订阅是不同合同。单实例网关的定向队列约束见根目录 AGENTS.md。

## 数据与事务

MySQL 保存持久设备授权、配对和连接事实；Redis 保存短期票据和在线路由租约，不替代业务权威。数据归属和具体列以基础设施适配器及追加迁移为准。账户注册和投影由账户所属域端口处理，所有权撤销后不能继续使用旧连接权限。

会话票据、连接替换和凭据轮换保持幂等及明确失效语义。终端 I/O 不进入数据库事务。新增持久字段只能追加迁移，不能改写已执行迁移或删除历史授权证据。

## 合同与验证

HTTP 使用 `contracts/http/domains/` 登记的 Bridge 合同；设备消息使用 `contracts/` 中 V4 Bridge 合同。变更必须验证生产者、消费者、拒绝输入、连接替换、过期与权限撤销。

测试入口为 `server/tests/bridge-*.test.ts` 及相关 credential/pairing 测试。交付运行 `pnpm run verify:server-boundary-delta`、`pnpm run verify:api-contracts`、相关行为测试和服务端类型检查。离线验证不等于真实终端、正式客户端或公网运行验收。
