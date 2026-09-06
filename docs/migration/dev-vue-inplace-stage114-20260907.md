# 阶段 114：返佣管理真实并发验证与 HTTP 写入口

## 真实 MySQL 验证

在隔离参考库 dev_vue_m1_a 使用实际构建的管理仓储、版本写入器和应用规范化函数，两个独立连接执行：

- 同一请求同时提交：恰好一次应用、一次回执重放。
- 不同请求争用同一 expectedRevision：一个成功、一个版本冲突。
- 真实 commit 完成后销毁连接并抛出响应丢失：仓储返回 commit_unknown；新调用使用原请求，从审计记录恢复 revision=3，不再次更新。
- 相同请求 ID 改动内容被拒绝。

总计四条测试审计。随后仅删除指定 fixture actor/request 的四行审计，按预期 revision=3 条件恢复两条参考规则，删除测试用户；回读确认原四条规则全字段一致、审计为空、fixture 用户不存在。

[真实回执](dev-vue-referral-rule-management-probe-20260907.json)记录数据库身份、两个连接、三个构建文件 SHA-256。远端 `/www/backup/aurum-v4/m1/20260906-01/referral-rule-management-probe-01`。当前 dev_vue 未写入本次测试数据。

## 管理员 HTTP 写入口

新增 `PUT /api/v4/admin/referrals/rules`，通过 commerce 公共导出注册到现有 admin 路由分组。复用 admin-web Host-only 会话的 assertWrite（CSRF/Origin）及 exactAdminHostHook，不接受 trade-web 权限。

`Idempotency-Key` 为小写 UUID；正文只允许 changes，包含字符串 rule_id、字符串 expected_revision、整数 rate_bps 和布尔 enabled。未知字段和类型强制转换被拒绝，actor 仅来自验证后的会话。响应采用 data/meta 包装，revision 保持字符串；权限、版本和请求冲突使用稳定问题码，存储异常不泄露 SQL。提交结果未知时保留原请求编号及完整正文核对，不换新编号重试。

OpenAPI 同步声明路径、CSRF、幂等键、正文、结果和错误响应。该入口只修改规则，不能计算或发放佣金。没有改变规则停用/缺失时的返佣消费策略。

## 验证与边界

21 项 HTTP/现有管理员边界测试、5 项 OpenAPI 合同测试通过；类型检查与服务端构建通过。真实 MySQL 探针验证的是仓储事务；Fastify inject 验证 HTTP 编排与错误边界。没有启动服务器或进行真实登录/浏览器联调，不能称为运行部署验收。

当前 dev_vue 保持 203 表/53 步。管理读取/前端流程、旧写入口停用与整域切换仍待完成；不能因新写路由已注册就删除旧数据或宣告全库自动升级完成。
