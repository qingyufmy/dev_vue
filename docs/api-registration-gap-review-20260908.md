# API 实际注册与合同差异

本地基线：727d5541 后的 P0 实施工作区。命令 `pnpm run inspect:api-contracts` 先构建 V4 源码，再执行真实 Fastify 路由注册并捕获 onRoute，使用离线适配器，不监听端口、不连接数据库/Redis、不调用业务服务。学习、学习完成与审计模块均挂载，未用空插件替代其路由。

## 当前结果

[机器明细](migration/api-route-coverage-20260908.json)：OpenAPI 声明93个操作，业务实际注册87个，匹配85个；缺8个、未声明2个、参数名差异29个。操作ID缺失/重复及规范化路由重复均为0。注册信息中5个业务操作带schema，82个没有显式路由schema；不据此推断全部缺少业务校验。

| 差异 | 后续处置 |
| --- | --- |
| 7个宏观市场操作未注册 | market/overview、macro-snapshots列表/最新/详情、macro-series、calendar-events列表/详情；按行情模块补齐用例、适配器及读写来源后注册，不能通过空响应或删除合同消除缺口 |
| GET /api/v4/positions 未注册 | 对照仓位读取、账户/观摩作用域及消费者语义确定正式实现；不能因为已有其它持仓查询就静默忽略合同 |
| GET /api/v4/auth/session、POST /api/v4/auth/logout 未声明 | 这两项由认证中心路由注册，使用auth主体与host，不等同应用/session；应补认证中心合同和验证，不能复制应用会话schema |
| 29项参数命名差异 | URL模板形状已匹配，但如 account_id/accountId、review_case_id/caseId 不同；合同驱动校验时显式映射或统一命名并同步handler，不能只改路由占位符 |
| 82项未挂显式schema | 逐模块接入同源请求/响应schema；当前有手工输入/业务验证，本表不代表漏洞数量 |

认证协议另有6个非/api/v4前缀路由，完整列在机器明细中；当前仅列出，尚未建立正式协议例外门禁。健康端点由进程入口注册，不属于本次业务registrar范围。

## 检查器范围

双向比较method/path，保留尾斜杠和静态路径差异；参数位置匹配与名字差异分别报告；检查operationId及重复模板，支持本地path-item引用和单一server覆盖。多server、动态server和不支持的引用直接报错，不猜测实际地址。

检查失败以退出1报告，当前差异未被加入豁免。5项正反例测试覆盖缺失/未声明、参数名、ID、协议server及重复模板。server构建通过；本检查只证明注册对应关系，不证明权限、请求/响应合同等价、前端消费、数据正确性或业务完成。

下一步继续按域合同拆分和校验编译方案收口。该命令使用inspect命名，不能当作完整verify:api-contracts已经实现；全功能矩阵覆盖仍是上层验收门。
