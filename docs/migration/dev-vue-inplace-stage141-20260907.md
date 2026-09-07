# 阶段 141：管理员配置读取HTTP

新增GET /api/v4/admin/settings/value?namespace=...&key=...，沿用管理员Host及admin-web认证适配器。仅接受两个唯一查询字段，类型由59键注册表确定；拒绝额外字段、重复参数、未知键及非管理员。

应用端口AdminSettingReader与MysqlAdminSettingReader独立于冻结的写管理实现。数据库在短事务中FOR SHARE锁定有效管理员用户行，完成实际读取后回滚只读事务并释放连接，防止读取期间角色/删除变化绕过核权。复用已验证readSetting，在SQL层遮蔽secret/credential。

响应保留真实版本、类型、敏感级别和value_state；缺失为404，NULL与空串不填默认值。protected=true时完全省略value字段，OpenAPI也禁止受保护响应夹带值；普通响应限制为非秘密、非credential类型。所有响应no-store。

## 验证

17项不同测试通过：读取HTTP/权限4、底层读取器4、相邻写HTTP4、OpenAPI正反例3、升级证明回归2。服务端类型及构建通过。测试覆盖查询严格性、秘密响应、NULL/空串、精确版本，以及数据库核权先于读取。

本轮没有数据库写入、服务启动或浏览器联调。HTTP认证测试使用Mock，当前读取器的真实SQL遮蔽证明来自阶段133，但新增管理员共享锁事务尚未做真实MySQL演练。不能据此宣称完整会话端到端验收。

下一步验证新增管理员读取事务，再对接前端合同消费者。配置真实数据回填、业务语义检查及旧入口退出仍待完成，完整数据库规范化与自动升级目标继续保持未完成。
