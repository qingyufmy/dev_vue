# Mimo Task 11：迁移、灰度、监控与最终硬化

## 前置

- Task 01–10 全部审查通过。
- 分支：`dev_codex`。

## 目标

完成兼容迁移、Schema readiness、灰度开关、监控、审计留存和全量回归，使新系统具备可部署条件。

## 必须实现

1. 审查 01–10 所有 migrations 的顺序、幂等、索引和失败行为；功能启用前增加 Schema readiness 检查。
2. 不允许关键迁移失败后新功能半启用；不得破坏当前 migration tracking。
3. 完成旧模型/策略/风控配置的数据迁移与兼容读，保留可回滚路径。
4. 验证所有旧 AI 明文 Key 已迁移到新加密 profile 后，受控清空旧字段；提供 key rotation 检查和失败回滚，不在日志打印凭据。
5. 收敛旧开仓接口和隐式模型回退，确认没有新增订单 Bridge 旁路。
6. 修正用户删除流程：账号软删除或匿名化；风险/交易审计按方案保留；密钥销毁。
7. 增加全局和用户功能开关：review generation、experience memory、memory compression、retrieval shadow、paired experiment。
8. 强制规则始终 Enforce；可调风控按规则级 Shadow→Enforce；经验先 retrieval shadow。
9. 增加指标：模型来源/错误、订单意图状态、uncertain 年龄、风控拒绝、outcome backlog、review queue、compression stale、memory tokens、平台成本。
10. 增加告警和管理员健康状态，不在日志输出秘密或复盘正文。
11. 清理兼容代码只能在证明无调用后进行；不删除历史表和原始证据。
12. 更新部署、运维、回滚、数据保留和用户说明文档。
13. 运行全量测试、关键并发测试和 `npm run dev` 启动验证。

## 非目标

- 不新增设计之外的交易策略。
- 不实现自动权重校准或自动放大仓位。
- 不合并到 main；只推送 dev_codex。

## 验证

```powershell
npm test
npm run dev
rg -n "mt5Bridge.*'(open|pending)'" server
rg -n 'mt5Bridge.*"(open|pending)"' server
```

启动验证必须记录数据库、JWT_SECRET、Redis、Bridge 是否真实可用；缺失时不得声称对应链路已验证。

## 交付

- 结果：`docs/agent-results/20260715-mimo-11-rollout-hardening-result.md`
- 提交并推送 `origin/dev_codex`。
- 结果包含完整 commit 范围、迁移清单、测试、启动日志摘要、剩余风险和生产启用顺序。
- 完成后停止，等待 Codex 最终审查。
