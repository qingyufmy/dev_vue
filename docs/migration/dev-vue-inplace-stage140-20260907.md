# 阶段 140：配置管理写入HTTP合同

新增PUT /api/v4/admin/settings/value，接入API注册器的exactAdminHostHook与现有管理员写入认证适配器，使用admin-web会话及CSRF/Origin校验。应用层操作者始终来自认证结果，数据库事务再次核权。

请求只允许namespace、key、value_type、expected_revision、value，拒绝额外字段和query参数；Idempotency-Key使用小写UUID。值保持文本、版本保持十进制字符串。返回setting_id、revision、replayed及标准meta，不返回配置正文，响应Cache-Control:no-store。

输入/类型错误为400或422，版本/幂等冲突409，权限拒绝403，提交未知503且提示保留原请求编号及内容。不泄漏底层SQL异常。新增公开模块入口management.ts，未改动已有读取器及其历史证明依赖。

现有运行时逐键策略仍生效：秘密/服务字段拒绝通用更新，需要业务语义检查的地址、菜单、SMTP身份、存储等在检查缺失时拒绝。本轮不提供跳过校验的生产默认回调。

## 验证

19项测试通过：HTTP正反例4、管理事务6、返佣相邻HTTP回归5、OpenAPI请求/响应及幂等键正反例2、58步升级证明回归2。服务端类型与构建通过。

Host/认证错误覆盖使用Fastify inject与认证Mock，实际会话适配器通过生产注册接线；没有启动服务、浏览器联调或公网访问，不能宣称完整端到端安全验收。本轮没有数据库写入或旧读取切换。

后续需要管理员配置读取接口及前端合同消费者，再完成实际数据回填和业务语义验证。数据库全域规范化、完整部署自动升级和旧结构清理继续保持未完成。
