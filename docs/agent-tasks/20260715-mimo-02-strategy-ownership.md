# Mimo Task 02：策略所有权、可见性与订阅

## 前置

- 仅在 Task 01 已审查通过后执行。
- 分支：`dev_codex`
- 必读总设计与 Mimo 实施总计划。
- 保留无关未跟踪文件。

## 目标

实现平台策略与用户私有策略的服务端所有权、可见性、模型绑定和订阅关系，不依赖前端隐藏实现权限。

## 必须实现

1. 使用下一个 migration 扩展 `auto_prompt_types`：`scope`、`owner_user_id`、`model_profile_id`、`inference_mode`、`visibility_status`、版本字段。
2. 新增 `trading_accounts` 基础身份表，保存 user、broker server、login、margin mode、审核/观察状态；Task 05 再补风险状态逻辑。
3. 新增 `strategy_subscriptions`，关联用户、交易账户、策略、可空的风控档案引用、品种、执行开关、memory mode 和挂单冲突策略；风险档案外键可在 Task 04 建表后补齐。
4. 平台策略：管理员维护，授权用户可见，使用平台模型。
5. 私有策略：创建者与管理员可见；只有创建者可在普通执行流程选择；模型必须属于创建者，或留空继承用户默认/平台自动共享兜底。
6. 管理员查看用户策略不能产生模型调用、修改、执行或额度消耗权限。
7. V1 在事务/账户锁下保证同一交易账户、同一标准品种只有一个自动执行订阅激活；不要使用会阻止多个 inactive 记录的错误唯一索引。
8. 实现列表、详情、创建、修改、软删除和订阅 API 的服务端权限。
9. 兼容现有 `auto_scheduler` 的单策略配置，暂不切换实际 scheduler；兼容期保持双写要求。
10. 增加越权、管理员只读、所有者模型校验、激活冲突和软删除测试。

## 非目标

- 不改共享信号市场数据。
- 不实现订单意图和风控。
- 不做模型页面和策略页面 UI。
- 不开始多策略同时交易。

## 验证

```powershell
npm test -- tests/ai/config.test.js tests/ai/config-entitlement.test.js tests/ai/scheduler.test.js
npm test
```

## 交付

- 结果文件：`docs/agent-results/20260715-mimo-02-strategy-ownership-result.md`
- 提交并推送 `origin/dev_codex`。
- 写明旧 `auto_scheduler` 兼容行为和下一阶段风险。
- 完成后停止。
