# Risk

职责：确定性风控评估、账户风险摘要、策略约束与人工解锁。risk-state定义纯状态类型；risk-action定义模块接受的动作与预期状态，不依赖AI推理实现。risk.ts负责评估，manual-risk-release负责解锁有效性，二者共享纯状态类型而不循环导入。

业务入口index只公开领域类型与应用能力；composition只供运行组装，构造MySQL服务/Worker和HTTP插件。MysqlRiskRepository读取历史AI决定时通过inference公开类型入口解释存储结构，但领域评估只消费action/actions。兼容结构可包含额外研究说明，风控不读取confidence/summary/reasoning，也不据此放宽规则。

当前登记边界债务清零不表示完整模块验收。repository仍有跨域SQL和事务协作需按表所有权继续核对，API运行校验、真实数据库权限/并发及前端完整流程另行验证。禁止绕过execution直接执行动作。

定向验证：deterministic-risk-review.test.ts、user-execution-command-service.test.ts、execution-distribution-service.test.ts、execution-distribution-worker.test.ts。类型边界调整不改变规则实现、持久化正文或哈希编码。
